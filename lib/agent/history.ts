import { and, desc, eq, gte, or } from "drizzle-orm";
import type { ModelMessage } from "ai";

import { getDb } from "@/lib/db";
import { messageLog } from "@/lib/db/schema";
import type { RosterMember } from "./match-member";
import type { AgentSource } from "./tools";

/**
 * Shared conversation memory across channels (see docs/superpowers/specs/
 * 2026-09-07-shared-memory-design.md §1 for the full design writeup). One
 * family thread — the dashboard chat and the iMessage group chat are no
 * longer separate histories — so a conversation started on one channel is
 * visible on the other.
 *
 * Level-1 (recent conversational turns) only — explicitly NOT long-term fact
 * memory, which lives in ./memory.ts (§2 of the same spec).
 */

/** Last N message_log rows for the family thread — bounds prompt size against a long back-and-forth. */
export const HISTORY_MESSAGE_LIMIT = 30;
/** Rows older than this are never pulled back in, regardless of count — bounds prompt size against staleness. */
export const HISTORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface CallerMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * One loaded message_log row, before formatting. Kept as raw metadata
 * (rather than a ModelMessage) so `dedupeHistory` can dedup on raw `text`
 * before `formatHistory` applies any sender-name prefix — see this module's
 * doc comment and the spec's §1 "dedup-before-prefix" note.
 */
export interface ThreadHistoryRow {
  direction: "inbound" | "outbound";
  text: string;
  /** Resolved sender label (roster name, falling back to the raw handle) — inbound rows only. */
  senderLabel?: string;
  /** The channel this row actually came from — drives formatHistory's cross-channel "(via X)" tag. */
  source: "imessage" | "dashboard" | null;
}

function directionToRole(direction: "inbound" | "outbound"): "user" | "assistant" {
  return direction === "outbound" ? "assistant" : "user";
}

/**
 * The canonical family thread, independent of any one run's channel/chatGuid:
 * dashboard rows are always in scope; iMessage rows are in scope for
 * `FAMILY_CHAT_GUID` (dashboard-only scope if that's unset — there's then no
 * known family chat to fold in). This is what a dashboard run's own scope
 * reduces to below, and it's also what `lib/agent/memory.ts`'s
 * `searchHistory` uses — recall isn't tied to which channel asked for it.
 */
export function familyThreadCondition() {
  const familyChatGuid = process.env.FAMILY_CHAT_GUID;
  if (!familyChatGuid) return eq(messageLog.source, "dashboard");
  return or(eq(messageLog.source, "dashboard"), and(eq(messageLog.source, "imessage"), eq(messageLog.chatGuid, familyChatGuid)));
}

/**
 * The family-thread scope condition for one run: dashboard rows are always
 * in scope; iMessage rows are in scope for the run's own family chat — its
 * own `chatGuid` for an iMessage run, `familyThreadCondition()`'s
 * `FAMILY_CHAT_GUID`-based scope for a dashboard run. Rows with
 * `source IS NULL` (written before the column existed) match neither
 * branch, so they're simply never pulled back in.
 */
function buildFamilyThreadCondition(source: AgentSource, chatGuid: string | undefined) {
  if (source === "imessage") {
    const imessageCondition = chatGuid
      ? and(eq(messageLog.source, "imessage"), eq(messageLog.chatGuid, chatGuid))
      : eq(messageLog.source, "imessage");
    return or(eq(messageLog.source, "dashboard"), imessageCondition);
  }
  return familyThreadCondition();
}

/**
 * Loads recent history for the family thread (see this module's doc comment
 * for scope). Returns raw rows with metadata, oldest-first — callers run
 * `dedupeHistory` then `formatHistory` to get `ModelMessage[]`.
 *
 * **Attribution:** every inbound row's `senderLabel` is resolved (roster
 * name via `memberId`, falling back to the raw `senderHandle`) regardless of
 * channel — unlike the old per-channel design, dashboard rows are no longer
 * left unprefixed, since dedup now happens on raw text (before formatting),
 * so uniform prefixing can't break it.
 *
 * Degrades to `[]` (never throws) if `getDb()`/`DATABASE_URL` is
 * unavailable — mirrors `lib/agent/index.ts`'s `getFamilyRoster`, so
 * `next build` and any DB-less environment keep working.
 */
