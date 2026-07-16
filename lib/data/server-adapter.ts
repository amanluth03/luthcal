import "server-only";

import { asc, desc, eq, inArray } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { familyMembers, messageLog, settings as settingsTable } from "@/lib/db/schema";
import { listEvents as listGoogleEvents } from "@/lib/google/events";
import type { LuthEvent as GoogleLuthEvent } from "@/lib/google/types";
import type { DataAdapter } from "@/lib/mock/adapter";
import type {
  ActivityEntry,
  DigestEntry,
  FamilyMember,
  LuthEvent,
  MemberColor,
  Settings,
} from "@/lib/mock/types";

/**
 * The real `DataAdapter` — Google Calendar + Neon Postgres (`getDb()`)
 * instead of `lib/mock`'s in-memory fixtures. `import "server-only"` above
 * guarantees a client-bundle build error if this module (which pulls in
 * `getDb()`/`googleapis` credentials) is ever imported from client
 * component code — mirrors the lazy-init pattern in `lib/db/index.ts` and
 * `lib/google/client.ts`: every credentialed client is constructed lazily,
 * inside a function body, on first call, never at module load — so this
 * file itself has zero top-level side effects and importing it is safe even
 * with no env vars configured (e.g. during `next build`).
 */

// ---------------------------------------------------------------------------
// getFamilyMembers
// ---------------------------------------------------------------------------

/**
 * `family_members.color` is a free-text hex string (seeded by
 * `scripts/seed.ts`); `FamilyMember.color` is a closed `MemberColor` token
 * the dashboard's CSS variables key off (`--member-<token>` in
 * globals.css). This maps the 4 colors the seed script actually assigns.
 * Anything else (a hex Postgres doesn't know about, a null column, a future
 * manual edit that doesn't match) falls back to "slate" rather than
 * throwing — an unrecognized color should degrade to a neutral swatch, not
 * break the family list.
 */
const HEX_TO_MEMBER_COLOR: Readonly<Record<string, MemberColor>> = {
  "#3b82f6": "blue",
  "#14b8a6": "teal",
  "#8b5cf6": "violet",
  "#f43f5e": "rose",
};

function mapHexToMemberColor(hex: string | null): MemberColor {
  if (!hex) return "slate";
  return HEX_TO_MEMBER_COLOR[hex.trim().toLowerCase()] ?? "slate";
}

