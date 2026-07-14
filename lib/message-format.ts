import { formatInTimeZone } from "date-fns-tz";

import { getDb } from "@/lib/db";
import { familyMembers } from "@/lib/db/schema";
import type { LuthEvent } from "@/lib/google/types";

// Small local formatters for composing the plain-text iMessage bodies the
// cron sweeps (digest/reminder/announce) enqueue. Deliberately not reusing
// lib/google/time.ts's TZ-conversion helpers here beyond what's needed (this
// is display formatting of already-normalized LuthEvent instants, not
// parsing/converting) and deliberately not reusing the dashboard's
// lib/format.ts (a different, frontend-owned module tied to lib/mock's
// LuthEvent type) — per CLAUDE.md/task guidance, a small local formatter is
// preferred over cross-module coupling here.

/**
 * Best-effort family_members.id -> name lookup, for composing human-readable
 * messages ("Maya - dentist (Maya)") instead of raw ids. Falls back to an
 * empty map (no DB configured, or a transient failure) — callers degrade to
 * omitting names rather than throwing.
 */
export async function getMemberNameMap(): Promise<Map<string, string>> {
  try {
    const db = getDb();
    const rows = await db.select({ id: familyMembers.id, name: familyMembers.name }).from(familyMembers);
    return new Map(rows.map((r) => [r.id, r.name]));
  } catch (err) {
    console.error("[lib/message-format] failed to load family roster (continuing without names)", err);
    return new Map();
  }
}

function formatClock(iso: string, tz: string): string {
  return formatInTimeZone(new Date(iso), tz, "h:mm a");
}

/** "3:00 – 4:00 PM", dropping a redundant AM/PM on the start label when both share it. */
function formatClockRange(startIso: string, endIso: string, tz: string): string {
  const start = formatClock(startIso, tz);
  const end = formatClock(endIso, tz);
  const sameMeridiem = start.slice(-2) === end.slice(-2);
  return sameMeridiem ? `${start.slice(0, -3)} – ${end}` : `${start} – ${end}`;
}

function namesSuffix(event: LuthEvent, names: Map<string, string>): string {
  if (event.memberIds.length === 0) return "";
  return ` (${event.memberIds.map((id) => names.get(id) ?? "?").join(", ")})`;
}

/** "3:00 – 4:00 PM: Maya - dentist (Maya)" / "All day: Kai's spring break (Kai)". */
export function formatEventLine(event: LuthEvent, tz: string, names: Map<string, string>): string {
  const time = event.allDay ? "All day" : formatClockRange(event.start, event.end, tz);
  return `${time}: ${event.title}${namesSuffix(event, names)}`;
}

/** "Sunday, July 13" — a calendar-day heading for grouping the weekly digest. `dateKey` is "yyyy-MM-dd" in FAMILY_TZ. */
export function formatDayHeading(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  // Noon UTC sidesteps any DST-boundary edge case when re-rendering a plain
  // calendar date — there's no timezone left to apply at this point, dateKey
  // is already the calendar day we want to display.
  return formatInTimeZone(new Date(Date.UTC(y, m - 1, d, 12)), "UTC", "EEEE, MMMM d");
}
