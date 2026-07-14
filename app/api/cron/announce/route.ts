import { enqueueOutbound } from "@/lib/agent/outbound";
import { getEvent, listPendingAnnouncements, markAnnounced } from "@/lib/google/events";
import { getFamilyTimeZone } from "@/lib/google/time";
import { formatEventLine, getMemberNameMap } from "@/lib/message-format";
import { isValidCronRequest } from "@/lib/webhook-auth";

// Backup announce sweep: events created via the dashboard or added directly
// in a calendar app never got announced synchronously (the agent's own
// iMessage reply only covers imessage-sourced creates — see
// docs/agent-core.md §3 "Announcements"). This sweep picks up everything
// with event_meta.announced_at still null, formats it, and delivers it.

function requireFamilyChatGuid(): string {
  const guid = process.env.FAMILY_CHAT_GUID;
  if (!guid) throw new Error("FAMILY_CHAT_GUID is not set");
  return guid;
}

export async function GET(request: Request) {
  if (!isValidCronRequest(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const tz = getFamilyTimeZone();
    const chatGuid = requireFamilyChatGuid();
    const pending = await listPendingAnnouncements();

    if (pending.length === 0) {
      return Response.json({ announced: 0 });
    }

    const names = await getMemberNameMap();
    let announced = 0;
    for (const item of pending) {
      const event = await getEvent(item.googleEventId);
      if (!event) {
        // The event was deleted between being flagged pending and now (or
        // the id is stale) — nothing left to announce. Mark it anyway so a
        // dead id doesn't sit in the pending queue forever.
        await markAnnounced(item.googleEventId);
        continue;
      }

      const verb = event.createdVia === "calendar_app" ? "New on the calendar" : "Added";
      await enqueueOutbound(chatGuid, `${verb}: ${formatEventLine(event, tz, names)}`);
      await markAnnounced(item.googleEventId);
      announced++;
    }

    return Response.json({ announced });
  } catch (err) {
    console.error("[api/cron/announce] failed", err);
    return Response.json({ error: "announce sweep failed" }, { status: 500 });
  }
}

export const POST = GET;
