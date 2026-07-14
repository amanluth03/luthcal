import type { LuthEvent } from "./types";

/** Two events conflict when they share at least one family member and their
 * time ranges overlap. Canonical rule (mirrors lib/google/conflicts.ts): a
 * pair conflicts only when both are timed, or both are all-day — an all-day
 * event never conflicts with a timed one in either direction (a work trip and
 * a dentist appointment on the same day isn't a "conflict" the way two
 * overlapping timed events are), but two overlapping all-day events do. */
function overlaps(a: LuthEvent, b: LuthEvent): boolean {
  if (a.allDay !== b.allDay) return false;
  const aStart = Date.parse(a.start);
  const aEnd = Date.parse(a.end);
  const bStart = Date.parse(b.start);
  const bEnd = Date.parse(b.end);
  return aStart < bEnd && bStart < aEnd;
}

function sharesMember(a: LuthEvent, b: LuthEvent): boolean {
  return a.memberIds.some((id) => b.memberIds.includes(id));
}

/** Returns the set of event ids that are in conflict with at least one other
 * event (overlapping time range + shared member). O(n^2) — fine for a
 * family's event volume; a real backend would do this in the DB layer. */
export function findConflictingEventIds(events: LuthEvent[]): Set<string> {
  const conflicts = new Set<string>();
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const a = events[i];
      const b = events[j];
      if (sharesMember(a, b) && overlaps(a, b)) {
        conflicts.add(a.id);
        conflicts.add(b.id);
      }
    }
  }
  return conflicts;
}

/** All event ids that conflict with the given event. */
export function conflictsFor(event: LuthEvent, events: LuthEvent[]): LuthEvent[] {
  return events.filter(
    (other) =>
      other.id !== event.id && sharesMember(event, other) && overlaps(event, other)
  );
}
