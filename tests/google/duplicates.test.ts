import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LuthEvent } from "@/lib/google/types";

// findNearDuplicateEvent (lib/google/duplicates.ts) is built on top of
// checkConflicts, which itself fetches candidate events via
// lib/google/events.ts's listEvents — mock at that module boundary so both
// checkConflicts' overlap math AND findNearDuplicateEvent's own
// title/member-set matching run for real.
vi.mock("@/lib/google/events", () => ({
  listEvents: vi.fn(),
}));

import { listEvents } from "@/lib/google/events";
import { findNearDuplicateEvent } from "@/lib/google/duplicates";

const listEventsMock = vi.mocked(listEvents);

const M1 = "member-1";
const M2 = "member-2";

beforeEach(() => {
  vi.stubEnv("FAMILY_TZ", "America/Chicago");
  listEventsMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function existing(id: string, title: string, startISO: string, endISO: string, memberIds: string[], allDay = false): LuthEvent {
  return { id, title, start: startISO, end: endISO, allDay, memberIds };
}

// ---------------------------------------------------------------------------
// BUG 3: a user re-asked for the same event (Apple Calendar sync lag) and
// the agent silently created a second, identical event. findNearDuplicateEvent
// is the deterministic pre-check createEvent's tool now runs first — see
// lib/google/duplicates.ts's own doc comment for the precise "near-identical"
// definition under test below.
// ---------------------------------------------------------------------------

describe("findNearDuplicateEvent", () => {
  it("flags an exact repeat — same title, same time, same member", async () => {
    listEventsMock.mockResolvedValue([
      existing("evt-1", "World Cup Party", "2026-07-18T19:00:00.000Z", "2026-07-18T22:00:00.000Z", [M1]),
    ]);

    const duplicate = await findNearDuplicateEvent({
      title: "World Cup Party",
      startISO: "2026-07-18T19:00:00.000Z",
      endISO: "2026-07-18T22:00:00.000Z",
      memberIds: [M1],
    });

    expect(duplicate?.id).toBe("evt-1");
  });

  it("title match is case-insensitive and ignores surrounding/collapsed whitespace", async () => {
    listEventsMock.mockResolvedValue([
      existing("evt-1", "World   Cup Party", "2026-07-18T19:00:00.000Z", "2026-07-18T22:00:00.000Z", [M1]),
    ]);

    const duplicate = await findNearDuplicateEvent({
      title: "  world cup party  ",
      startISO: "2026-07-18T19:00:00.000Z",
      endISO: "2026-07-18T22:00:00.000Z",
      memberIds: [M1],
    });

    expect(duplicate?.id).toBe("evt-1");
  });

  it("does NOT flag a different title, even at the identical time/member (a real conflict, not a duplicate)", async () => {
    listEventsMock.mockResolvedValue([
      existing("evt-1", "Dentist", "2026-07-18T19:00:00.000Z", "2026-07-18T20:00:00.000Z", [M1]),
    ]);

    const duplicate = await findNearDuplicateEvent({
      title: "Haircut",
      startISO: "2026-07-18T19:00:00.000Z",
      endISO: "2026-07-18T20:00:00.000Z",
      memberIds: [M1],
    });

    expect(duplicate).toBeUndefined();
  });

  it("does NOT flag the same title/time for a different member (not the same event)", async () => {
    listEventsMock.mockResolvedValue([existing("evt-1", "Dentist", "2026-07-18T19:00:00.000Z", "2026-07-18T20:00:00.000Z", [M2])]);

    const duplicate = await findNearDuplicateEvent({
      title: "Dentist",
      startISO: "2026-07-18T19:00:00.000Z",
      endISO: "2026-07-18T20:00:00.000Z",
      memberIds: [M1],
    });

    expect(duplicate).toBeUndefined();
  });

  it("does NOT flag when the member SET differs, even with one shared member (adding a person is a distinct event)", async () => {
    listEventsMock.mockResolvedValue([existing("evt-1", "Dentist", "2026-07-18T19:00:00.000Z", "2026-07-18T20:00:00.000Z", [M1])]);

    const duplicate = await findNearDuplicateEvent({
      title: "Dentist",
      startISO: "2026-07-18T19:00:00.000Z",
      endISO: "2026-07-18T20:00:00.000Z",
      memberIds: [M1, M2],
    });

    expect(duplicate).toBeUndefined();
  });

  it("does NOT flag a same-title event that doesn't overlap in time", async () => {
    listEventsMock.mockResolvedValue([existing("evt-1", "Dentist", "2026-07-18T19:00:00.000Z", "2026-07-18T20:00:00.000Z", [M1])]);

    const duplicate = await findNearDuplicateEvent({
      title: "Dentist",
      startISO: "2026-07-25T19:00:00.000Z",
      endISO: "2026-07-25T20:00:00.000Z",
      memberIds: [M1],
    });

    expect(duplicate).toBeUndefined();
  });

  it("does NOT flag across an all-day/timed mismatch, even with a matching title/member", async () => {
    listEventsMock.mockResolvedValue([
      existing("evt-1", "Spring Break", "2026-07-18T05:00:00.000Z", "2026-07-19T05:00:00.000Z", [M1], true),
    ]);

    const duplicate = await findNearDuplicateEvent({
      title: "Spring Break",
      startISO: "2026-07-18T14:00:00.000Z",
      endISO: "2026-07-18T15:00:00.000Z",
      memberIds: [M1],
      allDay: false,
    });

    expect(duplicate).toBeUndefined();
  });

  it("flags two overlapping (not just identical) all-day events with the same title/member", async () => {
    listEventsMock.mockResolvedValue([
      existing("evt-1", "Family Trip", "2026-07-18T05:00:00.000Z", "2026-07-21T05:00:00.000Z", [M1], true),
    ]);

    const duplicate = await findNearDuplicateEvent({
      title: "Family Trip",
      startISO: "2026-07-19T05:00:00.000Z",
      endISO: "2026-07-22T05:00:00.000Z",
      memberIds: [M1],
      allDay: true,
    });

    expect(duplicate?.id).toBe("evt-1");
  });

  it("returns undefined (and skips the query) when the candidate has no members", async () => {
    const duplicate = await findNearDuplicateEvent({
      title: "Dentist",
      startISO: "2026-07-18T19:00:00.000Z",
      endISO: "2026-07-18T20:00:00.000Z",
      memberIds: [],
    });

    expect(duplicate).toBeUndefined();
    expect(listEventsMock).not.toHaveBeenCalled();
  });

  it("returns undefined when nothing overlaps at all", async () => {
    listEventsMock.mockResolvedValue([]);
    const duplicate = await findNearDuplicateEvent({
      title: "Dentist",
      startISO: "2026-07-18T19:00:00.000Z",
      endISO: "2026-07-18T20:00:00.000Z",
      memberIds: [M1],
    });
    expect(duplicate).toBeUndefined();
  });
});
