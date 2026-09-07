import { after } from "next/server";

import { extractServerUrlChange, setBridgeUrl } from "@/lib/bluebubbles";
import { processInboundMessage } from "@/lib/inbound-processor";
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
//
// This route only ever extracts the BlueBubbles-payload-shaped bits (auth,
// JSON parsing, the "server URL changed" event, pulling chatGuid out of the
// event body) and dispatches to lib/inbound-processor.ts's
// processInboundMessage — the loop guards, family-chat filter, already-
// processed dedup, passive-listener gate, and running the agent all live
// there now, shared with app/api/cron/inbound (the REST-API poll backstop
// for when BlueBubbles' own webhook poller stalls — see
// docs/bluebubbles-setup.md).

interface BlueBubblesEvent {
  type?: string;
  data?: unknown;
}

interface NewMessageData {
  guid?: string;
  text?: string;
  isFromMe?: boolean;
  handle?: { address?: string };
  chats?: Array<{ guid?: string }>;
}

function extractChatGuid(data: NewMessageData): string | undefined {
  const fromChats = data.chats?.[0]?.guid;
  return typeof fromChats === "string" && fromChats.length > 0 ? fromChats : undefined;
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
  const newBridgeUrl = extractServerUrlChange(payload);
  if (newBridgeUrl) {
    after(async () => {
      try {
        await setBridgeUrl(newBridgeUrl);
      } catch (err) {
        console.error("[api/webhooks/bluebubbles] failed to persist new bridge URL", err);
      }
    });
    return new Response(null, { status: 200 });
  }

  if (payload.type !== "new-message") {
    // Ignore everything else (typing-indicator, chat-read-status-changed,
    // message-send-error, etc.) — v1 only acts on new inbound texts.
    return new Response(null, { status: 200 });
  }

  const data = (payload.data ?? {}) as NewMessageData;

  // Respond to BlueBubbles fast; do the actual guard/gate/NLU/enqueue work
  // after the response is flushed (mirrors app/api/webhooks/google/route.ts's
  // use of `after()` for the same "acknowledge fast, work after" reason).
  after(async () => {
    try {
      await processInboundMessage({
        imessageGuid: data.guid,
        chatGuid: extractChatGuid(data),
        senderHandle: data.handle?.address,
        text: typeof data.text === "string" ? data.text : "",
        isFromMe: data.isFromMe,
      });
    } catch (err) {
      console.error("[api/webhooks/bluebubbles] processInboundMessage failed", err);
    }
  });

  return new Response(null, { status: 200 });
}

// Lets curl/browser hits confirm the route is deployed without tripping auth
// (mirrors app/api/webhooks/google/route.ts's GET handler).
export function GET() {
  return new Response("ok", { status: 200 });
}
