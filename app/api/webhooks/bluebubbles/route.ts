import { after } from "next/server";

import { runAgent } from "@/lib/agent";
import { enqueueOutbound } from "@/lib/agent/outbound";
import { MAX_INBOUND_LENGTH, normalizeInboundText } from "@/lib/agent/normalize-inbound";
import { getDb } from "@/lib/db";
import { messageLog } from "@/lib/db/schema";
import { setBridgeUrl } from "@/lib/bluebubbles";
import { isValidBlueBubblesWebhookSecret } from "@/lib/webhook-auth";

// Inbound iMessage webhook. BlueBubbles POSTs every server-side event here
// (new messages, typing indicators, chat-read-status changes, the server's
// own tunnel URL rotating, etc.) as `{ type, data }`. BlueBubbles' webhook
// sender can't set custom headers, so auth travels as a `?secret=` query
// param instead (see lib/webhook-auth.ts `isValidBlueBubblesWebhookSecret` —
// constant-time compare, fails closed if BLUEBUBBLES_WEBHOOK_SECRET is
// unset). Register the callback URL as
// `https://<deployment>/api/webhooks/bluebubbles?secret=<BLUEBUBBLES_WEBHOOK_SECRET>`
// — see docs/bluebubbles-setup.md.

interface BlueBubblesEvent {
  type?: string;
  data?: unknown;
}

interface NewMessageData {
  text?: string;
  isFromMe?: boolean;
  handle?: { address?: string };
  chats?: Array<{ guid?: string }>;
}

// BlueBubbles' event name for "the server's public URL changed" (its
// Cloudflare Tunnel/ngrok hostname rotated) — the docs page this was
// cross-checked against didn't render its full event-type table in this
// environment (JS-rendered SPA), so this is inferred from the feature's
// name in the BlueBubbles server UI ("Server URL Change") and its
// changelog. Worth a one-time confirmation against a live server's actual
// webhook payload during setup (log the raw body once) — see
// docs/bluebubbles-setup.md. Unrecognized `type` values are ignored either
// way, so a wrong guess here just means a URL-rotation event silently
// no-ops instead of updating the stored bridge URL — not a crash, not a
// misrouted message.
const SERVER_URL_CHANGE_TYPES = new Set(["server-url-change", "server-url-changed", "new-server-url"]);

interface ServerUrlChangeData {
  url?: string;
  new_url?: string;
  serverUrl?: string;
}

