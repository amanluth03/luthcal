/**
 * Passive-listener decision gate for the family iMessage group chat.
 *
 * Today (pre-this-change) every inbound message reaches `runAgent` — fine
 * for the dashboard (a direct, explicit request every time) but wrong for a
 * group chat, where the agent should be a PASSIVE LISTENER: engaging on
 * every ambient message is the #1 thing that kills a group-chat bot. This
 * module is the gate the BlueBubbles webhook (backend-dev's file) is meant
 * to call BEFORE deciding whether to invoke `runAgent` at all.
 *
 * See docs/agent-core.md's passive-listener section for the full design
 * writeup (triggers, precision-over-recall stance, suggest-vs-act contract,
 * fail-silent behavior, the pending-confirmation extension, and the exact
 * webhook hand-off spec) — this file's doc comments summarize the "what",
 * that doc covers the "why" and the open questions flagged for tech-lead.
 *
 * **Design stance, restated here because it drives every decision below:
 * HIGH PRECISION OVER RECALL.** A false "want me to add this?" on ordinary
 * chatter is far worse than missing a real one — when unsure, this module
 * resolves to silent. Every fallible path (the classifier failing, an
 * ambiguous signal) fails toward silence, never toward engaging.
 */

import { generateText, Output } from "ai";
import { z } from "zod";

import { CLASSIFIER_MODEL } from "./model";
import { isAgentSilent } from "./silent";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Why the gate decided to engage (or not). `"pending-confirmation"` is an
 * extension beyond the two triggers in the original brief (mention,
 * event-with-time) — see this file's `isPendingConfirmationReply` doc
 * comment for why it's necessary, and docs/agent-core.md for the explicit
 * tech-lead flag on this design call.
 */
export type EngagementReason = "mentioned" | "event-detected" | "pending-confirmation" | "none";

/**
 * How `runAgent` should behave for this turn if the gate engages.
 * `"silent"` only ever pairs with `engage: false` — it exists as a mode
 * value (rather than `mode` being omitted when not engaging) so the whole
 * decision reads as one coherent object.
 *
 * - `"act"` — full tool access, normal ask-when-ambiguous policy. Used both
 *   for an explicit mention (the family directly addressed the agent) and
 *   for a pending-confirmation reply (a follow-up to something the agent
 *   itself just asked).
 * - `"suggest"` — passive event-detection only. `runAgent` must NOT create
 *   anything this turn — see `lib/agent/index.ts` RunAgentParams.engagementMode
 *   and `lib/agent/tools.ts` AgentToolContext.mode for how that's enforced
 *   deterministically (the mutating tools are removed from the tool set,
 *   not just discouraged by the prompt).
 */
export type EngagementMode = "act" | "suggest" | "silent";

export interface EngagementDecision {
  engage: boolean;
  reason: EngagementReason;
  mode: EngagementMode;
}

/**
 * The single most recent message the AGENT ITSELF sent in this iMessage
 * thread, if any — used only for the pending-confirmation check below.
 * `sentAt` is the wall-clock time it was sent (message_log.created_at).
 * Fetch this via `lib/agent/history.ts`'s `loadLastOutboundMessage(chatGuid)`
 * — see that function's doc comment for why it's a separate, narrower
 * helper than the full `loadRecentThreadHistory`.
 */
export interface LastAgentMessage {
  text: string;
  sentAt: Date;
}

export interface DecideEngagementOptions {
  /** The inbound message text, as received (not pre-trimmed is fine — isMentioned/the classifier both tolerate it). */
  text: string;
  /**
   * Agent names/aliases to match for explicit-mention detection. Optional —
   * defaults to `getDefaultAgentNames()` (env-configurable, see below).
   * Exposed as a param mainly so tests don't have to depend on env vars;
   * production callers should normally omit this and take the default.
   */
  agentNames?: string[];
  /**
   * The agent's own most recent message in this thread, if any — powers the
   * pending-confirmation check. Omit (or pass `undefined`) if there isn't
   * one (e.g. first message ever in the thread) or the caller doesn't have
   * it handy; the gate simply skips that check in that case, same as any
   * other "no signal" case.
   */
  lastAgentMessage?: LastAgentMessage;
}

// ---------------------------------------------------------------------------
// Trigger (a): explicit mention / direct address
// ---------------------------------------------------------------------------

