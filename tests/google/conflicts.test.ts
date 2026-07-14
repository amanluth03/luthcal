import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LuthEvent } from "@/lib/google/types";

// checkConflicts (lib/google/conflicts.ts) fetches candidate events via
// lib/google/events.ts's listEvents — mock at that module boundary so the
// overlap math under test runs for real, without touching googleapis.
vi.mock("@/lib/google/events", () => ({
  listEvents: vi.fn(),
}));

import { listEvents } from "@/lib/google/events";
import { checkConflicts } from "@/lib/google/conflicts";
import { conflictsFor, findConflictingEventIds } from "@/lib/mock/conflicts";

const listEventsMock = vi.mocked(listEvents);

const TZ = "America/Chicago";
const M1 = "member-1";
const M2 = "member-2";
const M3 = "member-3";

beforeEach(() => {
  vi.stubEnv("FAMILY_TZ", TZ);
  // vitest.config.ts's restoreMocks only restores vi.spyOn-backed mocks;
  // this listEvents mock is a plain vi.fn() from the vi.mock factory above,
  // so its call history has to be cleared explicitly between tests.
  listEventsMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function timed(id: string, startISO: string, endISO: string, memberIds: string[]): LuthEvent {
  return { id, title: id, start: startISO, end: endISO, allDay: false, memberIds };
}

function allDay(id: string, startISO: string, endISO: string, memberIds: string[]): LuthEvent {
  return { id, title: id, start: startISO, end: endISO, allDay: true, memberIds };
}

// ---------------------------------------------------------------------------
// checkConflicts (the real implementation)
// ---------------------------------------------------------------------------

describe("checkConflicts", () => {
  it("flags an overlapping timed pair that shares a member", async () => {
    const other = timed("other", "2026-07-14T15:30:00.000Z", "2026-07-14T16:30:00.000Z", [M1]);
    listEventsMock.mockResolvedValue([other]);

    const matches = await checkConflicts({
      startISO: "2026-07-14T15:00:00.000Z",
      endISO: "2026-07-14T16:00:00.000Z",
      memberIds: [M1],
    });

    expect(matches).toHaveLength(1);
    expect(matches[0].event.id).toBe("other");
    expect(matches[0].memberIds).toEqual([M1]);
  });

  it("does NOT flag events that merely touch at the boundary (end == other.start)", async () => {
    // Candidate 15:00-16:00, other event starts exactly at 16:00.
    const other = timed("other", "2026-07-14T16:00:00.000Z", "2026-07-14T17:00:00.000Z", [M1]);
    listEventsMock.mockResolvedValue([other]);

    const matches = await checkConflicts({
      startISO: "2026-07-14T15:00:00.000Z",
      endISO: "2026-07-14T16:00:00.000Z",
      memberIds: [M1],
    });

    expect(matches).toEqual([]);
  });

  it("does NOT flag events that touch at the other boundary (candidate.start == other.end)", async () => {
    const other = timed("other", "2026-07-14T14:00:00.000Z", "2026-07-14T15:00:00.000Z", [M1]);
    listEventsMock.mockResolvedValue([other]);

    const matches = await checkConflicts({
      startISO: "2026-07-14T15:00:00.000Z",
      endISO: "2026-07-14T16:00:00.000Z",
      memberIds: [M1],
    });

    expect(matches).toEqual([]);
  });

  it("does NOT flag an overlap across different family members", async () => {
    const other = timed("other", "2026-07-14T15:15:00.000Z", "2026-07-14T15:45:00.000Z", [M2]);
    listEventsMock.mockResolvedValue([other]);

    const matches = await checkConflicts({
      startISO: "2026-07-14T15:00:00.000Z",
      endISO: "2026-07-14T16:00:00.000Z",
      memberIds: [M1],
    });

    expect(matches).toEqual([]);
  });

  it("flags when at least one member is shared, even if member sets aren't identical, and reports only the shared subset", async () => {
    const other = timed("other", "2026-07-14T15:15:00.000Z", "2026-07-14T15:45:00.000Z", [M2, M3]);
    listEventsMock.mockResolvedValue([other]);

    const matches = await checkConflicts({
      startISO: "2026-07-14T15:00:00.000Z",
      endISO: "2026-07-14T16:00:00.000Z",
      memberIds: [M1, M2],
    });

    expect(matches).toHaveLength(1);
    expect(matches[0].memberIds).toEqual([M2]);
  });

  it("an all-day candidate never conflicts with an overlapping timed event", async () => {
    const timedOther = timed("timed-other", "2026-07-14T15:00:00.000Z", "2026-07-14T16:00:00.000Z", [M1]);
    listEventsMock.mockResolvedValue([timedOther]);

    const matches = await checkConflicts({
      startISO: "2026-07-14T05:00:00.000Z", // midnight CDT July 14
      endISO: "2026-07-15T05:00:00.000Z", // midnight CDT July 15 (exclusive end)
      memberIds: [M1],
      allDay: true,
    });

    expect(matches).toEqual([]);
  });

  it("a timed candidate never conflicts with an overlapping all-day event (the reverse direction)", async () => {
    const allDayOther = allDay("allday-other", "2026-07-14T05:00:00.000Z", "2026-07-15T05:00:00.000Z", [M1]);
    listEventsMock.mockResolvedValue([allDayOther]);

    const matches = await checkConflicts({
      startISO: "2026-07-14T15:00:00.000Z",
      endISO: "2026-07-14T16:00:00.000Z",
      memberIds: [M1],
      allDay: false,
    });

    expect(matches).toEqual([]);
  });

  it("flags two overlapping all-day events for the same member", async () => {
    const other = allDay("allday-other", "2026-07-14T05:00:00.000Z", "2026-07-16T05:00:00.000Z", [M1]);
    listEventsMock.mockResolvedValue([other]);

    const matches = await checkConflicts({
      startISO: "2026-07-14T05:00:00.000Z",
      endISO: "2026-07-15T05:00:00.000Z",
      memberIds: [M1],
      allDay: true,
    });

    expect(matches).toHaveLength(1);
    expect(matches[0].event.id).toBe("allday-other");
  });

  it("does NOT flag two all-day events on adjacent (non-overlapping) days", async () => {
    // Exclusive-end convention: an all-day event on the 14th has end = 15th.
    // An all-day event starting on the 15th does not overlap it.
    const other = allDay("allday-next-day", "2026-07-15T05:00:00.000Z", "2026-07-16T05:00:00.000Z", [M1]);
    listEventsMock.mockResolvedValue([other]);

    const matches = await checkConflicts({
      startISO: "2026-07-14T05:00:00.000Z",
      endISO: "2026-07-15T05:00:00.000Z",
      memberIds: [M1],
      allDay: true,
    });

    expect(matches).toEqual([]);
  });

  it("excludeGoogleEventId lets an event's own row be omitted from its update conflict-check", async () => {
    const self = timed("evt-x", "2026-07-14T15:00:00.000Z", "2026-07-14T16:00:00.000Z", [M1]);
    const other = timed("evt-y", "2026-07-14T15:30:00.000Z", "2026-07-14T16:30:00.000Z", [M1]);
    listEventsMock.mockResolvedValue([self, other]);

    const withExclude = await checkConflicts({
      startISO: self.start,
      endISO: self.end,
      memberIds: [M1],
      excludeGoogleEventId: "evt-x",
    });
    expect(withExclude.map((m) => m.event.id)).toEqual(["evt-y"]);

    // Sanity: without the exclude, the same query would (correctly) also
    // flag the event against its own pre-update row, which is exactly why
    // callers must pass excludeGoogleEventId on an update.
    const withoutExclude = await checkConflicts({
      startISO: self.start,
      endISO: self.end,
      memberIds: [M1],
    });
    expect(withoutExclude.map((m) => m.event.id).sort()).toEqual(["evt-x", "evt-y"]);
  });

  it("widens the query window by 24h on each side of the candidate range", async () => {
    listEventsMock.mockResolvedValue([]);

    await checkConflicts({
      startISO: "2026-07-14T15:00:00.000Z",
      endISO: "2026-07-14T16:00:00.000Z",
      memberIds: [M1],
    });

    expect(listEventsMock).toHaveBeenCalledTimes(1);
    const call = listEventsMock.mock.calls[0][0];
    expect(call.startISO).toBe("2026-07-13T15:00:00.000Z"); // candidate start - 24h
    expect(call.endISO).toBe("2026-07-15T16:00:00.000Z"); // candidate end + 24h
  });

  it("returns no conflicts when no candidate events are returned", async () => {
    listEventsMock.mockResolvedValue([]);
    const matches = await checkConflicts({
      startISO: "2026-07-14T15:00:00.000Z",
      endISO: "2026-07-14T16:00:00.000Z",
      memberIds: [M1],
    });
    expect(matches).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Mock/real parity: lib/mock/conflicts.ts must agree with
// lib/google/conflicts.ts on every case above. Run the same fixture set
// through both and assert they reach the same conclusion.
// ---------------------------------------------------------------------------

describe("lib/mock/conflicts.ts agrees with lib/google/conflicts.ts", () => {
  const fixture: LuthEvent[] = [
    timed("timed-a", "2026-07-14T15:00:00.000Z", "2026-07-14T16:00:00.000Z", [M1]),
    timed("timed-b-overlap", "2026-07-14T15:30:00.000Z", "2026-07-14T16:00:00.000Z", [M1]), // overlaps A; touches (not overlaps) C
    timed("timed-c-touch", "2026-07-14T16:00:00.000Z", "2026-07-14T17:00:00.000Z", [M1]), // touches A and B at boundary only
    timed("timed-d-diff-member", "2026-07-14T15:15:00.000Z", "2026-07-14T15:45:00.000Z", [M2]), // overlaps A in time, different member
    allDay("allday-e", "2026-07-14T05:00:00.000Z", "2026-07-15T05:00:00.000Z", [M1]),
    allDay("allday-f-overlap", "2026-07-14T05:00:00.000Z", "2026-07-16T05:00:00.000Z", [M1]), // overlaps E
    timed("timed-g-same-window-as-e", "2026-07-14T18:00:00.000Z", "2026-07-14T19:00:00.000Z", [M1]), // same member/day as allday-e, but timed vs all-day
  ];

  // Ground truth per the canonical rule, computed by hand from the fixture
  // above (see comments next to each event; verified independently with a
  // throwaway script before writing this down — see QA report).
  const expectedConflictIds = new Set(["timed-a", "timed-b-overlap", "allday-e", "allday-f-overlap"]);

  it("lib/mock/conflicts.ts findConflictingEventIds matches the hand-derived expectation", () => {
    const ids = findConflictingEventIds(fixture);
    expect(ids).toEqual(expectedConflictIds);
  });

  it("lib/google/conflicts.ts checkConflicts agrees with lib/mock/conflicts.ts for every fixture event", async () => {
    for (const candidate of fixture) {
      listEventsMock.mockResolvedValue(fixture);
      const real = await checkConflicts({
        startISO: candidate.start,
        endISO: candidate.end,
        memberIds: candidate.memberIds,
        allDay: candidate.allDay,
        excludeGoogleEventId: candidate.id,
      });
      const mock = conflictsFor(candidate, fixture);

      const realIds = real.map((m) => m.event.id).sort();
      const mockIds = mock.map((e) => e.id).sort();
      expect(realIds, `mismatch for candidate ${candidate.id}`).toEqual(mockIds);
    }
  });
});
