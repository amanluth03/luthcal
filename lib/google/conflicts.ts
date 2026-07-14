import { listEvents } from "./events";
import { getFamilyTimeZone, parseFlexibleISO } from "./time";
import type { LuthEvent } from "./types";

export interface CheckConflictsInput {
  startISO: string;
  endISO: string;
  /** family_members.id values the candidate event is for. */
  memberIds: string[];
  /** Whether the *candidate* event being checked is itself all-day. */
  allDay?: boolean;
  /** When checking conflicts for an update, pass the event's own id so it doesn't conflict with itself. */
  excludeGoogleEventId?: string;
}

export interface ConflictMatch {
  event: LuthEvent;
  /** Which of the queried memberIds this conflicting event is tagged for. */
  memberIds: string[];
}

/**
 * v1 conflict rule (see docs/agent-core.md for the full writeup):
 *
 *   overlap = candidate.start < other.end && candidate.end > other.start
 *
 * ...restricted to events that share at least one family member, and to
 * pairs of the *same kind*: a timed event only conflicts with another timed
 * event, and an all-day event only conflicts with another all-day event. An
 * all-day event never conflicts with a timed event, in either direction (an
 * all-day "reminder" event like "Kai's spring break" shouldn't flag a
 * conflict against every timed event that week, and a timed event shouldn't
 * flag against every all-day event covering that day either); two all-day
 * events on the same day *do* conflict with each other.
 *
 * Shared-calendar-only: this only sees events on the family's single shared
 * calendar. A member's personal calendar (if they keep one) is invisible to
 * this check — a v2 concern, not v1.
 */
export async function checkConflicts(input: CheckConflictsInput): Promise<ConflictMatch[]> {
  const tz = getFamilyTimeZone();
  const candidateStart = parseFlexibleISO(input.startISO, tz);
  const candidateEnd = parseFlexibleISO(input.endISO, tz);
  const candidateAllDay = input.allDay ?? false;

  // Widen the query window by a day on each side so all-day events (whose
  // Google `date` boundaries don't line up with instant math) are still
  // fetched and can be compared correctly below.
  const queryStart = new Date(candidateStart.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const queryEnd = new Date(candidateEnd.getTime() + 24 * 60 * 60 * 1000).toISOString();

  const events = await listEvents({ startISO: queryStart, endISO: queryEnd });

  const matches: ConflictMatch[] = [];
  for (const event of events) {
    if (input.excludeGoogleEventId && event.id === input.excludeGoogleEventId) continue;
    // Both-timed or both-all-day only — see the canonical rule in the
    // docstring above. An all-day event never conflicts with a timed event.
    if (event.allDay !== candidateAllDay) continue;

    const sharedMembers = event.memberIds.filter((id) => input.memberIds.includes(id));
    if (sharedMembers.length === 0) continue;

    const eventStart = parseFlexibleISO(event.start, tz);
    const eventEnd = parseFlexibleISO(event.end, tz);
    const overlaps = candidateStart < eventEnd && candidateEnd > eventStart;
    if (overlaps) {
      matches.push({ event, memberIds: sharedMembers });
    }
  }

  return matches;
}
