import { getDb } from "@/lib/db";
import { outboundQueue } from "@/lib/db/schema";
import { isAgentSilent } from "./silent";

/**
 * Queues an outbound iMessage. Per CLAUDE.md, all outbound iMessages go
 * through outbound_queue rather than being sent directly — the Mac bridge
 * (BlueBubbles) may be asleep, so backend-dev's retry cron
 * (app/api/cron/*) is the only thing that actually calls the BlueBubbles
 * send API. In silent mode (see ./silent.ts) nothing is queued at all — the
 * agent's reply is still written to message_log by runAgent, so the
 * dashboard shows what it would have said.
 */
export async function enqueueOutbound(chatGuid: string, text: string): Promise<void> {
  if (isAgentSilent()) {
    console.info("[lib/agent/outbound] silent mode: not queueing outbound text", { chatGuid, textLen: text.length });
    return;
  }
  const db = getDb();
  await db.insert(outboundQueue).values({ chatGuid, text });
}
