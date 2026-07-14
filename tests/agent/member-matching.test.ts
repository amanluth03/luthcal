import { describe, expect, it } from "vitest";

import { matchMember, type RosterMember } from "@/lib/agent/match-member";

// ---------------------------------------------------------------------------
// F4 (tech-lead-ratified): lib/agent/match-member.ts's matchMember(text, roster)
// is the deterministic, non-LLM backstop behind member-name resolution — see
// docs/agent-core.md §2 "Deterministic member-matching backstop" for how
// lib/agent/tools.ts wires this into createEvent/updateEvent (memberNames ->
// ids, short-circuiting on ambiguity instead of letting the model guess).
//
// Matching rule under test: case-insensitive EXACT match of a token against a
// roster member's `name` or any `alias` — no substring/prefix/fuzzy matching.
// Tokenization: the whole (trimmed) input as one candidate, plus each
// whitespace-delimited token within it, both lower-cased.
// ---------------------------------------------------------------------------

const roster: RosterMember[] = [
  { id: "m-maya", name: "Maya", aliases: [] },
  { id: "m-kai", name: "Kai", aliases: ["Kai-Kai"] },
  { id: "m-mom", name: "Priya", aliases: ["Mom", "Mama"] },
  { id: "m-dad", name: "Aman", aliases: ["Dad", "Papa"] },
];

describe("matchMember(text, roster)", () => {
  it("matches an exact real name", () => {
    expect(matchMember("Maya", roster)).toEqual({ kind: "unique", member: roster[0] });
  });

  it("matches an alias ('mom' -> Priya)", () => {
    expect(matchMember("mom", roster)).toEqual({ kind: "unique", member: roster[2] });
  });

  it("is case-insensitive on both name and alias ('MOM', 'mom', 'Mom' all match Priya)", () => {
    expect(matchMember("MOM", roster)).toEqual({ kind: "unique", member: roster[2] });
    expect(matchMember("mom", roster)).toEqual({ kind: "unique", member: roster[2] });
    expect(matchMember("Mom", roster)).toEqual({ kind: "unique", member: roster[2] });
    expect(matchMember("mAyA", roster)).toEqual({ kind: "unique", member: roster[0] });
  });

  it("returns kind: 'none' for a name not on the roster, without throwing", () => {
    expect(() => matchMember("Zelda", roster)).not.toThrow();
    expect(matchMember("Zelda", roster)).toEqual({ kind: "none" });
  });

  it("returns kind: 'none' for an empty roster", () => {
    expect(matchMember("Maya", [])).toEqual({ kind: "none" });
  });

  it("returns kind: 'ambiguous' with all candidates when two members share an alias (e.g. both parents answer to 'the boss')", () => {
    const rosterWithSharedAlias: RosterMember[] = [
      { id: "m-mom", name: "Priya", aliases: ["Mom", "the boss"] },
      { id: "m-dad", name: "Aman", aliases: ["Dad", "the boss"] },
    ];
    const result = matchMember("the boss", rosterWithSharedAlias);
    expect(result.kind).toBe("ambiguous");
    expect(result).toEqual({
      kind: "ambiguous",
      candidates: expect.arrayContaining([rosterWithSharedAlias[0], rosterWithSharedAlias[1]]),
    });
    if (result.kind === "ambiguous") {
      expect(result.candidates).toHaveLength(2);
    }
  });

  it("does not fuzzy/substring-match — 'Ka' should not silently resolve to 'Kai'", () => {
    expect(matchMember("Ka", roster)).toEqual({ kind: "none" });
  });

  it("does not treat a name that is a case-insensitive prefix of another as a match (e.g. 'Max' vs roster member 'Maxine')", () => {
    const rosterWithMaxine: RosterMember[] = [{ id: "m-maxine", name: "Maxine", aliases: [] }];
    expect(matchMember("Max", rosterWithMaxine)).toEqual({ kind: "none" });
    expect(matchMember("Maxine", rosterWithMaxine)).toEqual({
      kind: "unique",
      member: rosterWithMaxine[0],
    });
  });
});

// ---------------------------------------------------------------------------
// Tokenization behavior beyond the 8 ratified cases above — pins down the
// "whole string, plus each whitespace token" rule documented on matchMember.
// ---------------------------------------------------------------------------

describe("matchMember(text, roster) — tokenization", () => {
  it("matches a single-word name embedded in a longer sentence via per-token matching", () => {
    expect(matchMember("dentist for Maya tuesday", roster)).toEqual({ kind: "unique", member: roster[0] });
  });

  it("matches a multi-word alias only when it appears as the whole string, not split across tokens", () => {
    const rosterWithMultiWordAlias: RosterMember[] = [{ id: "m-mom", name: "Priya", aliases: ["the boss"] }];
    expect(matchMember("the boss", rosterWithMultiWordAlias)).toEqual({
      kind: "unique",
      member: rosterWithMultiWordAlias[0],
    });
    // Neither "the" nor "boss" alone is a name/alias on its own, so a
    // sentence merely containing both words separately doesn't match.
    expect(matchMember("the appointment is with the new boss", rosterWithMultiWordAlias)).toEqual({ kind: "none" });
  });

  it("does not match on trailing punctuation attached to a token ('Maya,' is not an exact match)", () => {
    expect(matchMember("Maya,", roster)).toEqual({ kind: "none" });
  });

  it("treats an empty or whitespace-only string as no match", () => {
    expect(matchMember("", roster)).toEqual({ kind: "none" });
    expect(matchMember("   ", roster)).toEqual({ kind: "none" });
  });
});
