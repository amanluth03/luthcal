import { getDb } from "@/lib/db";
import { outboundQueue } from "@/lib/db/schema";

/**
 * Queues an outbound iMessage. Per CLAUDE.md, all outbound iMessages go
 * through outbound_queue rather than being sent directly — the Mac bridge
 * (BlueBubbles) may be asleep, so backend-dev's retry cron
 * (app/api/cron/*) is the only thing that actually calls the BlueBubbles
 * send API.
 */
export async function enqueueOutbound(chatGuid: string, text: string): Promise<void> {
  const db = getDb();
  await db.insert(outboundQueue).values({ chatGuid, text });
}
