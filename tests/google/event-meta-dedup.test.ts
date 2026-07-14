import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// This suite exercises the REAL announce/reminder dedup functions from
// lib/google/events.ts (listPendingAnnouncements, markAnnounced,
// listUpcomingEventsPendingReminder, markReminded) — the functions
// docs/agent-core.md §3 says are the entire dedup contract: "announced_at IS
// NULL is the entire queue; markAnnounced sets it, so a repeated sweep finds
// nothing left to send."
//
// Rather than reimplementing the dedup predicate as a standalone helper (no
// such pure function exists — the predicate is inline inside the drizzle
// query), we swap the Postgres wire for an in-memory fake: getDb() is mocked
// to return a hand-rolled query builder that interprets the *real*
// eq/isNull/inArray calls lib/google/events.ts makes (drizzle-orm's real
// operators are mocked to return small tagged descriptors instead of SQL AST
// nodes) against a plain in-memory array of event_meta-shaped rows. This
// means the actual production dedup logic runs in every test below — only
// the database is fake.
//
// listUpcomingEventsPendingReminder also calls listEvents() *within the same
// module*, so lib/google/client.ts (not lib/google/events.ts) is the mock
// boundary for that path — an intra-module call can't be intercepted by
// mocking the module's own exports.
// ---------------------------------------------------------------------------

interface FakeEventMetaRow {
  googleEventId: string;
  memberIds: string[];
  createdVia: "imessage" | "dashboard" | "calendar_app";
  announcedAt: Date | null;
  remindedAt: Date | null;
}

const state = vi.hoisted(() => ({
  rows: [] as FakeEventMetaRow[],
  calendarEvents: [] as unknown[],
  listCalls: [] as Array<{ timeMin?: string; timeMax?: string }>,
}));

vi.mock("drizzle-orm", () => ({
  eq: (column: unknown, value: unknown) => ({ op: "eq" as const, column, value }),
  isNull: (column: unknown) => ({ op: "isNull" as const, column }),
  inArray: (column: unknown, values: unknown[]) => ({ op: "inArray" as const, column, values }),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => {
    // Resolves which event_meta field a drizzle column reference (e.g.
    // eventMeta.announcedAt) is about, by identity against the real,
    // un-mocked lib/db/schema module's `eventMeta` export (imported below —
    // referencing an imported binding from inside a vi.mock factory is
    // supported; this closure isn't invoked until an actual query runs at
    // test-run time, well after that import has resolved).
    function columnKey(column: unknown): keyof FakeEventMetaRow {
      const entry = Object.entries(eventMeta).find(([, col]) => col === column);
      if (!entry) throw new Error("fake db: unrecognized column reference in condition");
      return entry[0] as keyof FakeEventMetaRow;
    }
    function matches(row: FakeEventMetaRow, cond: unknown): boolean {
      if (!cond) return true;
      const c = cond as { op: string; column: unknown; value?: unknown; values?: unknown[] };
      const key = columnKey(c.column);
      if (c.op === "eq") return row[key] === c.value;
      if (c.op === "isNull") return row[key] == null;
      if (c.op === "inArray") return (c.values ?? []).includes(row[key] as never);
      throw new Error(`fake db: unhandled condition op ${c.op}`);
    }
    return {
      select(projection: Record<string, unknown>) {
        return {
          from() {
            return {
              where(cond: unknown) {
                const matched = state.rows.filter((r) => matches(r, cond));
                return Promise.resolve(
                  matched.map((r) => {
                    const out: Record<string, unknown> = {};
                    for (const [outKey, col] of Object.entries(projection)) {
                      out[outKey] = r[columnKey(col)];
                    }
                    return out;
                  }),
                );
              },
            };
          },
        };
      },
      update() {
        return {
          set(patch: Partial<FakeEventMetaRow>) {
            return {
              where(cond: unknown) {
                for (const r of state.rows) {
                  if (matches(r, cond)) Object.assign(r, patch);
                }
                return Promise.resolve();
              },
            };
          },
        };
      },
    };
  },
}));

