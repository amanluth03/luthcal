/** Matches event_meta.created_via in lib/db/schema.ts. */
export type CreatedVia = "imessage" | "dashboard" | "calendar_app";

/**
 * A normalized view of a Google Calendar event, shared across lib/google and
 * lib/agent so neither has to reach into raw `calendar_v3.Schema$Event`
 * shapes (start.date vs start.dateTime, extendedProperties parsing, etc.).
 */
export interface LuthEvent {
  /** Google Calendar event id. */
  id: string;
  title: string;
  /**
   * ISO 8601, always a full UTC instant on the wire — matches
   * lib/mock/types.ts's `LuthEvent` contract exactly (and what
   * lib/format.ts's `formatEventTime`/`dayKey` already assume) so the
   * dashboard's mock adapter can be swapped for a real one without a
   * data-shape migration.
   *
   * For all-day events this is midnight in FAMILY_TZ on Google's `start.date`
   * — see `end` for the (Google-native, exclusive) end-boundary convention.
   */
  start: string;
  /**
   * ISO 8601 UTC instant. For all-day events this mirrors Google's own
   * convention: the *exclusive* end boundary, i.e. midnight in FAMILY_TZ on
   * the calendar day *after* the last day the event covers. A single-day
   * all-day event therefore has `end` one full day after `start`. (Matches
   * lib/format.ts, which already subtracts a second off `end` to recover the
   * last inclusive day for display.)
   */
  end: string;
  allDay: boolean;
  /** family_members.id values this event is tagged for. Empty if untagged (e.g. a calendar-app event we haven't matched to anyone yet). */
  memberIds: string[];
  notes?: string;
  location?: string;
  /** Present only if the event carries our extendedProperties tag; absent for events LuthCal didn't create. */
  createdVia?: CreatedVia;
}

export interface CreateEventInput {
  title: string;
  /**
   * ISO 8601 with an explicit UTC offset (or Z) — never a bare local time.
   * For all-day events, treat this the same as `LuthEvent.start`/`end`
   * (Google's native convention): `endISO` is the *exclusive* boundary, one
   * day after the last day the event covers. A single-day all-day event has
   * `endISO` one calendar day after `startISO`. Tool-calling callers (the
   * agent) must be told this explicitly — see lib/agent/tools.ts.
   */
  startISO: string;
  endISO: string;
  /** Defaults to false. */
  allDay?: boolean;
  memberIds: string[];
  notes?: string;
  location?: string;
  createdVia: CreatedVia;
}

export interface UpdateEventInput {
  googleEventId: string;
  title?: string;
  /** See CreateEventInput.startISO/endISO for the all-day exclusive-end convention. */
  startISO?: string;
  endISO?: string;
  allDay?: boolean;
  memberIds?: string[];
  notes?: string;
  location?: string;
}

export interface ListEventsInput {
  startISO: string;
  endISO: string;
  /** Filter to events tagged for this family member. */
  memberId?: string;
}
