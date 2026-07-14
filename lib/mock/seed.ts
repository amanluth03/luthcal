import {
  addDays,
  addMonths,
  format,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  subMonths,
} from "date-fns";
import { fromZonedTime } from "date-fns-tz";
import type {
  ActivityEntry,
  DigestEntry,
  FamilyMember,
  LuthEvent,
  Settings,
} from "./types";

// ---------------------------------------------------------------------------
// Seed data for the mock adapter. Everything here is generated relative to
// "now" (at module load / cold start) so the calendar always shows a
// plausible current week instead of dates that go stale. Nothing here is
// persisted — see lib/mock/adapter.ts for the swap-to-real-backend seam.
// ---------------------------------------------------------------------------

export const TIMEZONE = "America/Chicago";

const now = new Date();
const weekStart = startOfWeek(now, { weekStartsOn: 0 }); // Sunday

/** Builds a UTC ISO string for a wall-clock time expressed in TIMEZONE,
 * `dayOffset` days after `base`. */
function at(base: Date, dayOffset: number, hour: number, minute = 0): string {
  const day = addDays(base, dayOffset);
  const naive = new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    hour,
    minute,
    0,
    0
  );
  return fromZonedTime(naive, TIMEZONE).toISOString();
}

function atDate(day: Date, hour: number, minute = 0): string {
  const naive = new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    hour,
    minute,
    0,
    0
  );
  return fromZonedTime(naive, TIMEZONE).toISOString();
}

export const FAMILY_MEMBERS: FamilyMember[] = [
  {
    id: "aman",
    name: "Vijay",
    imessageHandle: "+1 (512) 555-0142",
    phone: "+1 (512) 555-0142",
    color: "violet",
    aliases: ["Vijay", "Papa", "Dad"],
    createdAt: new Date(2024, 8, 1).toISOString(),
  },
  {
    id: "priya",
    name: "Ekta",
    imessageHandle: "ekta.luthra@icloud.com",
    phone: "+1 (512) 555-0198",
    color: "rose",
    aliases: ["Ekta", "Mai", "Mom"],
    createdAt: new Date(2024, 8, 1).toISOString(),
  },
  {
    id: "maya",
    name: "Aman",
    imessageHandle: "+1 (512) 555-0110",
    phone: "+1 (512) 555-0110",
    color: "blue",
    aliases: ["Aman"],
    createdAt: new Date(2024, 8, 1).toISOString(),
  },
  {
    id: "kiran",
    name: "Yash",
    imessageHandle: "+1 (512) 555-0177",
    phone: "+1 (512) 555-0177",
    color: "teal",
    aliases: ["Yash"],
    createdAt: new Date(2024, 8, 1).toISOString(),
  },
];

const ALL_IDS = FAMILY_MEMBERS.map((m) => m.id);

