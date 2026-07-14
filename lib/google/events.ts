import type { calendar_v3 } from "googleapis";
import { eq, inArray, isNull } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { eventMeta } from "@/lib/db/schema";
import { getCalendarClient, getFamilyCalendarId } from "./client";
import { CREATED_VIA_PROPERTY, MEMBER_IDS_PROPERTY } from "./constants";
import { calendarDateToISO, getFamilyTimeZone, parseFlexibleISO, toCalendarDate } from "./time";
import type { CreateEventInput, CreatedVia, ListEventsInput, LuthEvent, UpdateEventInput } from "./types";

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function parseMemberIds(event: calendar_v3.Schema$Event): string[] {
  const raw = event.extendedProperties?.private?.[MEMBER_IDS_PROPERTY];
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    // Malformed tag (shouldn't happen for events we wrote ourselves) — treat as untagged rather than throwing.
    return [];
  }
}

export function normalizeEvent(event: calendar_v3.Schema$Event, tz: string = getFamilyTimeZone()): LuthEvent | null {
  if (!event.id) return null;

  const allDay = Boolean(event.start?.date && !event.start?.dateTime);
  // All-day boundaries come back from Google as bare "YYYY-MM-DD" dates.
  // Convert both to full ISO UTC instants (calendarDateToISO) so `LuthEvent`
  // always carries an absolute instant — matching lib/mock/types.ts and what
  // lib/format.ts's formatEventTime/dayKey already assume. `end` keeps
  // Google's native *exclusive* boundary (midnight the day after the last
  // day) rather than converting to an inclusive end — see types.ts.
  const start = allDay
    ? event.start?.date && calendarDateToISO(event.start.date, tz)
    : event.start?.dateTime;
  const end = allDay
    ? event.end?.date && calendarDateToISO(event.end.date, tz)
    : event.end?.dateTime;
  if (!start || !end) return null;

  const createdVia = event.extendedProperties?.private?.[CREATED_VIA_PROPERTY] as CreatedVia | undefined;

  return {
    id: event.id,
    title: event.summary ?? "(untitled event)",
    start,
    end,
    allDay,
    memberIds: parseMemberIds(event),
    notes: event.description ?? undefined,
    location: event.location ?? undefined,
    createdVia,
  };
}

// ---------------------------------------------------------------------------
// Google Schema$EventDateTime helpers
// ---------------------------------------------------------------------------

function toEventDateTime(iso: string, tz: string): calendar_v3.Schema$EventDateTime {
  // Pass the instant through as an absolute RFC3339 timestamp and set
  // `timeZone` explicitly for display — never rely on server-local time.
  return { dateTime: parseFlexibleISO(iso, tz).toISOString(), timeZone: tz };
}

/**
 * Builds the all-day `start`/`end` pair. `startISO`/`endISO` are treated as
 * Google-native boundaries — `endISO` is the *exclusive* end (one day past
 * the last day the event covers), same as `LuthEvent.end` and the calendar's
 * own `end.date`. This is a deliberate uniform convention (no inclusive/
 * exclusive conversion anywhere in this file): it matches Google exactly, it
 * matches lib/format.ts's existing assumption about `LuthEvent.end`, and it
 * avoids an off-by-one that an inclusive-end convention would otherwise
 * accumulate across partial updates that re-derive one boundary from the
 * other (see updateEvent below). The agent's tool description is
 * responsible for telling the LLM to compute `endISO` this way.
 */
function toAllDayRange(startISO: string, endISO: string, tz: string): { start: calendar_v3.Schema$EventDateTime; end: calendar_v3.Schema$EventDateTime } {
  return {
    start: { date: toCalendarDate(startISO, tz) },
    end: { date: toCalendarDate(endISO, tz) },
  };
}

// ---------------------------------------------------------------------------
// event_meta persistence (best-effort: a DB hiccup should never undo a
// Google Calendar write we already made, so failures here are logged, not
// thrown — the watch-channel sync will backfill/repair event_meta on the
// next change notification).
// ---------------------------------------------------------------------------

