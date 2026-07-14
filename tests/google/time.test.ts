import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  addCalendarDays,
  calendarDateToISO,
  formatNowForPrompt,
  getFamilyTimeZone,
  parseFlexibleISO,
  toCalendarDate,
} from "@/lib/google/time";

const TZ = "America/Chicago";

beforeEach(() => {
  vi.stubEnv("FAMILY_TZ", TZ);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// getFamilyTimeZone
// ---------------------------------------------------------------------------

describe("getFamilyTimeZone", () => {
  it("returns FAMILY_TZ when set", () => {
    expect(getFamilyTimeZone()).toBe("America/Chicago");
  });

  it("returns a different configured zone", () => {
    vi.stubEnv("FAMILY_TZ", "America/New_York");
    expect(getFamilyTimeZone()).toBe("America/New_York");
  });

  it("falls back to America/Chicago when FAMILY_TZ is unset", () => {
    vi.stubEnv("FAMILY_TZ", undefined as unknown as string);
    delete process.env.FAMILY_TZ;
    expect(getFamilyTimeZone()).toBe("America/Chicago");
  });

  it("falls back to America/Chicago when FAMILY_TZ is empty", () => {
    vi.stubEnv("FAMILY_TZ", "");
    expect(getFamilyTimeZone()).toBe("America/Chicago");
  });

  it("falls back to America/Chicago when FAMILY_TZ is only whitespace", () => {
    vi.stubEnv("FAMILY_TZ", "   ");
    expect(getFamilyTimeZone()).toBe("America/Chicago");
  });

  it("trims surrounding whitespace from a configured value", () => {
    vi.stubEnv("FAMILY_TZ", "  America/New_York  ");
    expect(getFamilyTimeZone()).toBe("America/New_York");
  });
});

// ---------------------------------------------------------------------------
// parseFlexibleISO
// ---------------------------------------------------------------------------

describe("parseFlexibleISO", () => {
  it("parses an absolute instant with an explicit negative offset as-is", () => {
    const d = parseFlexibleISO("2026-07-14T15:00:00-05:00");
    expect(d.toISOString()).toBe("2026-07-14T20:00:00.000Z");
  });

  it("parses an absolute instant with Z as-is", () => {
    const d = parseFlexibleISO("2026-07-14T20:00:00Z");
    expect(d.toISOString()).toBe("2026-07-14T20:00:00.000Z");
  });

  it("parses an absolute instant with a non-colon offset (+0500) as-is", () => {
    const d = parseFlexibleISO("2026-07-14T15:00:00+0500");
    expect(d.toISOString()).toBe("2026-07-14T10:00:00.000Z");
  });

  it("interprets a bare (offset-less) date-time as wall-clock time in FAMILY_TZ (summer, CDT -05:00)", () => {
    const d = parseFlexibleISO("2026-07-14T15:00:00");
    expect(d.toISOString()).toBe("2026-07-14T20:00:00.000Z");
  });

  it("interprets a bare date-time in FAMILY_TZ during standard time (CST -06:00)", () => {
    const d = parseFlexibleISO("2026-01-14T15:00:00");
    expect(d.toISOString()).toBe("2026-01-14T21:00:00.000Z");
  });

  it("respects an explicit tz argument over FAMILY_TZ", () => {
    // America/New_York is UTC-4 in July (EDT).
    const d = parseFlexibleISO("2026-07-14T15:00:00", "America/New_York");
    expect(d.toISOString()).toBe("2026-07-14T19:00:00.000Z");
  });

  it("throws on an unparseable string", () => {
    expect(() => parseFlexibleISO("not-a-date")).toThrow(/Invalid ISO 8601/);
  });

  it("treats a bare 'YYYY-MM-DD' with no time component as midnight in FAMILY_TZ (the zod schema in lib/agent/tools.ts doesn't strictly forbid this shape)", () => {
    const d = parseFlexibleISO("2026-07-14");
    expect(d.toISOString()).toBe("2026-07-14T05:00:00.000Z");
  });

  describe("America/Chicago DST spring-forward (2026-03-08, 2:00am -> 3:00am)", () => {
    it("parses the last valid instant just before the gap as CST (-06:00)", () => {
      const d = parseFlexibleISO("2026-03-08T01:59:00");
      expect(d.toISOString()).toBe("2026-03-08T07:59:00.000Z");
    });

    it("parses the first valid instant just after the gap as CDT (-05:00)", () => {
      const d = parseFlexibleISO("2026-03-08T03:00:00");
      expect(d.toISOString()).toBe("2026-03-08T08:00:00.000Z");
    });

    // Wall-clock times between 02:00 and 02:59:59 on this day never occur
    // (the clock jumps straight from 01:59:59 to 03:00:00). date-fns-tz
    // still returns a value for them rather than throwing — this pins down
    // *what* it returns so a regression is caught, not to bless it as
    // correct. See the "surprising DST behavior" finding in the QA report:
    // it resolves the nonexistent 02:30 as if the post-transition (CDT,
    // -05:00) offset already applied, i.e. the same UTC instant as a real
        // 02:30 CDT would have.
      it("documents its (library) behavior for a nonexistent local time inside the gap", () => {
      const d = parseFlexibleISO("2026-03-08T02:30:00");
      expect(d.toISOString()).toBe("2026-03-08T07:30:00.000Z");
    });
  });

  describe("America/Chicago DST fall-back (2026-11-01, 2:00am -> 1:00am)", () => {
    it("parses a time well before the fold as CDT (-05:00)", () => {
      const d = parseFlexibleISO("2026-11-01T00:59:00");
      expect(d.toISOString()).toBe("2026-11-01T05:59:00.000Z");
    });

    it("parses a time well after the fold as CST (-06:00)", () => {
      const d = parseFlexibleISO("2026-11-01T02:30:00");
      expect(d.toISOString()).toBe("2026-11-01T08:30:00.000Z");
    });

    // 01:00-01:59:59 occurs twice on this day (once in CDT, once in CST).
    // Pinning down which occurrence the library resolves to matters because
    // an event genuinely scheduled for "1:30am" on this date is ambiguous
    // for a human too, but the code must still be deterministic.
    it("documents its (library) behavior for an ambiguous (repeated) local time — resolves to the earlier/DST occurrence", () => {
      const d = parseFlexibleISO("2026-11-01T01:30:00");
      expect(d.toISOString()).toBe("2026-11-01T06:30:00.000Z"); // -05:00 (CDT), the *first* 1:30am
    });
  });
});

// ---------------------------------------------------------------------------
// toCalendarDate
// ---------------------------------------------------------------------------

describe("toCalendarDate", () => {
  it("returns the FAMILY_TZ calendar day for a mid-day UTC instant", () => {
    expect(toCalendarDate("2026-07-14T18:00:00Z")).toBe("2026-07-14");
  });

  it("rolls back a day just before local midnight (UTC boundary in summer, CDT -05:00)", () => {
    // 2026-07-14T04:59:00Z == 2026-07-13T23:59:00 CDT
    expect(toCalendarDate("2026-07-14T04:59:00Z")).toBe("2026-07-13");
  });

  it("rolls forward at exactly local midnight (UTC boundary in summer, CDT -05:00)", () => {
    // 2026-07-14T05:00:00Z == 2026-07-14T00:00:00 CDT
    expect(toCalendarDate("2026-07-14T05:00:00Z")).toBe("2026-07-14");
  });

  it("handles the year boundary correctly (Dec 31 -> Jan 1 in FAMILY_TZ, CST -06:00)", () => {
    expect(toCalendarDate("2026-01-01T05:59:00Z")).toBe("2025-12-31");
    expect(toCalendarDate("2026-01-01T06:00:00Z")).toBe("2026-01-01");
  });

  it("handles a month boundary (Jan 31 -> Feb 1 in FAMILY_TZ)", () => {
    expect(toCalendarDate("2026-02-01T05:59:00Z")).toBe("2026-01-31");
    expect(toCalendarDate("2026-02-01T06:00:00Z")).toBe("2026-02-01");
  });
});

// ---------------------------------------------------------------------------
// addCalendarDays
// ---------------------------------------------------------------------------

describe("addCalendarDays", () => {
  it("adds a positive number of days", () => {
    expect(addCalendarDays("2026-07-14", 1)).toBe("2026-07-15");
  });

  it("subtracts with a negative number of days", () => {
    expect(addCalendarDays("2026-07-14", -1)).toBe("2026-07-13");
  });

  it("crosses a month boundary", () => {
    expect(addCalendarDays("2026-01-31", 1)).toBe("2026-02-01");
  });

  it("crosses a year boundary", () => {
    expect(addCalendarDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("handles a leap-year February correctly (2028 is a leap year)", () => {
    expect(addCalendarDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addCalendarDays("2028-02-29", 1)).toBe("2028-03-01");
  });

  it("does NOT treat 2026 as a leap year (Feb 28 -> Mar 1 directly)", () => {
    expect(addCalendarDays("2026-02-28", 1)).toBe("2026-03-01");
  });

  it("is pure date-only math, unaffected by DST (adding across the spring-forward day)", () => {
    expect(addCalendarDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(addCalendarDays("2026-03-08", 1)).toBe("2026-03-09");
  });
});

// ---------------------------------------------------------------------------
// calendarDateToISO
// ---------------------------------------------------------------------------

describe("calendarDateToISO", () => {
  it("converts a calendar date to midnight FAMILY_TZ, in summer (CDT -05:00)", () => {
    expect(calendarDateToISO("2026-07-14")).toBe("2026-07-14T05:00:00.000Z");
  });

  it("converts a calendar date to midnight FAMILY_TZ, in winter (CST -06:00)", () => {
    expect(calendarDateToISO("2026-01-14")).toBe("2026-01-14T06:00:00.000Z");
  });

  it("round-trips through toCalendarDate for an ordinary date", () => {
    const iso = calendarDateToISO("2026-07-14");
    expect(toCalendarDate(iso)).toBe("2026-07-14");
  });

  it("round-trips through toCalendarDate across a year boundary", () => {
    const iso = calendarDateToISO("2026-12-31");
    expect(toCalendarDate(iso)).toBe("2026-12-31");
  });

  describe("all-day exclusive-end boundary across DST transitions (docs/agent-core.md §1 all-day convention)", () => {
    it("a one-day all-day event on the spring-forward date is only 23h wide in UTC (the 'missing hour'), not 24h", () => {
      // A one-day all-day event on 2026-03-08 (the spring-forward date) has
      // startISO = calendarDateToISO("2026-03-08") and, per the exclusive-end
      // convention, endISO = calendarDateToISO(addCalendarDays("2026-03-08", 1)).
      // Local midnight-to-midnight is always "24 hours of wall clock" but NOT
      // always 24 hours of elapsed UTC time when a DST transition falls
      // inside the span — this is expected/correct, but worth pinning down
      // explicitly since it's exactly the kind of off-by-one-hour surprise
      // this test suite exists to catch.
      const start = calendarDateToISO("2026-03-08");
      const end = calendarDateToISO(addCalendarDays("2026-03-08", 1));
      const hours = (new Date(end).getTime() - new Date(start).getTime()) / (60 * 60 * 1000);
      expect(hours).toBe(23);
    });

    it("a one-day all-day event on the fall-back date is 25h wide in UTC (the 'extra hour')", () => {
      const start = calendarDateToISO("2026-11-01");
      const end = calendarDateToISO(addCalendarDays("2026-11-01", 1));
      const hours = (new Date(end).getTime() - new Date(start).getTime()) / (60 * 60 * 1000);
      expect(hours).toBe(25);
    });

    it("a one-day all-day event on an ordinary date is exactly 24h wide in UTC", () => {
      const start = calendarDateToISO("2026-07-14");
      const end = calendarDateToISO(addCalendarDays("2026-07-14", 1));
      const hours = (new Date(end).getTime() - new Date(start).getTime()) / (60 * 60 * 1000);
      expect(hours).toBe(24);
    });
  });
});

// ---------------------------------------------------------------------------
// formatNowForPrompt
// ---------------------------------------------------------------------------

describe("formatNowForPrompt", () => {
  it("formats the current time in FAMILY_TZ with the summer (CDT) abbreviation", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T19:30:00Z"));
    expect(formatNowForPrompt()).toBe("Monday, July 13, 2026 at 2:30 PM (CDT)");
  });

  it("formats the current time in FAMILY_TZ with the winter (CST) abbreviation", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-13T19:30:00Z"));
    expect(formatNowForPrompt()).toBe("Tuesday, January 13, 2026 at 1:30 PM (CST)");
  });

  it("respects an explicit tz argument over FAMILY_TZ", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T19:30:00Z"));
    expect(formatNowForPrompt("America/New_York")).toBe("Monday, July 13, 2026 at 3:30 PM (EDT)");
  });
});