/**
 * Default agent names/aliases matched for explicit-mention detection.
 *
 * **tech-lead ruling (NLU owner): `"calendar"` is deliberately NOT a default
 * mention word.** A mention resolves to `mode: "act"` — full mutating-tool
 * access (createEvent/updateEvent/deleteEvent) — which is the single
 * highest-stakes path in this gate, and `"calendar"` is a maximally common
 * word in *this exact domain* ("did you see the calendar?", "check the
 * calendar", "my calendar's a mess this week", "is it on the calendar?").
 * Defaulting it would engage the agent in act mode on ordinary chatter that
 * merely talks *about* the calendar rather than addressing the agent — the
 * precise "don't be annoying" failure this whole gate exists to prevent, and
 * the one senior-backend flagged. Dropping it costs nothing: the family
 * addresses the bot as "LuthCal", and any deployment that genuinely wants
 * "calendar" (or a nickname) as an address word can add it via `AGENT_NAMES`.
 * Messages that only *mention* the calendar now fall through to the
 * precision-biased event classifier instead, which correctly stays silent on
 * them. See docs/agent-core.md §9.
 */
export const DEFAULT_AGENT_NAMES = ["LuthCal"];

/**
 * Builds the full name/alias list for mention detection: `AGENT_NAMES` env
 * (comma-separated) if set, else `DEFAULT_AGENT_NAMES` — plus
 * `AGENT_IMESSAGE_HANDLE` (the agent's own dedicated Apple ID/phone; already
 * used elsewhere as the loop-guard in app/api/webhooks/bluebubbles/route.ts)
 * appended when set, so directly addressing the agent by its own handle
 * ("hey +1555..., add...") also counts as a mention. Reusing that env var
 * for a second purpose mirrors resolve-sender.ts's reuse of imessageHandle
 * — one "how do people refer to X" concept, not a new var per use.
 */
export function getDefaultAgentNames(): string[] {
  const fromEnv = process.env.AGENT_NAMES?.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const names = fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_AGENT_NAMES;
  const handle = process.env.AGENT_IMESSAGE_HANDLE?.trim();
  return handle ? [...names, handle] : names;
}

function normalizeForMentionMatch(s: string): string {
  // Lower-case; strip everything except letters, digits, whitespace, and
  // "+" (so a phone-number handle like "+15555550123" survives intact).
  // Punctuation ("@LuthCal", "LuthCal!", "hey, calendar?") is stripped
  // rather than tokenized specially — after stripping, "@LuthCal" and
  // "LuthCal" normalize identically, which is exactly the punctuation/case
  // robustness the brief asks for.
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s+]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True if `text` explicitly addresses/mentions the agent by any of
 * `agentNames`. Word/phrase-boundary matching on the normalized
 * (lower-cased, punctuation-stripped) text — NOT substring matching, so a
 * short alias like "cal" (hypothetically) wouldn't match inside "recall".
 * A multi-word alias ("hey calendar") is matched as a contiguous phrase.
 * Deliberately not fuzzy, same reasoning as `matchMember`'s no-fuzzy rule
 * (lib/agent/match-member.ts) — exact, predictable matching over maximally
 * permissive.
 */
