import { generateText, stepCountIs } from "ai";
import type { ModelMessage } from "ai";

import { getDb } from "@/lib/db";
import { familyMembers, messageLog } from "@/lib/db/schema";
import { checkConflicts } from "@/lib/google/conflicts";
import { formatNowForPrompt, getFamilyTimeZone } from "@/lib/google/time";
import type { LuthEvent } from "@/lib/google/types";
import type { RosterMember } from "./match-member";
import { buildAgentTools, type AgentSource } from "./tools";

// Model is addressed via a Vercel AI Gateway string, resolved by the
// AI SDK's built-in global provider (no explicit `gateway(...)` import
// needed — see node_modules/ai/docs/.../ai-gateway reference). Reading this
// as a plain string constant (not from env) keeps model selection a code
// change, per the task brief; AI_GATEWAY_API_KEY / Vercel OIDC supplies auth.
const MODEL = "anthropic/claude-sonnet-5";

// A single conversational turn is: parse -> maybe list/create/update/delete
// -> checkConflicts -> reply. 8 steps gives headroom for a multi-part
// request (e.g. "move Maya's dentist AND add a haircut for Kai") without
// letting a confused model loop indefinitely.
const MAX_STEPS = 8;

export interface RunAgentMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AgentAction {
  tool: string;
  input: unknown;
  output: unknown;
}

export interface RunAgentParams {
  messages: RunAgentMessage[];
  source: AgentSource;
  /** iMessage group chat GUID this run is attached to (source "imessage"). Used for logging and as the sendGroupMessage destination. */
  chatGuid?: string;
  /** The iMessage handle (phone/email) that sent the inbound text, for message_log. */
  senderHandle?: string;
}