vi.mock("@/lib/google/client", () => ({
  getCalendarClient: () => ({
    events: {
      list: (args: { timeMin?: string; timeMax?: string }) => {
        state.listCalls.push({ timeMin: args.timeMin, timeMax: args.timeMax });
        return Promise.resolve({ data: { items: state.calendarEvents } });
      },
    },
  }),
  getFamilyCalendarId: () => "family-calendar-id",
}));

// Imported AFTER the mocks above so the module under test picks them up.
// eventMeta's column objects must be the same identities lib/google/events.ts
// sees (it imports the same, un-mocked lib/db/schema module), so we can map
// "which column is this condition about" by reference equality.
import { eventMeta } from "@/lib/db/schema";
import {
  listPendingAnnouncements,
  markAnnounced,
  listUpcomingEventsPendingReminder,
  markReminded,
} from "@/lib/google/events";

function seedRow(row: Partial<FakeEventMetaRow> & { googleEventId: string }) {
  state.rows.push({
    memberIds: [],
    createdVia: "dashboard",
    announcedAt: null,
    remindedAt: null,
    ...row,
  });
}

function makeTimedGoogleEvent(id: string, startISO: string, endISO: string, memberIds: string[] = ["m1"]) {
  return {
    id,
    summary: id,
    start: { dateTime: startISO },
    end: { dateTime: endISO },
    extendedProperties: {
      private: { luthcalMemberIds: JSON.stringify(memberIds), luthcalCreatedVia: "imessage" },
    },
  };
}

function makeAllDayGoogleEvent(id: string, startDate: string, endDateExclusive: string, memberIds: string[] = ["m1"]) {
  return {
    id,
    summary: id,
    start: { date: startDate },
    end: { date: endDateExclusive },
    extendedProperties: {
      private: { luthcalMemberIds: JSON.stringify(memberIds), luthcalCreatedVia: "calendar_app" },
    },
  };
}