function buildEvents(): LuthEvent[] {
  const events: LuthEvent[] = [];

  // --- Recurring rhythm across the whole visible range -------------------
  // Date-keyed ids (not a shared counter) so every recurring instance gets a
  // stable, unique id regardless of how many other events are generated
  // around it — and so hero events below can use short, fixed, human-
  // readable ids that DIGESTS/ACTIVITY can safely reference by name.
  const rangeStart = startOfMonth(subMonths(now, 1));
  const rangeEnd = endOfMonth(addMonths(now, 2));
  let cursor = rangeStart;
  while (cursor <= rangeEnd) {
    const dow = cursor.getDay(); // 0 Sun .. 6 Sat
    const dateKey = format(cursor, "yyyy-MM-dd");
    if (dow === 2 || dow === 4) {
      // Tue / Thu soccer practice
      events.push({
        id: `evt-soccer-${dateKey}`,
        title: "Soccer practice",
        start: atDate(cursor, 17, 30),
        end: atDate(cursor, 19, 0),
        allDay: false,
        memberIds: ["kiran"],
        location: "Zilker Park fields",
        createdVia: "calendar_app",
      });
    }
    if (dow === 3) {
      // Wed guitar lesson
      events.push({
        id: `evt-guitar-${dateKey}`,
        title: "Guitar lesson",
        start: atDate(cursor, 16, 30),
        end: atDate(cursor, 17, 15),
        allDay: false,
        memberIds: ["kiran"],
        location: "Austin Music Studio",
        createdVia: "dashboard",
      });
    }
    if (dow === 5) {
      // Fri family dinner
      events.push({
        id: `evt-dinner-${dateKey}`,
        title: "Family dinner",
        start: atDate(cursor, 18, 30),
        end: atDate(cursor, 20, 0),
        allDay: false,
        memberIds: ALL_IDS,
        location: "Home",
        createdVia: "imessage",
      });
    }
    cursor = addDays(cursor, 1);
  }

  // --- This week's hero events (the ones the calendar should feel "alive" with) ---
  events.push({
    id: "evt-standup",
    title: "Team offsite standup",
    start: at(weekStart, 1, 9, 0),
    end: at(weekStart, 1, 10, 0),
    allDay: false,
    memberIds: ["aman"],
    location: "Downtown office",
    createdVia: "calendar_app",
  });

  // Deliberate visible conflict: Aman's dentist appointment overlaps his
  // piano lesson by 30 minutes on the same afternoon. Referenced by id from
  // DIGESTS and ACTIVITY below, and surfaced via findConflictingEventIds().
  events.push({
    id: "evt-dentist",
    title: "Dentist appointment",
    start: at(weekStart, 2, 15, 0),
    end: at(weekStart, 2, 16, 0),
    allDay: false,
    memberIds: ["maya"],
    notes: "Dr. Ellis, north office. Bring insurance card.",
    createdVia: "imessage",
  });
  events.push({
    id: "evt-piano",
    title: "Piano lesson",
    start: at(weekStart, 2, 15, 30),
    end: at(weekStart, 2, 16, 15),
    allDay: false,
    memberIds: ["maya"],
    location: "Ms. Chen's studio",
    createdVia: "calendar_app",
  });

  events.push({
    id: "evt-trip-denver",
    title: "Work trip — Denver",
    start: at(weekStart, 3, 0, 0),
    end: at(weekStart, 6, 0, 0),
    allDay: true,
    memberIds: ["priya"],
    notes: "Conference; back Friday night.",
    createdVia: "dashboard",
  });

  events.push({
    id: "evt-ortho",
    title: "Orthodontist consult",
    start: at(weekStart, 4, 19, 0),
    end: at(weekStart, 4, 19, 45),
    allDay: false,
    memberIds: ["maya"],
    createdVia: "imessage",
  });

  events.push({
    id: "evt-birthday",
    title: "Theo's birthday party",
    start: at(weekStart, 6, 10, 0),
    end: at(weekStart, 6, 11, 30),
    allDay: false,
    memberIds: ["kiran"],
    location: "Bounce House Austin",
    createdVia: "imessage",
  });

  events.push({
    id: "evt-datenight",
    title: "Date night",
    start: at(weekStart, 6, 19, 0),
    end: at(weekStart, 6, 21, 0),
    allDay: false,
    memberIds: ["aman", "priya"],
    location: "Uchi",
    createdVia: "dashboard",
  });

  events.push({
    id: "evt-gamenight",
    title: "Family game night",
    start: at(weekStart, 0, 18, 0),
    end: at(weekStart, 0, 19, 30),
    allDay: false,
    memberIds: ALL_IDS,
    location: "Home",
    createdVia: "dashboard",
  });

  // --- A few one-offs scattered further out for month-view texture -------
  events.push({
    id: "evt-picture-day",
    title: "School picture day",
    start: at(weekStart, -18, 0, 0),
    end: at(weekStart, -17, 0, 0),
    allDay: true,
    memberIds: ["maya", "kiran"],
    createdVia: "calendar_app",
  });

  events.push({
    id: "evt-swim",
    title: "Swim meet",
    start: at(weekStart, 13, 9, 0),
    end: at(weekStart, 13, 12, 0),
    allDay: false,
    memberIds: ["maya"],
    location: "Northwest Rec Center",
    createdVia: "imessage",
  });

  events.push({
    id: "evt-bookclub",
    title: "Book club",
    start: at(weekStart, 24, 19, 0),
    end: at(weekStart, 24, 20, 30),
    allDay: false,
    memberIds: ["priya"],
    createdVia: "dashboard",
  });

  events.push({
    id: "evt-conference-sf",
    title: "Conference — San Francisco",
    start: at(weekStart, 30, 0, 0),
    end: at(weekStart, 33, 0, 0),
    allDay: true,
    memberIds: ["aman"],
    createdVia: "dashboard",
  });

  return events.sort((a, b) => a.start.localeCompare(b.start));
}