async function safeDb<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[lib/google/events] ${label} failed (continuing)`, err);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function createEvent(input: CreateEventInput): Promise<LuthEvent> {
  const calendar = getCalendarClient();
  const calendarId = getFamilyCalendarId();
  const tz = getFamilyTimeZone();
  const allDay = input.allDay ?? false;

  const requestBody: calendar_v3.Schema$Event = {
    summary: input.title,
    description: input.notes,
    location: input.location,
    ...(allDay
      ? toAllDayRange(input.startISO, input.endISO, tz)
      : { start: toEventDateTime(input.startISO, tz), end: toEventDateTime(input.endISO, tz) }),
    extendedProperties: {
      private: {
        [MEMBER_IDS_PROPERTY]: JSON.stringify(input.memberIds),
        [CREATED_VIA_PROPERTY]: input.createdVia,
      },
    },
  };

  const res = await calendar.events.insert({ calendarId, requestBody });
  const normalized = normalizeEvent(res.data);
  if (!normalized) {
    throw new Error("Google Calendar did not return a usable event from events.insert");
  }

  await safeDb("event_meta insert", async () => {
    const db = getDb();
    // Self-announcing events (created from the group chat itself) are
    // considered announced immediately — the agent's reply in the same
    // conversation *is* the announcement. Events created from the dashboard
    // (or, later, calendar-app events picked up by the webhook sync) leave
    // announced_at null so the async announce sweep picks them up. See
    // docs/agent-core.md "Announcement triggers".
    await db.insert(eventMeta).values({
      googleEventId: normalized.id,
      memberIds: input.memberIds,
      createdVia: input.createdVia,
      announcedAt: input.createdVia === "imessage" ? new Date() : null,
    });
  });

  return normalized;
}

export async function getEvent(googleEventId: string): Promise<LuthEvent | null> {
  const calendar = getCalendarClient();
  const calendarId = getFamilyCalendarId();
  const res = await calendar.events.get({ calendarId, eventId: googleEventId });
  return normalizeEvent(res.data);
}

export async function updateEvent(input: UpdateEventInput): Promise<LuthEvent> {
  const calendar = getCalendarClient();
  const calendarId = getFamilyCalendarId();
  const tz = getFamilyTimeZone();

  // Fetch the existing event so a partial update (e.g. "just move the time")
  // doesn't have to re-specify fields it isn't changing, and so we know
  // whether this is an all-day event when only one of startISO/endISO changes.
  const existingRes = await calendar.events.get({ calendarId, eventId: input.googleEventId });
  const existing = existingRes.data;
  const wasAllDay = Boolean(existing.start?.date && !existing.start?.dateTime);
  const allDay = input.allDay ?? wasAllDay;

  const requestBody: calendar_v3.Schema$Event = {};
  if (input.title !== undefined) requestBody.summary = input.title;
  if (input.notes !== undefined) requestBody.description = input.notes;
  if (input.location !== undefined) requestBody.location = input.location;

  if (input.startISO !== undefined || input.endISO !== undefined || input.allDay !== undefined) {
    // existing.start?.date / existing.end?.date are Google's raw all-day
    // boundaries (end exclusive) — under our uniform exclusive-end
    // convention (see toAllDayRange) these can be reused as-is, just given a
    // time component so toCalendarDate/parseFlexibleISO can parse them. No
    // +1/-1 day adjustment here: that's exactly what would let an off-by-one
    // accumulate across repeated partial updates.
    const startISO = input.startISO ?? existing.start?.dateTime ?? (existing.start?.date ? `${existing.start.date}T00:00:00` : undefined);
    const endISO = input.endISO ?? existing.end?.dateTime ?? (existing.end?.date ? `${existing.end.date}T00:00:00` : undefined);
    if (!startISO || !endISO) {
      throw new Error(`Event ${input.googleEventId} is missing a start/end to base the update on`);
    }
    Object.assign(
      requestBody,
      allDay ? toAllDayRange(startISO, endISO, tz) : { start: toEventDateTime(startISO, tz), end: toEventDateTime(endISO, tz) },
    );
  }

  if (input.memberIds !== undefined) {
    requestBody.extendedProperties = {
      private: {
        ...existing.extendedProperties?.private,
        [MEMBER_IDS_PROPERTY]: JSON.stringify(input.memberIds),
      },
    };
  }

  const res = await calendar.events.patch({ calendarId, eventId: input.googleEventId, requestBody });
  const normalized = normalizeEvent(res.data);
  if (!normalized) {
    throw new Error("Google Calendar did not return a usable event from events.patch");
  }

  if (input.memberIds !== undefined) {
    await safeDb("event_meta memberIds sync", async () => {
      const db = getDb();
      // TODO(Finding 4, low-pri): createdVia here is a guess for the
      // no-existing-row case (we don't actually know how this event was
      // created); onConflictDoUpdate below never overwrites createdVia on an
      // existing row, so this guess only ever affects a freshly-inserted row.
      await db
        .insert(eventMeta)
        .values({ googleEventId: normalized.id, memberIds: input.memberIds!, createdVia: "calendar_app" })
        .onConflictDoUpdate({
          target: eventMeta.googleEventId,
          set: { memberIds: input.memberIds! },
        });
    });
  }

  return normalized;
}

export async function deleteEvent(googleEventId: string): Promise<void> {
  const calendar = getCalendarClient();
  const calendarId = getFamilyCalendarId();
  await calendar.events.delete({ calendarId, eventId: googleEventId });

  await safeDb("event_meta delete", async () => {
    const db = getDb();
    await db.delete(eventMeta).where(eq(eventMeta.googleEventId, googleEventId));
  });
}

export async function listEvents(input: ListEventsInput): Promise<LuthEvent[]> {
  const calendar = getCalendarClient();
  const calendarId = getFamilyCalendarId();
  const tz = getFamilyTimeZone();

  const res = await calendar.events.list({
    calendarId,
    timeMin: parseFlexibleISO(input.startISO, tz).toISOString(),
    timeMax: parseFlexibleISO(input.endISO, tz).toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 2500,
  });

  const events = (res.data.items ?? [])
    .map((event) => normalizeEvent(event, tz))
    .filter((e): e is LuthEvent => e !== null);

  return input.memberId ? events.filter((e) => e.memberIds.includes(input.memberId!)) : events;
}

// ---------------------------------------------------------------------------
// Announcement / reminder dedup helpers, used by backend-dev's cron jobs
// (app/api/cron/*) and by the Google webhook sync (lib/google/watch.ts).
// See docs/agent-core.md for the full trigger rules.
// ---------------------------------------------------------------------------

export interface PendingAnnouncement {
  googleEventId: string;
  memberIds: string[];
  createdVia: CreatedVia;
}

/** Events whose creation hasn't been announced to the group chat yet. */
export async function listPendingAnnouncements(): Promise<PendingAnnouncement[]> {
  const db = getDb();
  const rows = await db
    .select({ googleEventId: eventMeta.googleEventId, memberIds: eventMeta.memberIds, createdVia: eventMeta.createdVia })
    .from(eventMeta)
    .where(isNull(eventMeta.announcedAt));
  return rows;
}

export async function markAnnounced(googleEventId: string): Promise<void> {
  const db = getDb();
  await db.update(eventMeta).set({ announcedAt: new Date() }).where(eq(eventMeta.googleEventId, googleEventId));
}

/**
 * Events starting within `withinMs` that haven't had a reminder sent yet.
 * v1 sends at most one reminder per event — see docs/agent-core.md.
 */
export async function listUpcomingEventsPendingReminder(withinMs: number): Promise<LuthEvent[]> {
  const tz = getFamilyTimeZone();
  const now = new Date();
  const events = await listEvents({
    startISO: now.toISOString(),
    endISO: new Date(now.getTime() + withinMs).toISOString(),
  });
  if (events.length === 0) return [];

  // Google's timeMin/timeMax (via listEvents above) returns anything that
  // OVERLAPS the window, including events already in progress — a multi-day
  // all-day trip that started yesterday, a long timed event that began an
  // hour ago. The contract here is "events STARTING within withinMs," so
  // filter down to that by actual start instant.
  //
  // All-day events don't have a real start *instant* to compare against a
  // short rolling window: LuthEvent.start is midnight in FAMILY_TZ on the
  // event's start date (see calendarDateToISO), which has already passed by
  // `now` for essentially the entire day the event starts — a literal
  // instant check would almost never fire for an all-day event. Judgment
  // call (tech-lead's intent is "starting soon"): treat an all-day event as
  // "starting soon" if its start date, in FAMILY_TZ, is *today*, regardless
  // of what time of day this sweep happens to run. This still correctly
  // excludes an all-day event already in progress (its start date is before
  // today), which is the bug this fix targets — it just doesn't require the
  // sweep to catch it in the narrow instant right after midnight.
  const nowMs = now.getTime();
  const windowEndMs = nowMs + withinMs;
  const today = toCalendarDate(now.toISOString(), tz);
  const upcoming = events.filter((e) => {
    if (e.allDay) return toCalendarDate(e.start, tz) === today;
    const startMs = new Date(e.start).getTime();
    return startMs >= nowMs && startMs <= windowEndMs;
  });
  if (upcoming.length === 0) return [];

  const db = getDb();
  const rows = await db
    .select({ googleEventId: eventMeta.googleEventId, remindedAt: eventMeta.remindedAt })
    .from(eventMeta)
    .where(inArray(eventMeta.googleEventId, upcoming.map((e) => e.id)));

  const alreadyReminded = new Set(rows.filter((r) => r.remindedAt !== null).map((r) => r.googleEventId));
  return upcoming.filter((e) => !alreadyReminded.has(e.id));
}

export async function markReminded(googleEventId: string): Promise<void> {
  const db = getDb();
  await db.update(eventMeta).set({ remindedAt: new Date() }).where(eq(eventMeta.googleEventId, googleEventId));
}
