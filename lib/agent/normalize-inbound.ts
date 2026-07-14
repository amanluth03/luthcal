/**
 * Pure inbound-text normalization/pre-check, shared by every entry point
 * that hands raw text to `runAgent` — today `app/api/chat/route.ts`
 * (dashboard), and (per backend-dev's in-flight work) the BlueBubbles
 * webhook once it lands. Deliberately has zero dependencies on the agent,
 * the DB, or Next's request/response types, so it's callable from either
 * adapter and unit-testable on its own — see tests/inbound/malformed-text.test.ts.
 */

/**
 * Upper bound on a single inbound message, in characters. Sized generously
 * above any real iMessage/dashboard message (~a few KB) so it never rejects
 * a genuine, if long, family text, while still bounding the worst case
 * before the text is written to `message_log` (unbounded `text` column) and
 * handed to the model.
 */
export const MAX_INBOUND_LENGTH = 4000;

export interface NormalizedInbound {
  /** `raw`, trimmed. Not truncated even when `isTooLong` — callers decide whether to reject or truncate; see app/api/chat/route.ts for the "reject" choice made there. */
  text: string;
  /** True if `text` is empty after trimming (including a whitespace-only original). */
  isEmpty: boolean;
  /** True if `text` is longer than MAX_INBOUND_LENGTH. */
  isTooLong: boolean;
}

/**
 * Trims `raw` and classifies it as empty/whitespace-only and/or over-length.
 * Never throws. Intentionally does *not* filter emoji-only, punctuation-only,
 * or otherwise "weird but non-empty" text — deciding whether a message is a
 * real calendar request is the model's job (per docs/agent-core.md §1); this
 * helper only guards the two cases that are cheap and unambiguous to reject
 * before ever making a model call: nothing there, and way too much there.
 */
export function normalizeInboundText(raw: string): NormalizedInbound {
  const text = raw.trim();
  return {
    text,
    isEmpty: text.length === 0,
    isTooLong: text.length > MAX_INBOUND_LENGTH,
  };
}
