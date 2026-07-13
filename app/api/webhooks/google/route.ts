import { after } from "next/server";
import { isValidChannelToken, syncGoogleCalendarChanges } from "@/lib/google/watch";

// Google Calendar push notifications: https://developers.google.com/calendar/api/guides/push
//
// Every notification is a POST with no meaningful body — just headers:
//   X-Goog-Channel-Token   the shared secret we set when registering the channel (CRON_SECRET)
//   X-Goog-Resource-State  "sync" (initial handshake) | "exists" (something changed)
//
// Google expects a fast 2xx and retries (with backoff) on anything else. We
// authenticate synchronously (cheap), then defer the actual incremental sync
// to `after()` so the response flushes immediately regardless of how long
// the Calendar API round trip + DB writes take — this route never does the
// actual announcement send itself (see the TODO below).
export async function POST(request: Request) {
  const channelToken = request.headers.get("x-goog-channel-token");
  if (!isValidChannelToken(channelToken)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const resourceState = request.headers.get("x-goog-resource-state");
  if (resourceState !== "sync") {
    // resourceState === "sync" is the one-time channel-verification handshake
    // sent when the watch is created; there's nothing to sync yet for that
    // case. Everything else ("exists", etc.) means something changed.
    after(async () => {
      try {
        await syncGoogleCalendarChanges();
      } catch (err) {
        // Log only: a non-2xx response here would make Google redeliver, and
        // a transient DB/API hiccup shouldn't trigger a redelivery storm. The
        // next real change notification (or the periodic renew cron) will
        // catch up — syncGoogleCalendarChanges() is idempotent and
        // syncToken-based.
        console.error("[api/webhooks/google] sync failed", err);
      }
    });
  }

  // TODO(backend-dev): once this route can reliably reach the announce sweep
  // (lib/google/events.ts `listPendingAnnouncements` / `markAnnounced`), kick
  // it off here so calendar-app-created events get announced immediately
  // instead of waiting for the next cron tick. For now the cron alone
  // handles it.
  return new Response(null, { status: 200 });
}

// Lets `curl`/browser hits confirm the route is deployed without tripping auth.
export function GET() {
  return new Response("ok", { status: 200 });
}