export interface RunAgentResult {
  reply: string;
  actions: AgentAction[];
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

async function getFamilyRoster(): Promise<RosterMember[]> {
  try {
    const db = getDb();
    return await db.select({ id: familyMembers.id, name: familyMembers.name, aliases: familyMembers.aliases }).from(familyMembers);
  } catch (err) {
    // No DB configured, or a transient failure — degrade to an empty roster
    // rather than failing the whole request. The agent's instructions tell
    // it to ask who an event is for when the roster is empty/unhelpful.
    console.error("[lib/agent] failed to load family roster (continuing without it)", err);
    return [];
  }
}

function formatRoster(roster: RosterMember[]): string {
  if (roster.length === 0) {
    return "(No family roster configured yet — ask who an event is for rather than guessing an id.)";
  }
  return roster
    .map((m) => `- ${m.name} (id: ${m.id})${m.aliases.length > 0 ? `, aka: ${m.aliases.join(", ")}` : ""}`)
    .join("\n");
}

function buildSystemPrompt(source: AgentSource, roster: RosterMember[]): string {
  const tz = getFamilyTimeZone();

  return `You are LuthCal, the scheduling assistant for the Luthra family. You normally live in their iMessage group chat${
    source === "dashboard" ? ", but this particular message came from the family's web dashboard, not the group chat" : ""
  } and turn plain-language messages into events on their shared Google Calendar.

Current date/time: ${formatNowForPrompt(tz)} (${tz}). Resolve all relative dates ("tomorrow", "next Friday", "in two weeks") against this.

Family roster:
${formatRoster(roster)}

How to operate:
1. Parse who the event is for, what it is, and when. When calling createEvent/updateEvent, pass memberNames as the name/alias text you read in the conversation (e.g. "Maya", "mom") — do NOT resolve those names to ids yourself; that's done deterministically, outside your control, against the roster above. The read-only tools are the one exception: checkConflicts and listEvents take member *ids*, not names — use the \`id:\` values shown in the roster above for those.
2. If createEvent/updateEvent returns an ambiguousMember result instead of a created/updated event, the name you gave matched more than one family member (listed in candidates). Do not retry with a guess — ask the user which person they meant, then call the tool again once they've told you. If instead it returns unresolvedMemberNames alongside a created/updated event, those names matched nobody on the roster and were left off the event — briefly note that in your reply (e.g. "I didn't recognize 'Emma' as a family member, so I didn't tag anyone") so a typo or a missing roster entry gets caught, but don't block on it.
3. If the family member or the time is genuinely ambiguous in the conversation itself (e.g. a date phrase has two reasonable readings), ask a short clarifying question instead of guessing. Don't ask about things that are reasonably inferable — pick something sensible for an unstated detail (like a default evening time for "dinner") and say what you picked.
4. After creating or moving an event that has assigned family members, always call checkConflicts for that event's members and time range, and mention any conflicts in your reply, prefixed with a warning emoji (⚠️).
5. Use listEvents to find an event's googleEventId (e.g. from context earlier in the conversation, or by asking what it's called and searching a reasonable window) before calling updateEvent or deleteEvent.
6. Keep replies short and warm — they're going into a family group text, not a confirmation email. One or two sentences is usually enough.
7. Only use sendGroupMessage for a message beyond your normal reply — your normal reply already reaches the chat, so don't send it twice.`;
}

// ---------------------------------------------------------------------------
// message_log
// ---------------------------------------------------------------------------

async function logMessage(
  direction: "inbound" | "outbound",
  opts: { chatGuid?: string; senderHandle?: string; text: string },
): Promise<void> {
  try {
    const db = getDb();
    await db.insert(messageLog).values({
      direction,
      chatGuid: opts.chatGuid,
      senderHandle: opts.senderHandle,
      text: opts.text,
    });
  } catch (err) {
    console.error("[lib/agent] failed to write message_log (continuing)", err);
  }
}

// ---------------------------------------------------------------------------
// Tool-call bookkeeping
// ---------------------------------------------------------------------------

function extractActions(steps: ReadonlyArray<{
  toolCalls: ReadonlyArray<{ toolCallId: string; toolName: string; input: unknown }>;
  toolResults: ReadonlyArray<{ toolCallId: string; output: unknown }>;
}>): AgentAction[] {
  const actions: AgentAction[] = [];
  for (const step of steps) {
    for (const call of step.toolCalls) {
      const result = step.toolResults.find((r) => r.toolCallId === call.toolCallId);
      actions.push({ tool: call.toolName, input: call.input, output: result?.output });
    }
  }
  return actions;
}

/**
 * Deterministic safety net for the "always check conflicts" rule in the
 * system prompt above. Prompt-following is not guaranteed, and a missed
 * conflict means a double-booking a family didn't find out about until two
 * people showed up to the same time slot — worth a cheap, redundant,
 * read-only re-check server-side rather than trusting the model every time.
 *
 * Runs checkConflicts again for every createEvent/updateEvent this turn made
 * (idempotent, side-effect-free) and returns warning strings to append,
 * skipped only if the reply already contains a ⚠️ (best-effort heuristic for
 * "the model already surfaced this" — see docs/agent-core.md for the
 * known limitation of that heuristic).
 */
async function surfaceConflictWarnings(actions: AgentAction[]): Promise<string[]> {
  const warnings: string[] = [];
  for (const action of actions) {
    if (action.tool !== "createEvent" && action.tool !== "updateEvent") continue;
    const event = (action.output as { event?: LuthEvent } | undefined)?.event;
    if (!event || event.memberIds.length === 0) continue;

    const conflicts = await checkConflicts({
      startISO: event.start,
      endISO: event.end,
      memberIds: event.memberIds,
      allDay: event.allDay,
      excludeGoogleEventId: event.id,
    });
    if (conflicts.length > 0) {
      const names = conflicts.map((c) => `"${c.event.title}"`).join(", ");
      warnings.push(`⚠️ "${event.title}" overlaps with ${names}.`);
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runAgent({ messages, source, chatGuid, senderHandle }: RunAgentParams): Promise<RunAgentResult> {
  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
  if (lastUserMessage) {
    await logMessage("inbound", { chatGuid, senderHandle, text: lastUserMessage.content });
  }

  // Fetched once and reused for both the prompt and the tools, so
  // createEvent/updateEvent's memberNames resolution (see
  // lib/agent/tools.ts resolveMemberNames) is guaranteed to run against the
  // exact same roster snapshot the model was shown, not a second query that
  // could race a concurrent roster edit.
  const roster = await getFamilyRoster();
  const system = buildSystemPrompt(source, roster);
  const tools = buildAgentTools({ source, chatGuid, roster });

  const modelMessages: ModelMessage[] = messages.map((m): ModelMessage =>
    m.role === "user" ? { role: "user", content: m.content } : { role: "assistant", content: m.content },
  );

  const result = await generateText({
    model: MODEL,
    system,
    messages: modelMessages,
    tools,
    stopWhen: stepCountIs(MAX_STEPS),
  });

  const actions = extractActions(result.steps);
  const warnings = await surfaceConflictWarnings(actions);
  const reply = warnings.length > 0 && !result.text.includes("⚠️") ? `${result.text}\n\n${warnings.join("\n")}`.trim() : result.text;

  await logMessage("outbound", { chatGuid, text: reply });

  return { reply, actions };
}
