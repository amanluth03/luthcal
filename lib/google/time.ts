import { fromZonedTime, formatInTimeZone } from "date-fns-tz";

// Keep in sync with the default shown in .env.example. Used only as a
// fallback so a misconfigured/missing FAMILY_TZ degrades to *a* fixed IANA
// zone rather than silently falling back to server-local time.
const DEFAULT_FAMILY_TZ = "America/Chicago";

/**
 * Reads FAMILY_TZ lazily (never at module load), so this module is safe to
 * import during `next build` with no env vars set — mirrors the getDb()
 * lazy-singleton pattern in lib/db/index.ts.
 */
export function getFamilyTimeZone(): string {
  const tz = process.env.FAMILY_TZ?.trim();
  return tz && tz.length > 0 ? tz : DEFAULT_FAMILY_TZ;
}

const HAS_OFFSET_OR_Z = /(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Parses an ISO 8601 date-time string into an absolute instant (Date).
 *
 * Two shapes are accepted, since the agent's NLU can reasonably produce
 * either one when resolving natural language into a tool call:
 *
 *  - "2026-07-14T15:00:00-05:00" or "...Z" — an absolute instant; parsed
 *    as-is via `new Date(...)`, timezone-independent.
 *  - "2026-07-14T15:00:00" (no offset) — a "floating" wall-clock time,
 *    interpreted as that clock time *in the family's timezone* via
 *    `fromZonedTime`.
 *
 * Every event-math comparison in lib/google (conflict overlap checks,
 * all-day boundary math) goes through this function first, so it always
 * operates on real instants — never server-local time.
 */
export function parseFlexibleISO(iso: string, tz: string = getFamilyTimeZone()): Date {
  const date = HAS_OFFSET_OR_Z.test(iso) ? new Date(iso) : fromZonedTime(iso, tz);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ISO 8601 date-time: "${iso}"`);
  }
  return date;
}

/** The "YYYY-MM-DD" calendar day `iso` falls on, evaluated in `tz`. */
export function toCalendarDate(iso: string, tz: string = getFamilyTimeZone()): string {
  return formatInTimeZone(parseFlexibleISO(iso, tz), tz, "yyyy-MM-dd");
}

/** Adds `days` (may be negative) to a "YYYY-MM-DD" string. Pure date-only math, no timezone involved. */
export function addCalendarDays(dateOnly: string, days: number): string {
  const [year, month, day] = dateOnly.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Converts a "YYYY-MM-DD" calendar date (Google's all-day `date` field) to
 * the ISO UTC instant of midnight on that date *in `tz`*.
 *
 * All-day events don't have a "real" instant, but the shared `LuthEvent`
 * wire type (matched to lib/mock/types.ts and consumed by lib/format.ts's
 * `formatEventTime`) represents every start/end as a full ISO 8601 UTC
 * instant, all-day included — never a bare date. This is the one place that
 * boundary gets constructed, so every all-day event goes through it.
 */
export function calendarDateToISO(dateOnly: string, tz: string = getFamilyTimeZone()): string {
  return fromZonedTime(`${dateOnly}T00:00:00`, tz).toISOString();
}

/** Human-readable "current date/time" string for the agent's system prompt, e.g. "Monday, July 13, 2026 at 2:30 PM (CDT)". */
export function formatNowForPrompt(tz: string = getFamilyTimeZone()): string {
  return formatInTimeZone(new Date(), tz, "EEEE, MMMM d, yyyy 'at' h:mm a (zzz)");
}
