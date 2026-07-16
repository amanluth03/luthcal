import { describe, expect, it } from "vitest";

import { resolveSenderMemberId } from "@/lib/agent/resolve-sender";
import type { RosterMember } from "@/lib/agent/match-member";

// ---------------------------------------------------------------------------
// BUG 1: message_log.member_id was never populated, so the dashboard
// activity feed showed "Unknown" for every dashboard-created event.
// resolveSenderMemberId(senderHandle, roster) is the deterministic fix — see
// docs/agent-core.md and lib/agent/resolve-sender.ts's own doc comment for
// why this is a DIFFERENT lookup than matchMember (name-in-text vs
// who-sent-this).
// ---------------------------------------------------------------------------

const roster: RosterMember[] = [
  { id: "m-aman", name: "Aman", aliases: ["Dad"], imessageHandle: "amanluth03@gmail.com", phone: null },
  { id: "m-ekta", name: "Ekta", aliases: ["Mom"], imessageHandle: "ekta.luthra@icloud.com", phone: null },
  { id: "m-yash", name: "Yash", aliases: [], imessageHandle: null, phone: "+15125550110" },
];

describe("resolveSenderMemberId(senderHandle, roster)", () => {
  it("matches a dashboard session email against imessageHandle (which doubles as an email/Apple-ID field)", () => {
    expect(resolveSenderMemberId("amanluth03@gmail.com", roster)).toBe("m-aman");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(resolveSenderMemberId("  AmanLuth03@Gmail.com  ", roster)).toBe("m-aman");
  });

  it("matches an iMessage handle against phone when imessageHandle is null", () => {
    expect(resolveSenderMemberId("+15125550110", roster)).toBe("m-yash");
  });

  it("returns undefined for a handle matching nobody on the roster, without throwing", () => {
    expect(() => resolveSenderMemberId("stranger@example.com", roster)).not.toThrow();
    expect(resolveSenderMemberId("stranger@example.com", roster)).toBeUndefined();
  });

  it("returns undefined for undefined/empty senderHandle", () => {
    expect(resolveSenderMemberId(undefined, roster)).toBeUndefined();
    expect(resolveSenderMemberId("", roster)).toBeUndefined();
    expect(resolveSenderMemberId("   ", roster)).toBeUndefined();
  });

  it("returns undefined against an empty roster", () => {
    expect(resolveSenderMemberId("amanluth03@gmail.com", [])).toBeUndefined();
  });

  it("does not fuzzy/substring-match a handle", () => {
    expect(resolveSenderMemberId("amanluth03@gmail.co", roster)).toBeUndefined();
  });
});