export const EVENTS: LuthEvent[] = buildEvents();

function daysAgo(n: number, hour: number, minute = 0): string {
  return atDate(addDays(now, -n), hour, minute);
}

export const DIGESTS: DigestEntry[] = [
  {
    id: "dig-0",
    kind: "announcement",
    sentAt: at(weekStart, 2, 9, 12),
    text: 'Added "Dentist appointment" for Aman — Tuesday at 3:00 PM. Heads up: this overlaps with his piano lesson at 3:30 PM.',
    relatedEventIds: ["evt-dentist", "evt-piano"],
  },
  {
    id: "dig-1",
    kind: "daily",
    sentAt: daysAgo(1, 7, 30),
    text: "Good morning! Today: Yash has soccer practice at 5:30 PM, and family dinner is Friday at 6:30. Nothing else on the books.",
  },
  {
    id: "dig-2",
    kind: "announcement",
    sentAt: daysAgo(2, 14, 5),
    text: 'Added "Work trip — Denver" for Ekta, Wednesday through Friday.',
  },
  {
    id: "dig-3",
    kind: "daily",
    sentAt: daysAgo(2, 7, 30),
    text: "Good morning! Quiet day today — first thing on the calendar is guitar lesson at 4:30 PM.",
  },
  {
    id: "dig-4",
    kind: "weekly",
    sentAt: daysAgo(3, 18, 0),
    text: "This week: soccer Tue/Thu, guitar Wed, dentist + piano for Aman Tuesday afternoon (back-to-back — might be tight), family dinner Friday, and Theo's birthday party Saturday morning.",
  },
  {
    id: "dig-5",
    kind: "daily",
    sentAt: daysAgo(3, 7, 30),
    text: "Good morning! Nothing on the calendar before soccer practice this evening.",
  },
  {
    id: "dig-6",
    kind: "announcement",
    sentAt: daysAgo(4, 20, 44),
    text: 'Added "Theo\'s birthday party" for Yash — Saturday at 10:00 AM at Bounce House Austin.',
  },
  {
    id: "dig-7",
    kind: "daily",
    sentAt: daysAgo(5, 7, 30),
    text: "Good morning! Guitar lesson at 4:30, otherwise clear.",
  },
  {
    id: "dig-8",
    kind: "announcement",
    sentAt: daysAgo(6, 8, 0),
    text: "Reminder sent: Aman's orthodontist consult is in 24 hours (Thursday, 7:00 PM).",
  },
  {
    id: "dig-9",
    kind: "daily",
    sentAt: daysAgo(7, 7, 30),
    text: "Good morning! Soccer practice at 5:30 PM is the only thing today.",
  },
];

