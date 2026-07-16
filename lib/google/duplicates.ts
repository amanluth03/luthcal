import { checkConflicts } from "./conflicts";
import type { LuthEvent } from "./types";

export interface NearDuplicateCandidate {
  title: string;
  startISO: string;
  endISO: string;
  /** Whether the *candidate* event being checked is itself all-day. */
  allDay?: boolean;
  memberIds: string[];
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * BUG 3 fix (see docs/agent-core.md "Duplicate-event guard"): a
 * deterministic, non-LLM check for whether `candidate` is a near-identical
 * repeat of an event that already exists on the shared calendar. Called by
 * lib/agent/tools.ts's `createEvent` BEFORE it writes anything to Google
 * Calendar — the production bug this fixes is a user re-asking for the same
 * event (because it hadn't synced to their phone yet) and the agent quietly
 * creating a second copy with no warning.
 *
 * **"Near-identical" — precise definition** (deliberately strict, so a
 * genuinely different event that merely overlaps in time is left to the
 * existing checkConflicts ⚠️-warn-but-still-create path, not blocked here):
 *
 *   1. **Same normalized title** — trimmed, internal whitespace collapsed,
 *      compared case-insensitively. Not fuzzy/substring matching, for the
 *      same reason `lib/agent/match-member.ts` avoids it for names: a
 *      confident wrong guess (silently treating two differently-titled
 *      events as "the same") is worse than occasionally missing a duplicate
 *      that happened to be phrased differently.
 *   2. **Same set of memberIds** — not merely overlapping. An event that
 *      adds an extra person ("Maya's dentist" -> "Maya and Kai's dentist")
 *      is a distinct event, not a duplicate, even with an identical
 *      title/time.
 *   3. **Overlapping time range, same all-day-ness** — the exact same rule
 *      `checkConflicts` uses (`candidate.start < other.end && candidate.end
 *      > other.start`, both-timed-or-both-all-day only). Two events with an
 *      identical start/end trivially satisfy this, which is what the actual
 *      production bug looks like (the same text, sent twice, resolves to
 *      the same ISO times both times) — no separate fuzzy time window is
 *      needed on top of it.
 *
 * Reuses `checkConflicts` as a prefilter (same shared-calendar-only,
 * shared-member, same-kind, overlapping-time query) rather than
 * reimplementing event fetching. One consequence worth flagging:
 * `checkConflicts`'s own prefilter requires >=1 shared member, so two
 * completely untagged (`memberIds: []`) events are never flagged as
 * duplicates of each other — the same known limitation conflict-detection
 * already has (see docs/agent-core.md §4), not a new one introduced here.
 *
 * Read-only. Returns the existing `LuthEvent` if a near-duplicate is found,
 * else `undefined`.
 */
export async function findNearDuplicateEvent(candidate: NearDuplicateCandidate): Promise<LuthEvent | undefined> {
  if (candidate.memberIds.length === 0) return undefined;

  const overlaps = await checkConflicts({
    startISO: candidate.startISO,
    endISO: candidate.endISO,
    memberIds: candidate.memberIds,
    allDay: candidate.allDay,
  });

  const normalizedCandidateTitle = normalizeTitle(candidate.title);
  const candidateMemberSet = new Set(candidate.memberIds);

  const match = overlaps.find(({ event }) => {
    if (normalizeTitle(event.title) !== normalizedCandidateTitle) return false;
    if (event.memberIds.length !== candidateMemberSet.size) return false;
    return event.memberIds.every((id) => candidateMemberSet.has(id));
  });

  return match?.event;
}