beforeEach(() => {
  vi.stubEnv("FAMILY_TZ", "America/Chicago");
  state.rows = [];
  state.calendarEvents = [];
  state.listCalls = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Announcement dedup
// ---------------------------------------------------------------------------

describe("announcement dedup (listPendingAnnouncements / markAnnounced)", () => {
  it("only returns rows with announced_at IS NULL", async () => {
    seedRow({ googleEventId: "evt-pending", announcedAt: null, createdVia: "dashboard" });
    seedRow({ googleEventId: "evt-already-announced", announcedAt: new Date("2026-07-01T00:00:00Z"), createdVia: "imessage" });

    const pending = await listPendingAnnouncements();

    expect(pending).toHaveLength(1);
    expect(pending[0].googleEventId).toBe("evt-pending");
  });

  it("a second sweep after markAnnounced sends nothing — the core dedup contract", async () => {
    seedRow({ googleEventId: "evt-1", announcedAt: null, createdVia: "dashboard" });

    const firstSweep = await listPendingAnnouncements();
    expect(firstSweep.map((r) => r.googleEventId)).toEqual(["evt-1"]);

    for (const row of firstSweep) {
      await markAnnounced(row.googleEventId);
    }

    const secondSweep = await listPendingAnnouncements();
    expect(secondSweep).toEqual([]);
  });

  it("markAnnounced on an id with no matching row is a harmless no-op (mirrors a real UPDATE...WHERE with zero matches)", async () => {
    await expect(markAnnounced("does-not-exist")).resolves.toBeUndefined();
  });

  it("redelivering the same webhook (calling markAnnounced twice for the same event) is idempotent", async () => {
    seedRow({ googleEventId: "evt-1", announcedAt: null, createdVia: "dashboard" });

    await markAnnounced("evt-1");
    const afterFirst = state.rows.find((r) => r.googleEventId === "evt-1")!.announcedAt;
    await markAnnounced("evt-1"); // simulates a redelivered/duplicate sweep tick
    const afterSecond = state.rows.find((r) => r.googleEventId === "evt-1")!.announcedAt;

    expect(afterFirst).toBeInstanceOf(Date);
    expect(afterSecond).toBeInstanceOf(Date);
    expect(await listPendingAnnouncements()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Reminder dedup
// ---------------------------------------------------------------------------

describe("reminder dedup (listUpcomingEventsPendingReminder / markReminded)", () => {
  it("includes a timed event starting within the window, excludes ones outside it or already in progress", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T18:00:00.000Z")); // 1:00 PM CDT

    state.calendarEvents = [
      makeTimedGoogleEvent("starting-soon", "2026-07-13T18:30:00.000Z", "2026-07-13T19:00:00.000Z"), // +30min: in window
      makeTimedGoogleEvent("too-far-out", "2026-07-13T23:00:00.000Z", "2026-07-13T23:30:00.000Z"), // +5h: outside a 2h window
      makeTimedGoogleEvent("already-in-progress", "2026-07-13T17:00:00.000Z", "2026-07-13T19:00:00.000Z"), // started an hour ago
      makeAllDayGoogleEvent("allday-today", "2026-07-13", "2026-07-14"), // starts today in FAMILY_TZ
      makeAllDayGoogleEvent("allday-in-progress", "2026-07-12", "2026-07-15"), // multi-day trip already underway
    ];
    seedRow({ googleEventId: "starting-soon", announcedAt: new Date(), remindedAt: null });
    seedRow({ googleEventId: "too-far-out", announcedAt: new Date(), remindedAt: null });
    seedRow({ googleEventId: "already-in-progress", announcedAt: new Date(), remindedAt: null });
    seedRow({ googleEventId: "allday-today", announcedAt: new Date(), remindedAt: null });
    seedRow({ googleEventId: "allday-in-progress", announcedAt: new Date(), remindedAt: null });

    const pending = await listUpcomingEventsPendingReminder(2 * 60 * 60 * 1000); // 2h window
    const ids = pending.map((e) => e.id).sort();

    expect(ids).toEqual(["allday-today", "starting-soon"]);
  });

  it("a second sweep after markReminded sends nothing — the core dedup contract", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T18:00:00.000Z"));

    state.calendarEvents = [makeTimedGoogleEvent("evt-r1", "2026-07-13T18:30:00.000Z", "2026-07-13T19:00:00.000Z")];
    seedRow({ googleEventId: "evt-r1", announcedAt: new Date(), remindedAt: null });

    const firstSweep = await listUpcomingEventsPendingReminder(2 * 60 * 60 * 1000);
    expect(firstSweep.map((e) => e.id)).toEqual(["evt-r1"]);

    for (const event of firstSweep) {
      await markReminded(event.id);
    }

    const secondSweep = await listUpcomingEventsPendingReminder(2 * 60 * 60 * 1000);
    expect(secondSweep).toEqual([]);
  });

  it("excludes an event already marked reminded even on the very first call (e.g. after a prior partial sweep)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T18:00:00.000Z"));

    state.calendarEvents = [makeTimedGoogleEvent("evt-already-reminded", "2026-07-13T18:30:00.000Z", "2026-07-13T19:00:00.000Z")];
    seedRow({ googleEventId: "evt-already-reminded", announcedAt: new Date(), remindedAt: new Date("2026-07-13T17:00:00Z") });

    const pending = await listUpcomingEventsPendingReminder(2 * 60 * 60 * 1000);
    expect(pending).toEqual([]);
  });

  it("returns [] immediately (no DB round trip) when nothing is starting soon", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T18:00:00.000Z"));
    state.calendarEvents = [];

    const pending = await listUpcomingEventsPendingReminder(2 * 60 * 60 * 1000);
    expect(pending).toEqual([]);
  });
});
