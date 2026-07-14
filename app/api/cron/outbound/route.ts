import { processOutboundQueue } from "@/lib/outbound-processor";
import { isValidCronRequest } from "@/lib/webhook-auth";

// Outbound-queue retry sweep: drains anything queued while the Mac/
// BlueBubbles bridge was asleep or unreachable. See vercel.json for cadence
// (every few minutes) — cheap and idempotent, safe to run that often.

export async function GET(request: Request) {
  if (!isValidCronRequest(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const result = await processOutboundQueue();
    return Response.json(result);
  } catch (err) {
    console.error("[api/cron/outbound] processOutboundQueue failed", err);
    return Response.json({ error: "processOutboundQueue failed" }, { status: 500 });
  }
}

// Vercel Cron always sends GET; POST is accepted too purely for manual
// testing convenience (`curl -X POST .../api/cron/outbound?secret=...`).
export const POST = GET;
