import { pollInboundMessages } from "@/lib/inbound-poll";
import { isValidCronRequest } from "@/lib/webhook-auth";

// Inbound-poll backstop: BlueBubbles Server runs in a second macOS user
// session on the bridge Mac, and a switched-away session gets throttled
// hard enough that its own message poller can stall for minutes-to-hours —
// its REST API keeps answering the whole time, though. This sweep pulls
// recent messages from that API on a schedule and runs anything the
// webhook hasn't already handled through the same pipeline. See
// docs/bluebubbles-setup.md.

export async function GET(request: Request) {
  if (!isValidCronRequest(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const result = await pollInboundMessages();
    return Response.json(result);
  } catch (err) {
    console.error("[api/cron/inbound] pollInboundMessages failed", err);
    return Response.json({ error: "inbound poll failed" }, { status: 500 });
  }
}

// Vercel Cron always sends GET; POST is accepted too purely for manual
// testing convenience (`curl -X POST .../api/cron/inbound?secret=...`).
export const POST = GET;
