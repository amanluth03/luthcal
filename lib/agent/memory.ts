import { and, desc, eq, gte, ilike, isNull } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";

import { getDb } from "@/lib/db";
import { familyMemory, messageLog } from "@/lib/db/schema";
import { familyThreadCondition } from "./history";
import { getFamilyTimeZone } from "@/lib/google/time";
import type { RosterMember } from "./match-member";
import type { AgentSource } from "./tools";

/**
 * Durable memory across sessions (docs/superpowers/specs/2026-09-07-shared-
 * memory-design.md §2) — the family's "remembered facts" store, separate
 * from lib/agent/history.ts's recent-conversation-turns memory. Backed by
 * `lib/db/schema.ts`'s `family_memory` table.
 *
 * Every DB-backed function here degrades gracefully (empty array / no-op,
 * logging the error) when `getDb()`/`DATABASE_URL` is unavailable — same
 * pattern as `lib/agent/index.ts`'s `getFamilyRoster`.
 */

/** Active memories fetched at once — bounds prompt size; a family's durable facts don't need more than this. */
export const MEMORY_LIMIT = 100;
/** Rows returned by one searchHistory call. */
export const SEARCH_HISTORY_LIMIT = 20;
/** Default lookback window for searchHistory when the caller doesn't specify one. */
export const SEARCH_HISTORY_DEFAULT_SINCE_DAYS = 90;

export type MemoryKind = "preference" | "pattern" | "fact" | "decision";

export interface MemoryRow {
  id: string;
  content: string;
  kind: MemoryKind;
  memberId: string | null;
  createdByMemberId: string | null;
  source: AgentSource | null;
  createdAt: Date;
}

const memoryProjection = {
  id: familyMemory.id,
  content: familyMemory.content,
  kind: familyMemory.kind,
  memberId: familyMemory.memberId,
  createdByMemberId: familyMemory.createdByMemberId,
  source: familyMemory.source,
  createdAt: familyMemory.createdAt,
};

/** Active (non-archived) memories, newest first, capped at MEMORY_LIMIT. */
export async function loadActiveMemories(): Promise<MemoryRow[]> {
  try {
    const db = getDb();
    return await db
      .select(memoryProjection)
      .from(familyMemory)
      .where(isNull(familyMemory.archivedAt))
      .orderBy(desc(familyMemory.createdAt))
      .limit(MEMORY_LIMIT);
  } catch (err) {
    console.error("[lib/agent] failed to load family memories (continuing without them)", err);
    return [];
  }
}

/** "Sep 7" — short, family-facing date, evaluated in FAMILY_TZ. */
function formatShortDate(date: Date, tz: string): string {
  return formatInTimeZone(date, tz, "MMM d");
}

/**
 * Renders active memories as the block injected into the agent's system
 * prompt (see lib/agent/index.ts buildSystemPrompt), e.g.
 * `- [pattern] Yash has soccer every Tuesday 5-6pm (about Yash; from Ekta, Sep 7)`.
 * "about X" is omitted when the memory isn't about one specific member;
 * "from X" is omitted when the creator didn't resolve to a roster member
 * (an unattributed memory still shows its save date). Assumes `memories` is
 * already in the order it should be shown (loadActiveMemories' newest-first).
 */
export function formatMemoriesForPrompt(memories: MemoryRow[], roster: RosterMember[]): string {
  if (memories.length === 0) return "(Nothing remembered yet.)";

  const tz = getFamilyTimeZone();
  const nameById = new Map(roster.map((m) => [m.id, m.name]));

  return memories
    .map((m) => {
      const aboutName = m.memberId ? nameById.get(m.memberId) : undefined;
      const fromName = m.createdByMemberId ? nameById.get(m.createdByMemberId) : undefined;
      const dateStr = formatShortDate(m.createdAt, tz);

      const detail: string[] = [];
      if (aboutName) detail.push(`about ${aboutName}`);
      detail.push(fromName ? `from ${fromName}, ${dateStr}` : dateStr);

      return `- [${m.kind}] ${m.content} (${detail.join("; ")})`;
    })
    .join("\n");
}

export interface RememberMemoryInput {
  content: string;
  kind?: MemoryKind;
  memberId?: string;
  createdByMemberId?: string;
  source?: AgentSource;
}