export async function loadRecentThreadHistory(
  source: AgentSource,
  chatGuid: string | undefined,
  roster: RosterMember[],
): Promise<ThreadHistoryRow[]> {
  try {
    const db = getDb();
    const threadCondition = buildFamilyThreadCondition(source, chatGuid);
    const cutoff = new Date(Date.now() - HISTORY_MAX_AGE_MS);

    const rows = await db
      .select({
        direction: messageLog.direction,
        text: messageLog.text,
        senderHandle: messageLog.senderHandle,
        memberId: messageLog.memberId,
        source: messageLog.source,
      })
      .from(messageLog)
      .where(and(threadCondition, gte(messageLog.createdAt, cutoff)))
      .orderBy(desc(messageLog.createdAt))
      .limit(HISTORY_MESSAGE_LIMIT);

    const nameById = new Map(roster.map((m) => [m.id, m.name]));

    return rows
      .reverse() // DB order is newest-first (for the LIMIT); conversation order is oldest-first.
      .map((row): ThreadHistoryRow => {
        if (row.direction === "outbound") return { direction: "outbound", text: row.text, source: row.source };
        const senderLabel = (row.memberId && nameById.get(row.memberId)) || row.senderHandle || undefined;
        return { direction: "inbound", text: row.text, senderLabel, source: row.source };
      });
  } catch (err) {
    console.error("[lib/agent] failed to load conversation history (continuing without it)", err);
    return [];
  }
}

/**
 * Loads the single most recent OUTBOUND (assistant-sent) message in one
 * iMessage group chat — the minimal DB-backed input the passive-listener
 * engagement gate (`lib/agent/engagement.ts`) needs for its
 * "pending-confirmation" check: was the agent's last message in this thread
 * a suggestion/question the current inbound message might be replying to?
 *
 * Deliberately narrower than `loadRecentThreadHistory` above (a single row,
 * no roster/attribution, no dashboard scope) — the engagement gate only
 * ever needs to know about the ONE most recent thing the agent itself said
 * in an iMessage thread, with its timestamp, to bound how "pending" a
 * suggestion still is. Unaffected by the family-thread scope change above.
 */
export async function loadLastOutboundMessage(chatGuid: string): Promise<{ text: string; createdAt: Date } | null> {
  try {
    const db = getDb();
    const rows = await db
      .select({ text: messageLog.text, createdAt: messageLog.createdAt })
      .from(messageLog)
      .where(and(eq(messageLog.source, "imessage"), eq(messageLog.chatGuid, chatGuid), eq(messageLog.direction, "outbound")))
      .orderBy(desc(messageLog.createdAt))
      .limit(1);
    return rows[0] ?? null;
  } catch (err) {
    console.error("[lib/agent] failed to load last outbound message (continuing without it)", err);
    return null;
  }
}

/**
 * Drops any loaded-history row whose (direction-as-role, RAW text) already
 * appears verbatim in `callerMessages` — otherwise the dashboard's resent
 * history (mid-session; see app/api/chat/route.ts) would be doubled up with
 * the same turns pulled back from message_log. Runs on raw text, before
 * `formatHistory` applies any sender-name prefix — see this module's doc
 * comment.
 *
 * Exact-string dedup, not fuzzy: a false-negative (an occasional literal
 * repeat like "yes" surviving in both places) just costs a few duplicate
 * prompt tokens, which is a far smaller risk than a false-positive dropping
 * a real, distinct turn because its text happened to match something else.
 */
export function dedupeHistory(rows: ThreadHistoryRow[], callerMessages: CallerMessage[]): ThreadHistoryRow[] {
  const seen = new Set(callerMessages.map((m) => `${m.role} ${m.content}`));
  return rows.filter((row) => !seen.has(`${directionToRole(row.direction)} ${row.text}`));
}

/**
 * Formats deduped `ThreadHistoryRow`s into `ModelMessage[]` for the current
 * run. Every inbound row is prefixed with its `senderLabel` (when resolved);
 * a row whose `source` differs from `currentSource` additionally carries a
 * cross-channel tag — `"Vijay (via iMessage): …"` in a dashboard run,
 * `"Aman (via dashboard): …"` in an iMessage run — so the model can tell a
 * same-channel turn from one that happened on the other channel. Outbound
 * rows are always plain `assistant` messages, untagged.
 */
export function formatHistory(rows: ThreadHistoryRow[], currentSource: AgentSource): ModelMessage[] {
  return rows.map((row): ModelMessage => {
    if (row.direction === "outbound") return { role: "assistant", content: row.text };
    const crossChannelTag = row.source && row.source !== currentSource ? ` (via ${row.source === "imessage" ? "iMessage" : "dashboard"})` : "";
    const prefix = row.senderLabel ? `${row.senderLabel}${crossChannelTag}: ` : "";
    return { role: "user", content: `${prefix}${row.text}` };
  });
}