// Annotated on the `const` (with no trailing method call) so each object
// literal's string fields — "direction", "action.type" — narrow to their
// literal union types instead of widening to `string`. Recency sorting
// happens in the adapter (getActivity) at read time.
export const ACTIVITY: ActivityEntry[] = [
  {
    id: "act-0",
    direction: "inbound",
    sender: "Ekta",
    text: "Aman has dentist Tuesday 3pm",
    action: {
      type: "create_event",
      summary: 'Created "Dentist appointment" for Aman — Tue 3:00–4:00 PM',
      eventId: "evt-dentist",
    },
    createdAt: at(weekStart, 2, 9, 10),
  },
  {
    id: "act-1",
    direction: "outbound",
    sender: "Agent",
    text: "Got it — added Aman's dentist appointment for Tuesday at 3pm. Heads up, that overlaps with his piano lesson at 3:30.",
    action: {
      type: "flag_conflict",
      summary: "Flagged overlap with existing piano lesson",
      eventId: "evt-dentist",
    },
    createdAt: at(weekStart, 2, 9, 11),
  },
  {
    id: "act-2",
    direction: "inbound",
    sender: "Vijay",
    text: "can everyone make soccer thurs? want to grab food after",
    action: {
      type: "no_action",
      summary: "Informational message — no calendar change",
    },
    createdAt: daysAgo(1, 12, 40),
  },
  {
    id: "act-3",
    direction: "inbound",
    sender: "Ekta",
    text: "move family dinner friday to 6:30 instead of 6",
    action: {
      type: "update_event",
      summary: '"Family dinner" moved to 6:30 PM',
    },
    createdAt: daysAgo(1, 17, 5),
  },
  {
    id: "act-4",
    direction: "outbound",
    sender: "Agent",
    text: "Done — family dinner Friday is now 6:30 PM.",
    createdAt: daysAgo(1, 17, 5),
  },
  {
    id: "act-5",
    direction: "inbound",
    sender: "Ekta",
    text: "aman has ortho next thurs 7pm, quick consult",
    action: {
      type: "create_event",
      summary: 'Created "Orthodontist consult" — Thu 7:00–7:45 PM',
      eventId: "evt-ortho",
    },
    createdAt: daysAgo(2, 8, 22),
  },
  {
    id: "act-6",
    direction: "inbound",
    sender: "Vijay",
    text: "book something for the kiddo tomorrow at 2",
    action: {
      type: "needs_clarification",
      summary: "Asked which child and what the appointment is for",
    },
    createdAt: daysAgo(3, 21, 2),
  },
  {
    id: "act-7",
    direction: "outbound",
    sender: "Agent",
    text: "Quick check — is that for Aman or Yash, and what's the appointment? I don't want to guess and get it wrong.",
    createdAt: daysAgo(3, 21, 2),
  },
  {
    id: "act-8",
    direction: "inbound",
    sender: "Aman",
    text: "ITS ME! swim meet is on the 26th at 9am at the northwest rec center",
    action: {
      type: "create_event",
      summary: 'Created "Swim meet" for Aman — 9:00 AM–12:00 PM',
      eventId: "evt-swim",
    },
    createdAt: daysAgo(4, 16, 18),
  },
  {
    id: "act-9",
    direction: "outbound",
    sender: "Agent",
    text: "Reminder: Aman's orthodontist consult is tomorrow at 7:00 PM.",
    action: {
      type: "send_reminder",
      summary: "24-hour reminder sent to the group chat",
      eventId: "evt-ortho",
    },
    createdAt: daysAgo(6, 8, 0),
  },
  {
    id: "act-10",
    direction: "inbound",
    sender: "Ekta",
    text: "denver trip is actually wed-fri not thu-fri, can you fix it",
    action: {
      type: "update_event",
      summary: '"Work trip — Denver" dates corrected to Wed–Fri',
    },
    createdAt: daysAgo(6, 11, 30),
  },
  {
    id: "act-11",
    direction: "inbound",
    sender: "Vijay",
    text: "asdkfj ignore that last one, fat fingered the group chat",
    action: {
      type: "no_action",
      summary: "No calendar action — unrelated message",
    },
    createdAt: daysAgo(8, 22, 51),
  },
];

export const SETTINGS: Settings = {
  dailyDigestEnabled: true,
  dailyDigestTime: "07:30",
  weeklyDigestEnabled: true,
  weeklyDigestDay: "sunday",
  weeklyDigestTime: "18:00",
  reminderLeadHours: 24,
  timezone: TIMEZONE,
};