function extractServerUrl(data: unknown): string | undefined {
  const d = data as ServerUrlChangeData | undefined;
  const candidate = d?.url ?? d?.new_url ?? d?.serverUrl;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function extractChatGuid(data: NewMessageData): string | undefined {
  const fromChats = data.chats?.[0]?.guid;
  return typeof fromChats === "string" && fromChats.length > 0 ? fromChats : undefined;
}

async function logInbound(chatGuid: string | undefined, senderHandle: string | undefined, text: string): Promise<void> {
  try {
    const db = getDb();
    await db.insert(messageLog).values({ direction: "inbound", chatGuid, senderHandle, text });
  } catch (err) {
    console.error("[api/webhooks/bluebubbles] failed to write message_log (continuing)", err);
  }
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  if (!isValidBlueBubblesWebhookSecret(url.searchParams.get("secret"))) {
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: BlueBubblesEvent;
  try {
    payload = (await request.json()) as BlueBubblesEvent;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // The bridge's tunnel URL rotated — persist it so sends (including the
  // outbound-queue retry sweep) target the new address. Not a message event
  // at all, handled first and independently of everything below.
  if (typeof payload.type === "string" && SERVER_URL_CHANGE_TYPES.has(payload.type)) {
    const newUrl = extractServerUrl(payload.data);
    if (newUrl) {
      after(async () => {
        try {
          await setBridgeUrl(newUrl);
        } catch (err) {
          console.error("[api/webhooks/bluebubbles] failed to persist new bridge URL", err);
        }
      });
    }
    return new Response(null, { status: 200 });
  }

  if (payload.type !== "new-message") {
    // Ignore everything else (typing-indicator, chat-read-status-changed,
    // message-send-error, etc.) — v1 only acts on new inbound texts.
    return new Response(null, { status: 200 });
  }

  const data = (payload.data ?? {}) as NewMessageData;
  const senderHandle = data.handle?.address;

  // Critical loop guard: BlueBubbles echoes the agent's own outbound sends
  // back through this same webhook as `isFromMe: true`. Replying to our own
  // message would have the agent talk to itself forever.
  if (data.isFromMe) {
    return new Response(null, { status: 200 });
  }

  // F3 (tech-lead follow-up): `isFromMe` is a field name *inferred* from
  // third-party integration examples, not independently confirmed against a
  // live BlueBubbles server (see docs/bluebubbles-setup.md) — if it's wrong
  // or ever renamed upstream, the check above fails OPEN and the agent talks
  // to itself forever. Defense-in-depth: a second, independent guard that
  // compares the sender handle against the agent's own dedicated Apple ID
  // (AGENT_IMESSAGE_HANDLE). Best-effort only (skipped if the env var isn't
  // set) — this is a belt-and-suspenders backstop for the primary check
  // above, not itself the sole loop guard.
  const agentHandle = process.env.AGENT_IMESSAGE_HANDLE;
  if (agentHandle && senderHandle && senderHandle.toLowerCase() === agentHandle.toLowerCase()) {
    return new Response(null, { status: 200 });
  }

  const chatGuid = extractChatGuid(data);
  const familyChatGuid = process.env.FAMILY_CHAT_GUID;
  const rawText = typeof data.text === "string" ? data.text : "";
  // F5 (cross-team dependency on senior-backend's lib/agent/normalize-inbound.ts):
  // trims the raw inbound text and classifies it up front, before it's ever
  // written to message_log or handed to runAgent. Unlike app/api/chat/route.ts
  // (which rejects an over-length dashboard message with a 400 the user can
  // see and react to), there's no synchronous response channel back to the
  // sender here — BlueBubbles gets a fire-and-forget 200 regardless — so an
  // over-length iMessage is capped (truncated to MAX_INBOUND_LENGTH) rather
  // than silently dropped. `text` below is what both logInbound and runAgent
  // use from here on — `rawText`/`normalized.text` are never logged or
  // passed to the agent directly.
  const normalized = normalizeInboundText(rawText);
  const text = normalized.isTooLong ? normalized.text.slice(0, MAX_INBOUND_LENGTH) : normalized.text;
  if (normalized.isTooLong) {
    console.warn("[api/webhooks/bluebubbles] inbound text capped (over length limit)", { chatGuid, originalLength: normalized.text.length });
  }

  if (!chatGuid || !familyChatGuid || chatGuid !== familyChatGuid) {
    // Not the family group chat — out of scope for v1 (no DMs, no other
    // group chats), so this message never reaches runAgent. This webhook is
    // the only place that will ever log it — keep the audit trail.
    await logInbound(chatGuid, senderHandle, text || "(empty message)");
    return new Response(null, { status: 200 });
  }

  if (normalized.isEmpty) {
    // Attachment-only / tapback / empty-body message — nothing for the NLU
    // agent to act on, so it never reaches runAgent either. Keep the audit
    // trail for the same reason as the branch above.
    await logInbound(chatGuid, senderHandle, "(empty message)");
    return new Response(null, { status: 200 });
  }

  // F7 (tech-lead follow-up): everything from here on *does* reach
  // runAgent, and runAgent logs its own inbound message internally (see
  // docs/agent-core.md) — so this webhook deliberately does NOT also call
  // logInbound for this message. Logging it here too produced a second,
  // near-duplicate message_log row for every in-family message; runAgent's
  // internal log is now the single source of truth for anything that
  // actually reaches the agent. The two branches above (wrong chat, empty
  // body) still log here directly, since those never reach runAgent at all
  // and would otherwise have no audit trail.

  // Respond to BlueBubbles fast; do the actual NLU + Google Calendar +
  // outbound-enqueue work after the response is flushed (mirrors
  // app/api/webhooks/google/route.ts's use of `after()` for the same
  // "acknowledge fast, work after" reason).
  after(async () => {
    try {
      // v1: pass just this single inbound message as the whole
      // conversation. runAgent has no multi-turn context beyond what's
      // passed in `messages` — wiring in recent message_log rows as prior
      // turns would need turn/sender attribution across a group chat with
      // multiple humans, which is more than a one-line change here. Noted
      // as a reasonable v2 rather than built speculatively.
      const result = await runAgent({
        messages: [{ role: "user", content: text }],
        source: "imessage",
        chatGuid,
        senderHandle,
      });
      await enqueueOutbound(chatGuid, result.reply);
    } catch (err) {
      console.error("[api/webhooks/bluebubbles] runAgent failed", err);
    }
  });

  return new Response(null, { status: 200 });
}

// Lets curl/browser hits confirm the route is deployed without tripping auth
// (mirrors app/api/webhooks/google/route.ts's GET handler).
export function GET() {
  return new Response("ok", { status: 200 });
}
