import type { RosterMember } from "./match-member";

/**
 * One line for the system prompt naming who sent the message being answered,
 * so first-person references ("add a dentist appointment for me") resolve to
 * the sender instead of reading as ambiguous. Earlier turns are already
 * name-prefixed by lib/agent/history.ts; this covers the current one.
 */
export function describeSender(senderMemberId: string | undefined, senderHandle: string | undefined, roster: RosterMember[]): string {
  const name = senderMemberId ? roster.find((m) => m.id === senderMemberId)?.name : undefined;
  if (name) return `${name} (on the roster above)`;
  if (senderHandle) return `unknown — handle ${senderHandle} is not on the family roster`;
  return "unknown";
}