export function isMentioned(text: string, agentNames: string[]): boolean {
  const normalizedText = normalizeForMentionMatch(text);
  if (!normalizedText) return false;

  return agentNames.some((name) => {
    const normalizedName = normalizeForMentionMatch(name);
    if (!normalizedName) return false;
    const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(normalizedName)}(?:$|\\s)`);
    return pattern.test(normalizedText);
  });
}

// ---------------------------------------------------------------------------
// Pending-confirmation reply (extension beyond the original two triggers)
// ---------------------------------------------------------------------------

/**
 * How long a suggestion/question from the agent stays "pending" — a reply
 * within this window of the agent's own last message counts as a possible
 * confirmation; older than this, it doesn't. Bounds the risk described in
 * this function's doc comment below (an unrelated later message wrongly
 * read as replying to a stale suggestion). 15 minutes is a deliberately
 * short, conservative window matching realistic "someone answers a direct
 * question in a group chat" cadence — not the 24h/20-message window
 * `lib/agent/history.ts` uses for general conversation memory, which is a
 * different, looser concern.
 */
export const PENDING_CONFIRMATION_WINDOW_MS = 15 * 60 * 1000;

/**
 * **Why this exists (an extension beyond the brief's literal two triggers):**
 * "suggest" mode only works end-to-end if a reply to the agent's own
 * suggestion can reach it. Consider: agent asks "Want me to add Maya's
 * dentist for Tue 3pm?"; the family replies "yes". That reply is, on its
 * own, ordinary ambient chatter — no explicit mention, no date/time — so
 * without this check the gate would stay silent and the confirmation would
 * never reach `runAgent`, making "suggest mode" a dead end. This function
 * closes that gap deterministically (no extra classifier call): if the
 * agent's own last message in this thread was phrased as a question, ended
 * recently, treat the current reply as a candidate response to it and let
 * `runAgent` (which has the full conversation history — see BUG 2 in
 * docs/agent-core.md) work out from context whether it's actually a "yes",
 * a "no", a correction, or something else.
 *
 * **Precision trade-off, explicitly:** this does NOT check that the reply
 * is actually about the suggestion — only that the agent's last message
 * ended in "?" and was recent. An unrelated message sent shortly after an
 * ignored suggestion (nobody else spoke in between) would still trigger
 * engagement here. The `PENDING_CONFIRMATION_WINDOW_MS` bound above is the
 * main mitigation (a short window makes "unrelated reply that happens to
 * land in the window" much less likely than "the actual reply to a
 * question someone just asked"); the rest is left to `runAgent`'s own
 * judgment once engaged, same as any other conversational ambiguity it
 * already has to handle. Flagged for tech-lead in docs/agent-core.md as a
 * deliberate scope expansion of the brief's literal `reason` union, not a
 * silent one.
 */
function isPendingConfirmationReply(lastAgentMessage: LastAgentMessage | undefined): boolean {
  if (!lastAgentMessage) return false;
  const ageMs = Date.now() - lastAgentMessage.sentAt.getTime();
  if (ageMs < 0 || ageMs > PENDING_CONFIRMATION_WINDOW_MS) return false;
  return lastAgentMessage.text.trim().endsWith("?");
}

// ---------------------------------------------------------------------------
// Trigger (b): event-with-time detection — small, cheap classifier call
// ---------------------------------------------------------------------------

/**
 * The passive event-with-time classifier uses `CLASSIFIER_MODEL` from
 * ./model.ts — deliberately DIFFERENT from (and much cheaper/faster than)
 * the full tool-loop agent's `AGENT_MODEL` (Claude Sonnet 5).
 *
 * **Why a separate, cheaper model — cost/latency reasoning:** every message
 * in the family group chat that isn't an explicit mention has to be
 * classified, so this call runs far more often than the full agent (which
 * only ever runs on messages the gate has already decided to engage with).
 * Running the full Sonnet-5 tool-loop agent (roster + policy system prompt,
 * up to 8 tool-call steps, live Google Calendar reads) on every single
 * ambient message would be both needlessly expensive and slow for a task
 * that's just "strict binary classification of one short message" — no
 * roster, no tools, no multi-step reasoning needed. `claude-haiku-4-5` is
 * Anthropic's fastest/cheapest current tier ($1/$5 per MTok vs Sonnet 5's
 * $3/$15, i.e. roughly a third of the per-token cost) and is more than
 * capable of a strict yes/no read on "does this message name a concrete
 * date/time for an event" — this is exactly the kind of narrow,
 * well-specified task a small model is a good fit for. `maxOutputTokens` is
 * capped low (the only output is one small JSON boolean) to bound cost and
 * latency further per call.
 */
const CLASSIFIER_MAX_OUTPUT_TOKENS = 300;

const CLASSIFIER_SYSTEM_PROMPT = `You are a fast pre-filter for a family calendar assistant that passively monitors a family group chat. You will be given a single message from that chat. Decide whether it CLEARLY AND UNAMBIGUOUSLY describes a specific, schedulable calendar event that includes an explicit date or time — a day of the week, a calendar date, "tomorrow", "tonight", "next Friday", a clock time, etc.

Answer true ONLY when the message reads as someone STATING, ANNOUNCING, or REQUESTING a NEW future event to put on the calendar AND naming a concrete day or time for it (e.g. "Maya has a dentist appt Tuesday at 3", "soccer practice moved to Thursday 5pm", "add Kai's recital next Friday 7pm"). When you are not highly confident, answer false.

Answer false for:
- vague or hypothetical plans with no specific day/time ("we should do dinner sometime", "let's hang out this weekend" with no day named)
- questions, greetings, opinions, or general chatter — even if a time is mentioned in passing ("what's for dinner tonight?", "anyone free later?", "is 7 too late?")
- events that have ALREADY happened / past-tense recollections, even with a clear time ("the movie was at 7 and it was great", "we met at noon yesterday")
- logistics/status/discussion about an event that doesn't itself state a new date/time ("running late", "on my way", "someone grab milk", "did you see the calendar?")
- anything you are not highly confident is a concrete new event with a specific time

When in doubt, answer false. A missed real event is far cheaper than a false positive here — a false positive makes the assistant interrupt ordinary family conversation, which is the worst outcome.`;

const eventClassificationSchema = z.object({
  isSchedulableEventWithTime: z
    .boolean()
    .describe(
      "True only if the message clearly and unambiguously describes a specific, schedulable event with an explicit date or time. False otherwise, including when unsure.",
    ),
});

async function classifyEventWithTime(text: string): Promise<boolean> {
  const result = await generateText({
    model: CLASSIFIER_MODEL,
    system: CLASSIFIER_SYSTEM_PROMPT,
    prompt: text,
    maxOutputTokens: CLASSIFIER_MAX_OUTPUT_TOKENS,
    output: Output.object({ schema: eventClassificationSchema }),
  });
  return result.output.isSchedulableEventWithTime;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Decides whether the passive-listener agent should engage with an inbound
 * group-chat message, and if so, how (`"act"` vs `"suggest"`). Checked in
 * order, cheapest/most-deterministic first — each earlier check that fires
 * skips every check after it, including the model call, which is the whole
 * point of putting the expensive classifier last:
 *
 * 1. **Explicit mention** (`isMentioned`, deterministic) → `{ engage: true,
 *    reason: "mentioned", mode: "act" }`. No model call at all.
 * 2. **Pending-confirmation reply** (`isPendingConfirmationReply`,
 *    deterministic) → `{ engage: true, reason: "pending-confirmation",
 *    mode: "act" }`. Still no model call.
 * 3. **Event-with-time classifier** (the one model call this function ever
 *    makes) → `true` gives `{ engage: true, reason: "event-detected", mode:
 *    "suggest" }`; `false` gives `{ engage: false, reason: "none", mode:
 *    "silent" }`.
 *
 * **Fail-safe:** if the classifier call throws (network error, rate limit,
 * malformed response, anything) this function catches it and returns
 * `{ engage: false, reason: "none", mode: "silent" }` — never lets a
 * classifier failure default to engaging. Per the module's precision-over-
 * recall stance: an occasional missed real event (silently, because the
 * classifier happened to be down) is a far smaller cost than the agent
 * ever popping up in the group chat because of an infrastructure failure
 * rather than an actual signal in the message.
 *
 * **Never nags:** this function is purely reactive — it only ever runs in
 * response to an inbound message, and never produces its own follow-up
 * message. If a suggestion is ignored (no reply, or a reply outside the
 * `PENDING_CONFIRMATION_WINDOW_MS` window), nothing here re-raises it.
 */
export async function decideEngagement({ text, agentNames, lastAgentMessage }: DecideEngagementOptions): Promise<EngagementDecision> {
  if (isMentioned(text, agentNames ?? getDefaultAgentNames())) {
    return { engage: true, reason: "mentioned", mode: "act" };
  }

  // Silent mode (./silent.ts): the agent can't ask "want me to add that?"
  // or answer a reply to a question it never sent, so only an explicit
  // mention engages — no pending-confirmation check, no classifier call.
  if (isAgentSilent()) {
    return { engage: false, reason: "none", mode: "silent" };
  }

  if (isPendingConfirmationReply(lastAgentMessage)) {
    return { engage: true, reason: "pending-confirmation", mode: "act" };
  }

  let hasEventWithTime: boolean;
  try {
    hasEventWithTime = await classifyEventWithTime(text);
  } catch (err) {
    console.error("[lib/agent/engagement] event classifier call failed; defaulting to silent (fail-safe, per precision-over-recall stance)", err);
    return { engage: false, reason: "none", mode: "silent" };
  }

  if (hasEventWithTime) {
    return { engage: true, reason: "event-detected", mode: "suggest" };
  }

  return { engage: false, reason: "none", mode: "silent" };
}
