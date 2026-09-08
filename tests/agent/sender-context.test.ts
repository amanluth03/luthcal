import { describe, expect, it } from "vitest";

import type { RosterMember } from "@/lib/agent/match-member";
import { describeSender } from "@/lib/agent/sender-context";

// The system prompt names who sent the message being answered so that
// first-person references ("add a dentist appointment for me") resolve to
// the sender instead of being treated as ambiguous.

const roster: RosterMember[] = [
  { id: "m-aman", name: "Aman", aliases: ["Aman"] },
  { id: "m-ekta", name: "Ekta", aliases: ["Ekta", "Mom"] },
];

describe("describeSender", () => {
  it("names the sender when their handle resolved to a roster member", () => {
    expect(describeSender("m-aman", "+16308532531", roster)).toBe("Aman (on the roster above)");
  });

  it("reports an unknown sender with the raw handle when it didn't resolve", () => {
    expect(describeSender(undefined, "+15550001111", roster)).toBe("unknown — handle +15550001111 is not on the family roster");
  });

  it("reports unknown when there is no sender information at all", () => {
    expect(describeSender(undefined, undefined, roster)).toBe("unknown");
  });

  it("falls back to the handle when the member id is not on the roster snapshot", () => {
    expect(describeSender("m-gone", "+15550001111", roster)).toBe("unknown — handle +15550001111 is not on the family roster");
  });
});
