/**
 * Deterministic (non-LLM) family-member name resolution.
 *
 * Per docs/agent-core.md's NLU approach, the tool-calling model *is* the
 * parser — there's no separate NLU step for "what/when". Member-matching is
 * the one exception: `runAgent`/`lib/agent/tools.ts` use this pure function
 * as a deterministic backstop so an ambiguous reference (two roster members
 * sharing an alias) can never be silently resolved to the wrong person just
 * because the model made a confident guess. See docs/agent-core.md §2
 * "Deterministic member-matching backstop" for how this is wired in.
 */

export interface RosterMember {
  id: string;
  name: string;
  aliases: string[];
}

export type MatchResult =
  | { kind: "unique"; member: RosterMember }
  | { kind: "ambiguous"; candidates: RosterMember[] }
  | { kind: "none" };

/**
 * Case-insensitive EXACT match of `text` against each roster member's `name`
 * or any of their `aliases`. No substring/prefix/fuzzy matching — a
 * confident partial match (e.g. "Ka" ~ "Kai", "Max" ~ "Maxine") is exactly
 * the kind of silently-wrong guess this function exists to prevent, so it
 * simply isn't attempted. Never throws.
 *
 * **Tokenization** (kept deliberately simple and predictable): the
 * candidate strings checked are (1) the whole input, trimmed, as one unit,
 * and (2) each whitespace-delimited token within it. Trying the whole
 * string first lets a multi-word name/alias ("the boss") match even though
 * it would otherwise be split across tokens; per-token matching then covers
 * the common case of a name embedded in a longer sentence ("dentist for
 * Maya tuesday" — the token "Maya" matches even though the full sentence
 * doesn't). Everything is compared lower-cased; no other normalization
 * (punctuation isn't stripped, so "Maya," won't match "Maya" — an exact
 * match is exact).
 *
 * Returns `{ kind: "ambiguous", candidates }` when the text matches more
 * than one *distinct* roster member (e.g. two members both alias "mom", or
 * a role word like "the boss" that happens to be configured as an alias for
 * more than one person) — this is the case callers must treat as "ask,
 * don't guess". Returns `{ kind: "none" }` for no match at all (including
 * an empty roster or empty/whitespace-only text) — this is not an error
 * condition, just a value for the caller to branch on.
 */
export function matchMember(text: string, roster: RosterMember[]): MatchResult {
  const trimmed = text.trim();
  if (trimmed === "" || roster.length === 0) return { kind: "none" };

  const candidates = new Set<string>([trimmed.toLowerCase(), ...trimmed.split(/\s+/).map((t) => t.toLowerCase())]);

  const matched = new Map<string, RosterMember>();
  for (const member of roster) {
    const names = [member.name, ...member.aliases].map((n) => n.toLowerCase());
    if (names.some((n) => candidates.has(n))) {
      matched.set(member.id, member);
    }
  }

  const results = [...matched.values()];
  if (results.length === 0) return { kind: "none" };
  if (results.length === 1) return { kind: "unique", member: results[0] };
  return { kind: "ambiguous", candidates: results };
}
