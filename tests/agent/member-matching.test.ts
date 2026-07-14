import { describe, it } from "vitest";

// ---------------------------------------------------------------------------
// FINDING (for tech-lead): no pure, testable family-member-matching function
// exists in the codebase today.
//
// Per docs/agent-core.md §1, "there is no separate NLU step — the
// tool-calling LLM ... is the parser." Name resolution ("Maya" / "mom" / "the
// dentist for Kai" -> a family_members.id) happens entirely inside the
// model's own reasoning over the roster text embedded in the system prompt
// (see lib/agent/index.ts formatRoster/buildSystemPrompt) and the model's own
// judgment call on genuine ambiguity ("ask instead of guessing" is an
// instruction to the LLM, not an enforced code path). There is no
// lib/agent/matchMember.ts, no pre-tool-call resolution step, and nothing
// exported that maps free text -> a member id or an "ambiguous" signal
// without an LLM call.
//
// This means:
//   - name-matching cannot be tested offline/deterministically today (it's
//     inseparable from mocking the model's tool-calling behavior itself,
//     which is a much heavier, weaker test than a unit test on a pure
//     function).
//   - the "ask instead of guess" policy has NO deterministic backstop the way
//     the conflict-detection rule has `runAgent`'s server-side
//     surfaceConflictWarnings() safety net (see lib/agent/index.ts). If the
//     model ever guesses on a genuinely ambiguous name instead of asking, the
//     event still gets created for the wrong person — there is no code path
//     that would catch or prevent that. Worth a decision from tech-lead:
//     agent-core.md documents a deterministic safety net for conflicts but
//     not for member-matching, and the asymmetry looks unintentional.
//
// RECOMMENDATION: extract a pure `matchMember` helper, e.g.:
//
//   // lib/agent/match-member.ts
//   export interface RosterMember { id: string; name: string; aliases: string[] }
//   export type MatchResult =
//     | { kind: "unique"; member: RosterMember }
//     | { kind: "ambiguous"; candidates: RosterMember[] }
//     | { kind: "none" };
//   export function matchMember(text: string, roster: RosterMember[]): MatchResult
//
// Suggested matching rules (for tech-lead/senior-backend to ratify, not
// prescribed here):
//   - case-insensitive exact match on `name`
//   - case-insensitive exact match on any of `aliases`
//   - no fuzzy/substring matching by default (a substring match is exactly
//     the kind of "confident guess that's actually wrong" this function
//     exists to prevent) — "ambiguous" should be reserved for a piece of
//     text matching >1 roster member (e.g. two members both alias "mom", or
//     an initials collision), not for weak/partial matches.
//   - "unknown" (kind: "none") should NOT throw — the agent's policy is to
//     ask a clarifying question, so the caller needs a value to branch on.
//
// If/when this lands, `runAgent`/buildSystemPrompt could call it as a
// pre-pass (or the tools could call it inside `execute()` before resolving a
// memberIds array), giving conflict-detection-style deterministic backstop
// instead of trusting the model's roster-reading every time.
//
// The table below is a ready-to-fill skeleton once matchMember exists —
// update the import and un-skip (`.todo` -> real `it`) each case.
// ---------------------------------------------------------------------------

describe.todo("matchMember(text, roster) — see extraction proposal above", () => {
  // const roster: RosterMember[] = [
  //   { id: "m-maya", name: "Maya", aliases: [] },
  //   { id: "m-kai", name: "Kai", aliases: ["Kai-Kai"] },
  //   { id: "m-mom", name: "Priya", aliases: ["Mom", "Mama"] },
  //   { id: "m-dad", name: "Aman", aliases: ["Dad", "Papa"] },
  // ];

  it.todo("matches an exact real name");
  it.todo("matches an alias ('mom' -> Priya)");
  it.todo("is case-insensitive on both name and alias ('MOM', 'mom', 'Mom' all match Priya)");
  it.todo("returns kind: 'none' for a name not on the roster, without throwing");
  it.todo("returns kind: 'none' for an empty roster");
  it.todo(
    "returns kind: 'ambiguous' with all candidates when two members share an alias (e.g. both parents answer to 'the boss')",
  );
  it.todo("does not fuzzy/substring-match — 'Ka' should not silently resolve to 'Kai'");
  it.todo("does not treat a name that is a case-insensitive prefix of another as a match (e.g. 'Max' vs roster member 'Maxine')");
});
