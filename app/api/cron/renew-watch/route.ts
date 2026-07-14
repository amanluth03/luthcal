import { renewWatchChannelIfNeeded } from "@/lib/google/watch";
import { isValidCronRequest } from "@/lib/webhook-auth";

// Not in the original task brief's four cron endpoints, but explicitly
// called out as backend-dev's responsibility in docs/agent-core.md §6
// ("Intended to be called from a daily cron (backend-dev's app/api/cron/*)")
// — senior-backend's Google Calendar watch channel is only valid for ~7
// days (see lib/google/watch.ts REQUESTED_TTL_MS) and Google gives no
// advance-warning webhook when it's about to expire, so this has to be
// polled for. Without it, calendar-app-added events would silently stop
// syncing into event_meta ~a week after the channel was registered. Added
// on that basis; flagging for tech-lead to confirm it's wanted since it's
// outside the literal BUILD list.

export async function GET(request: Request) {
  if (!isValidCronRequest(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const result = await renewWatchChannelIfNeeded();
    return Response.json({ renewed: result !== null });
  } catch (err) {
    console.error("[api/cron/renew-watch] failed", err);
    return Response.json({ error: "watch channel renewal failed" }, { status: 500 });
  }
}

export const POST = GET;