async function getFamilyMembers(): Promise<FamilyMember[]> {
  const db = getDb();
  // Ordered by createdAt so the family list/legend has a stable, predictable
  // order across requests (Postgres makes no ordering guarantee without an
  // explicit ORDER BY).
  const rows = await db.select().from(familyMembers).orderBy(asc(familyMembers.createdAt));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    imessageHandle: row.imessageHandle,
    phone: row.phone,
    color: mapHexToMemberColor(row.color),
    aliases: row.aliases ?? [],
    createdAt: row.createdAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// getEvents
// ---------------------------------------------------------------------------

/**
 * `lib/google/types.ts`'s `LuthEvent` and `lib/mock/types.ts`'s `LuthEvent`
 * were deliberately kept field-for-field identical (see docs/agent-core.md
 * §7) specifically so this mapping could be a pass-through. Written out
 * field-by-field anyway (not `as unknown as LuthEvent`) so a future
 * divergence between the two type files is a compile error here, not a
 * silent cast:
 *   id           string                              -> string            (match)
 *   title        string                              -> string            (match)
 *   start        string (ISO 8601 UTC instant)        -> string            (match)
 *   end          string (ISO 8601 UTC instant, excl.) -> string            (match)
 *   allDay       boolean                              -> boolean           (match)
 *   memberIds    string[]                             -> string[]          (match)
 *   notes        string | undefined                   -> string | undefined(match)
 *   location     string | undefined                   -> string | undefined(match)
 *   createdVia   CreatedVia | undefined                -> EventSource | undefined (same literal union: "imessage" | "dashboard" | "calendar_app")
 */
function mapGoogleEventToDashboard(event: GoogleLuthEvent): LuthEvent {
  return {
    id: event.id,
    title: event.title,
    start: event.start,
    end: event.end,
    allDay: event.allDay,
    memberIds: event.memberIds,
    notes: event.notes,
    location: event.location,
    createdVia: event.createdVia,
  };
}

async function getEvents(rangeStart: string, rangeEnd: string): Promise<LuthEvent[]> {
  const events = await listGoogleEvents({ startISO: rangeStart, endISO: rangeEnd });
  return events.map(mapGoogleEventToDashboard);
}

// ---------------------------------------------------------------------------
// getActivity
// ---------------------------------------------------------------------------

// Reasonable cap for a dashboard activity feed — most-recent-first, not a
// full audit log. Bump if the Activity page ever grows pagination.
const ACTIVITY_LIMIT = 50;

function resolveActivitySender(
  row: { direction: "inbound" | "outbound"; memberId: string | null; senderHandle: string | null },
  nameByMemberId: Map<string, string>,
): string {
  if (row.memberId) {
    const name = nameByMemberId.get(row.memberId);
    if (name) return name;
  }
  if (row.senderHandle) return row.senderHandle;
  // Outbound messages with no memberId (the agent doesn't tag its own
  // sends with a member) and no senderHandle are the agent itself.
  // Inbound messages with neither (shouldn't normally happen — every real
  // iMessage/dashboard send has a handle) fall back to "Unknown" rather
  // than mislabeling them "Agent".
  return row.direction === "outbound" ? "Agent" : "Unknown";
}

async function getActivity(): Promise<ActivityEntry[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(messageLog)
    .orderBy(desc(messageLog.createdAt))
    .limit(ACTIVITY_LIMIT);

  if (rows.length === 0) return [];

  const memberIds = Array.from(new Set(rows.map((r) => r.memberId).filter((id): id is string => id !== null)));
  const nameByMemberId = new Map<string, string>();
  if (memberIds.length > 0) {
    const members = await db
      .select({ id: familyMembers.id, name: familyMembers.name })
      .from(familyMembers)
      .where(inArray(familyMembers.id, memberIds));
    for (const m of members) nameByMemberId.set(m.id, m.name);
  }

  // `ActivityEntry.action` is intentionally omitted (left undefined):
  // message_log has no structured action column (no create_event/
  // flag_conflict/etc. classification persisted anywhere), unlike the mock
  // seed data which hand-authors one per row. Deriving it after the fact
  // would mean re-parsing free text or joining against `event_meta`/agent
  // tool-call logs that don't exist yet — flagged as a v2 enrichment (e.g.
  // persist `RunAgentResult.actions` from lib/agent/index.ts alongside the
  // message_log row) rather than guessed at here.
  return rows.map((row) => ({
    id: row.id,
    direction: row.direction,
    sender: resolveActivitySender(row, nameByMemberId),
    text: row.text,
    createdAt: row.createdAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// getDigests
// ---------------------------------------------------------------------------

/**
 * There is no dedicated digest log (see docs/agent-core.md §3 "Digests" —
 * digests are recommended to be idempotent-by-schedule via a `settings` key,
 * not per-row state). `outbound_queue` is the only candidate table, but it
 * holds *every* outbound send — ordinary conversational replies from
 * runAgent, announcements, reminders, and (once built) digests — with no
 * `kind` column distinguishing them. There's no reliable, non-fabricated way
 * to pick "digest-shaped" rows out of that mix: guessing from text content
 * (e.g. regexing for "Today's schedule") would misclassify real messages and
 * is exactly the kind of fabrication the task brief says not to do.
 *
 * v1 choice: return `[]`. This is the weakest mapping in this adapter —
 * flagging for tech-lead: a real implementation needs either (a) a new
 * `digest_log` table written by backend-dev's digest cron at send time (kind
 * + sentAt + text + relatedEventIds, mirroring `DigestEntry` directly), or
 * (b) an `outbound_queue.kind` column populated at enqueue time. Until then,
 * the dashboard's Digests view will render empty against real data, which is
 * an honest reflection of "no digest cron exists yet" rather than a
 * misleading fabricated history.
 */
async function getDigests(): Promise<DigestEntry[]> {
  return [];
}

// ---------------------------------------------------------------------------
// getSettings
// ---------------------------------------------------------------------------

/**
 * No settings UI writes to Postgres yet (`lib/mock/adapter.ts`'s own comment
 * notes the Settings page is mock-mutations-only, no real persistence). This
 * reads a single `settings` row keyed `"dashboard_settings"` whose `value`
 * is a JSON object shaped like (a partial) `Settings` — same one-key/
 * one-JSON-blob pattern `lib/google/watch.ts` already uses for
 * `"google_watch_channel"` — so that if/when a real settings-save path is
 * added later, it's a single upsert against this same key and this reader
 * needs no changes.
 *
 * Falls back to defaults per-field (not all-or-nothing) so a partially
 * populated row (or no row at all, pre-seed) still returns a fully-formed
 * `Settings` object rather than throwing. `timezone` defaults from
 * `FAMILY_TZ` (falling back to "America/Chicago" if that's unset too) per
 * the task brief; the rest mirror the same defaults `lib/mock/seed.ts` uses
 * today so behavior doesn't visibly change the moment the mock adapter is
 * swapped out.
 */
const SETTINGS_KEY = "dashboard_settings";

function defaultSettings(): Settings {
  return {
    dailyDigestEnabled: true,
    dailyDigestTime: "07:30",
    weeklyDigestEnabled: true,
    weeklyDigestDay: "sunday",
    weeklyDigestTime: "18:00",
    reminderLeadHours: 24,
    timezone: process.env.FAMILY_TZ || "America/Chicago",
  };
}

async function getSettings(): Promise<Settings> {
  const defaults = defaultSettings();
  const db = getDb();
  const rows = await db
    .select({ value: settingsTable.value })
    .from(settingsTable)
    .where(eq(settingsTable.key, SETTINGS_KEY))
    .limit(1);

  const stored = rows[0]?.value as Partial<Settings> | undefined;
  return { ...defaults, ...stored };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Design note on error handling (asymmetric on purpose):
 * `getFamilyMembers`/`getEvents`/`getActivity` let a DB or Google API
 * failure propagate — a real error surfaces to the dashboard's error
 * boundary/loading state, which is the correct outcome for primary content
 * (an empty calendar reads as "no events," not "something is broken," and
 * silently hiding that distinction is worse than a visible error). Only
 * `getSettings` degrades to defaults on missing data, per the task brief —
 * and only for the *no row yet* case (an unseeded settings row is expected
 * state, not a failure) — it does not swallow a genuine DB error into
 * defaults.
 */
export const realDataAdapter: DataAdapter = {
  getFamilyMembers,
  getEvents,
  getDigests,
  getActivity,
  getSettings,
};
