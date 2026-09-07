import { and, eq } from "drizzle-orm";

import { runAgent } from "@/lib/agent";
import { decideEngagement } from "@/lib/agent/engagement";
import { loadLastOutboundMessage } from "@/lib/agent/history";
import { MAX_INBOUND_LENGTH, normalizeInboundText } from "@/lib/agent/normalize-inbound";
import { enqueueOutbound } from "@/lib/agent/outbound";
import { getDb } from "@/lib/db";
import { messageLog } from "@/lib/db/schema";

// Per-message inbound pipeline, extracted out of
// app/api/webhooks/bluebubbles/route.ts so app/api/cron/inbound (the
// REST-API poll backstop for when BlueBubbles' own webhook poller stalls —
// see docs/bluebubbles-setup.md) can share the exact same logic: loop
// guards, the family-chat filter, the passive-listener engagement gate, and
// running the agent. The webhook still owns everything BlueBubbles-payload-
// shaped (auth, JSON parsing, the "server URL changed" event, extracting
// chatGuid from the event body) — this module only ever sees the already-
// extracted fields below.

export type ProcessInboundMessageResult =
  | "dropped-own"
  | "wrong-chat"
  | "empty"
  | "already-processed"
  | "silent"
  | "engaged";

export interface InboundMessage {
  /** BlueBubbles' own message guid, when known — powers the already-processed dedup check below. */
  imessageGuid?: string;
  chatGuid?: string;
  senderHandle?: string;
  text: string;
  isFromMe?: boolean;
}

async function logInbound(chatGuid: string | undefined, senderHandle: string | undefined, text: string, imessageGuid: string | undefined): Promise<void> {
  try {
    const db = getDb();
    await db.insert(messageLog).values({ direction: "inbound", chatGuid, senderHandle, text, imessageGuid });
  } catch (err) {
    console.error("[lib/inbound-processor] failed to write message_log (continuing)", err);
  }
}

/**
 * True if an inbound message_log row with this guid already exists — the
 * webhook (push) and the inbound-poll cron (pull) can both see the same
 * BlueBubbles message, and this is what stops the second sighting from
 * running the gate/agent/outbound-enqueue a second time. Fails open (returns
 * false) on a DB error, same posture as every other best-effort DB read in
 * this codebase — a rare double-process on a transient DB hiccup is a far
 * smaller problem than never engaging at all.
 */
async function hasAlreadyProcessed(imessageGuid: string): Promise<boolean> {
  try {
    const db = getDb();
    const rows = await db
      .select({ id: messageLog.id })
      .from(messageLog)
      .where(and(eq(messageLog.direction, "inbound"), eq(messageLog.imessageGuid, imessageGuid)))
      .limit(1);
    return rows.length > 0;
  } catch (err) {
    console.error("[lib/inbound-processor] failed to check already-processed guid (continuing)", err);
    return false;
  }
}

/**
 * Runs one inbound iMessage through the full pipeline: loop guards, the
 * family-chat filter, the already-processed dedup check, the passive-
 * listener engagement gate, and (if engaged) the agent + outbound enqueue.
 * Mirrors exactly what app/api/webhooks/bluebubbles/route.ts did inline
 * before this extraction — see that route and app/api/cron/inbound for the
 * two callers.
 */
export async function processInboundMessage(msg: InboundMessage): Promise<ProcessInboundMessageResult> {
  const { imessageGuid, chatGuid, senderHandle, text: rawText, isFromMe } = msg;

  // Critical loop guard: BlueBubbles echoes the agent's own outbound sends
  // back as `isFromMe: true`. Replying to our own message would have the
  // agent talk to itself forever.
  if (isFromMe) return "dropped-own";

  // Second, independent guard: if `isFromMe` were ever renamed upstream the
  // check above would fail OPEN, so also drop anything sent from the
  // agent's own Apple ID (AGENT_IMESSAGE_HANDLE). Skipped if unset.
  const agentHandle = process.env.AGENT_IMESSAGE_HANDLE;
  if (agentHandle && senderHandle && senderHandle.toLowerCase() === agentHandle.toLowerCase()) {
    return "dropped-own";
  }

  const familyChatGuid = process.env.FAMILY_CHAT_GUID;
  const normalized = normalizeInboundText(rawText);
  // An over-length iMessage is capped (there's no synchronous response
  // channel back to the sender here) rather than dropped — see
  // lib/agent/normalize-inbound.ts.
  const text = normalized.isTooLong ? normalized.text.slice(0, MAX_INBOUND_LENGTH) : normalized.text;
  if (normalized.isTooLong) {
    console.warn("[lib/inbound-processor] inbound text capped (over length limit)", { chatGuid, originalLength: normalized.text.length });
  }

  if (!chatGuid || !familyChatGuid || chatGuid !== familyChatGuid) {
    // Not the family group chat — out of scope for v1. This is the only
    // place that will ever log it, so keep the audit trail.
    await logInbound(chatGuid, senderHandle, text || "(empty message)", imessageGuid);
    return "wrong-chat";
  }

  if (normalized.isEmpty) {
    // Attachment-only / tapback / empty-body message — nothing for the NLU
    // agent to act on. Keep the audit trail for the same reason as above.
    await logInbound(chatGuid, senderHandle, "(empty message)", imessageGuid);
    return "empty";
  }

  // Dedup between the webhook's push delivery and the inbound-poll cron
  // backstop (app/api/cron/inbound) seeing the same BlueBubbles message —
  // only checked past the cheap filters above, and only guards the
  // gate/runAgent/enqueue path below (the actually side-effecting part); a
  // duplicate wrong-chat/empty audit row above would be harmless anyway.
  if (imessageGuid && (await hasAlreadyProcessed(imessageGuid))) {
    return "already-processed";
  }

  // Passive-listener engagement gate (lib/agent/engagement.ts,
  // docs/agent-core.md §9) — decides whether this message should engage the
  // agent at all and, if so, in "act" or "suggest" mode. Ambient chatter the
  // gate silently ignores gets ZERO message_log footprint on purpose (see
  // docs/agent-core.md §9's ruling) rather than a debug audit row here.
  const last = await loadLastOutboundMessage(chatGuid);
  const decision = await decideEngagement({
    text,
    lastAgentMessage: last ? { text: last.text, sentAt: last.createdAt } : undefined,
  });

  if (!decision.engage) {
    console.info("[lib/inbound-processor] gate: silent", { reason: decision.reason, textLen: text.length });
    return "silent";
  }

  // v1: pass just this single inbound message as the whole `messages` array
  // — runAgent itself loads recent message_log rows for this thread as
  // prior-turn context internally (see docs/agent-core.md).
  const result = await runAgent({
    messages: [{ role: "user", content: text }],
    source: "imessage",
    chatGuid,
    senderHandle,
    imessageGuid,
    // decision.mode is never "silent" here since decision.engage is true.
    engagementMode: decision.mode === "suggest" ? "suggest" : "act",
  });
  await enqueueOutbound(chatGuid, result.reply);
  return "engaged";
}
