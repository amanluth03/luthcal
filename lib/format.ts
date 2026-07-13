import { formatInTimeZone, toZonedTime } from "date-fns-tz";
import type { LuthEvent } from "@/lib/mock";

// Shared date/time formatting for the dashboard. Per CLAUDE.md convention,
// all event/time math renders in the family's IANA timezone — never the
// viewer's device timezone — so every helper here takes `tz` explicitly
// rather than reaching for the browser's implicit local zone.

/** "yyyy-MM-dd" bucket key for grouping events/entries by calendar day in tz. */
export function dayKey(iso: string, tz: string): string {
  return formatInTimeZone(new Date(iso), tz, "yyyy-MM-dd");
}

export function todayKey(tz: string): string {
  return formatInTimeZone(new Date(), tz, "yyyy-MM-dd");
}

/** A Date whose UTC-getters reflect the wall-clock time in `tz` — handy for
 * date-fns calendar math (startOfWeek, getDay, etc.) that should operate on
 * the family's local calendar day, not the viewer's. */
export function zoned(iso: string, tz: string): Date {
  return toZonedTime(new Date(iso), tz);
}

export function formatClock(iso: string, tz: string): string {
  return formatInTimeZone(new Date(iso), tz, "h:mm a");
}

export function formatWeekdayShort(iso: string, tz: string): string {
  return formatInTimeZone(new Date(iso), tz, "EEE");
}

export function formatDayMonth(iso: string, tz: string): string {
  return formatInTimeZone(new Date(iso), tz, "MMM d");
}

export function formatFullDay(iso: string, tz: string): string {
  return formatInTimeZone(new Date(iso), tz, "EEEE, MMMM d");
}

export function formatMonthYear(iso: string, tz: string): string {
  return formatInTimeZone(new Date(iso), tz, "MMMM yyyy");
}

/** "3:00 – 4:00 PM" / "All day" / "All day · Jul 14 – Jul 16" for multi-day. */
export function formatEventTime(event: LuthEvent, tz: string): string {
  if (event.allDay) {
    const startKey = dayKey(event.start, tz);
    // All-day events use an exclusive end date (Google Calendar convention).
    const inclusiveEndIso = new Date(
      new Date(event.end).getTime() - 1000
    ).toISOString();
    const endKey = dayKey(inclusiveEndIso, tz);
    if (startKey === endKey) return "All day";
    return `All day · ${formatDayMonth(event.start, tz)} – ${formatDayMonth(
      inclusiveEndIso,
      tz
    )}`;
  }
  const startLabel = formatClock(event.start, tz);
  const endLabel = formatClock(event.end, tz);
  // Drop a redundant AM/PM on the start label when both share it, e.g.
  // "3:00 – 4:00 PM" instead of "3:00 PM – 4:00 PM".
  const startMeridiem = startLabel.slice(-2);
  const endMeridiem = endLabel.slice(-2);
  if (startMeridiem === endMeridiem) {
    return `${startLabel.slice(0, -3)} – ${endLabel}`;
  }
  return `${startLabel} – ${endLabel}`;
}

/** Relative label for digest/activity timestamps: "Today · 7:30 AM",
 * "Yesterday · 6:00 PM", or "Jul 10 · 6:00 PM" beyond that. */
export function formatRelativeTimestamp(iso: string, tz: string): string {
  const key = dayKey(iso, tz);
  const today = todayKey(tz);
  const yesterday = dayKey(
    new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    tz
  );
  const clock = formatClock(iso, tz);
  if (key === today) return `Today · ${clock}`;
  if (key === yesterday) return `Yesterday · ${clock}`;
  return `${formatDayMonth(iso, tz)} · ${clock}`;
}

export function formatDayHeading(dateKey: string, tz: string): string {
  const today = todayKey(tz);
  const yesterday = dayKey(
    new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    tz
  );
  if (dateKey === today) return "Today";
  if (dateKey === yesterday) return "Yesterday";
  const [y, m, d] = dateKey.split("-").map(Number);
  return formatInTimeZone(new Date(Date.UTC(y, m - 1, d, 12)), "UTC", "EEEE, MMMM d");
}

/** Whether `event` occurs on the calendar day `dateKeyStr` ("yyyy-MM-dd", in
 * tz) — true for every day a multi-day all-day event spans, not just its
 * start day. All-day end dates are exclusive (Google Calendar convention). */
export function eventOccursOnDay(
  event: LuthEvent,
  dateKeyStr: string,
  tz: string
): boolean {
  const startKeyStr = dayKey(event.start, tz);
  const endBoundaryIso = event.allDay
    ? new Date(new Date(event.end).getTime() - 1000).toISOString()
    : event.end;
  const endKeyStr = dayKey(endBoundaryIso, tz);
  return dateKeyStr >= startKeyStr && dateKeyStr <= endKeyStr;
}

/** Groups items into an ordered array of [dayKey, items[]] buckets, newest
 * bucket first, preserving each bucket's incoming item order. */
export function groupByDay<T>(
  items: T[],
  getIso: (item: T) => string,
  tz: string
): Array<{ key: string; items: T[] }> {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const key = dayKey(getIso(item), tz);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }
  return Array.from(buckets.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([key, items]) => ({ key, items }));
}
