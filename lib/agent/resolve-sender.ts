import type { RosterMember } from "./match-member";

/**
 * Resolves the SENDER of an inbound message to a `family_members.id` —
 * for `message_log.member_id`, so the dashboard's activity feed can show a
 * real name instead of "Unknown" (BUG 1, see docs/agent-core.md).
 *
 * `senderHandle` is an iMessage handle (phone number or Apple ID email) for
 * `source: "imessage"`, or the signed-in dashboard user's Google account
 * email for `source: "dashboard"` (see app/api/chat/route.ts) — both are
 * matched the same way here, against `family_members.imessageHandle` (which
 * doubles as an email/Apple-ID field — see scripts/seed.ts, where Aman's row
 * stores his Gmail address there) or `family_members.phone`.
 *
 * This is a DIFFERENT lookup from lib/agent/match-member.ts's `matchMember`:
 * that resolves a name mentioned *in* a message's text ("create an event for
 * Maya") to a member; this resolves who *sent* the message. Deliberately
 * exact (trimmed, case-insensitive) match only, no fuzzy matching, for the
 * same reason `matchMember` avoids it — a wrong guess here would mislabel
 * the activity feed with the wrong person. An unresolved handle isn't an
 * error: the caller falls back to showing the raw handle/email instead (see
 * `lib/data/server-adapter.ts`'s `resolveActivitySender`), which is already
 * a real improvement over "Unknown".
 */
export function resolveSenderMemberId(senderHandle: string | undefined, roster: RosterMember[]): string | undefined {
  const handle = senderHandle?.trim().toLowerCase();
  if (!handle) return undefined;

  const match = roster.find((member) => {
    const imessageHandle = member.imessageHandle?.trim().toLowerCase();
    const phone = member.phone?.trim().toLowerCase();
    return imessageHandle === handle || phone === handle;
  });
  return match?.id;
}