/**
 * Saves a durable memory. Dedupes against ACTIVE memories only (an archived
 * "forgotten" memory with the same content doesn't block re-saving it) on
 * trimmed, case-folded content — returns the existing row instead of
 * inserting a second one when a match is found.
 *
 * Returns `null` (never throws) if `getDb()`/`DATABASE_URL` is unavailable
 * or the write fails — the caller (the `remember` tool) treats `null` as
 * "couldn't save that," matching this module's general degrade-gracefully
 * contract.
 */
export async function rememberMemory(input: RememberMemoryInput): Promise<MemoryRow | null> {
  try {
    const content = input.content.trim();
    const normalized = content.toLowerCase();

    const active = await loadActiveMemories();
    const duplicate = active.find((m) => m.content.trim().toLowerCase() === normalized);
    if (duplicate) return duplicate;

    const db = getDb();
    const [row] = await db
      .insert(familyMemory)
      .values({
        content,
        kind: input.kind ?? "fact",
        memberId: input.memberId,
        createdByMemberId: input.createdByMemberId,
        source: input.source,
      })
      .returning(memoryProjection);
    return row;
  } catch (err) {
    console.error("[lib/agent] failed to save a family memory (continuing without saving)", err);
    return null;
  }
}

/**
 * Archives (soft-deletes) a memory by id — never a real delete, so a
 * mistaken "forget" can be undone from the dashboard. A repeated call (an
 * already-archived row, or an id with no matching row at all) is a
 * harmless no-op, mirroring `lib/google/events.ts`'s `markAnnounced`/
 * `markReminded`. Degrades silently (logs, doesn't throw) on DB failure.
 */
export async function forgetMemory(id: string): Promise<void> {
  try {
    const db = getDb();
    await db.update(familyMemory).set({ archivedAt: new Date() }).where(eq(familyMemory.id, id));
  } catch (err) {
    console.error("[lib/agent] failed to archive a family memory (continuing)", err);
  }
}

export interface SearchHistoryInput {
  query: string;
  /** How many days back to search. Defaults to SEARCH_HISTORY_DEFAULT_SINCE_DAYS. */
  sinceDays?: number;
}

export interface SearchHistoryResult {
  date: Date;
  senderName: string;
  channel: "imessage" | "dashboard";
  text: string;
}

/**
 * Searches the family thread (lib/agent/history.ts's `familyThreadCondition`
 * — independent of which channel the search was requested from) for
 * `message_log` rows whose text contains EVERY whitespace-separated term in
 * `query` (case-insensitive). Newest first, capped at SEARCH_HISTORY_LIMIT.
 * Used by the `searchHistory` tool when someone refers to an earlier
 * conversation that's fallen outside the recent-turns window in
 * lib/agent/history.ts.
 */
export async function searchHistory({ query, sinceDays = SEARCH_HISTORY_DEFAULT_SINCE_DAYS }: SearchHistoryInput, roster: RosterMember[] = []): Promise<SearchHistoryResult[]> {
  try {
    const db = getDb();
    const terms = query
      .trim()
      .split(/\s+/)
      .filter((t) => t.length > 0);
    const cutoff = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

    const rows = await db
      .select({
        direction: messageLog.direction,
        text: messageLog.text,
        senderHandle: messageLog.senderHandle,
        memberId: messageLog.memberId,
        source: messageLog.source,
        createdAt: messageLog.createdAt,
      })
      .from(messageLog)
      .where(and(familyThreadCondition(), gte(messageLog.createdAt, cutoff), ...terms.map((t) => ilike(messageLog.text, `%${t}%`))))
      .orderBy(desc(messageLog.createdAt))
      .limit(SEARCH_HISTORY_LIMIT);

    const nameById = new Map(roster.map((m) => [m.id, m.name]));

    return rows.map((row) => ({
      date: row.createdAt,
      senderName: row.direction === "outbound" ? "LuthCal" : (row.memberId && nameById.get(row.memberId)) || row.senderHandle || "Unknown",
      channel: (row.source ?? "dashboard") as "imessage" | "dashboard",
      text: row.text,
    }));
  } catch (err) {
    console.error("[lib/agent] failed to search conversation history (continuing without results)", err);
    return [];
  }
}
