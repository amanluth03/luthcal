import { eq } from "drizzle-orm";

import { getBridgeUrl } from "@/lib/bluebubbles";
import { getDb } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { processInboundMessage, type ProcessInboundMessageResult } from "@/lib/inbound-processor";

// REST-API poll backstop for app/api/cron/inbound: BlueBubbles Server runs
// in a second macOS session on the bridge laptop, and macOS throttles a
// switched-away session hard enough that its own message poller can stall
// for minutes-to-hours (its REST API keeps answering fine the whole time).
// This pulls recent messages from that REST API on a schedule and runs
// anything the webhook hasn't already handled through the same
// lib/inbound-processor.ts pipeline the webhook uses.

const WATERMARK_SETTINGS_KEY = "inbound_poll_watermark";
// First-run default: 30 minutes back, not "the beginning of time" — so a
// fresh deploy (no watermark row yet) doesn't replay the chat's entire
// history through the agent.
const DEFAULT_LOOKBACK_MS = 30 * 60 * 1000;
const FETCH_LIMIT = 50;
const FETCH_TIMEOUT_MS = 10_000;

interface BlueBubblesMessage {
  guid?: string;
  text?: string;
  isFromMe?: boolean;
  dateCreated?: number;
  handle?: { address?: string };
}

export interface PollInboundResult {
  fetched: number;
  processed: {
    engaged: number;
    silent: number;
    alreadyProcessed: number;
    droppedOwn: number;
    empty: number;
  };
}

export type PollInboundOutcome = PollInboundResult | { skipped: string; error?: string };

async function getWatermark(): Promise<number> {
  try {
    const db = getDb();
    const rows = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, WATERMARK_SETTINGS_KEY)).limit(1);
    const value = rows[0]?.value;
    if (typeof value === "number") return value;
  } catch {
    // No DB configured, or a transient failure — fall back to the default.
  }
  return Date.now() - DEFAULT_LOOKBACK_MS;
}

async function setWatermark(ms: number): Promise<void> {
  const db = getDb();
  await db
    .insert(settings)
    .values({ key: WATERMARK_SETTINGS_KEY, value: ms, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: ms, updatedAt: new Date() } });
}

function tallyProcessed(results: ProcessInboundMessageResult[]): PollInboundResult["processed"] {
  const processed = { engaged: 0, silent: 0, alreadyProcessed: 0, droppedOwn: 0, empty: 0 };
  for (const result of results) {
    if (result === "engaged") processed.engaged++;
    else if (result === "silent") processed.silent++;
    else if (result === "already-processed") processed.alreadyProcessed++;
    else if (result === "dropped-own") processed.droppedOwn++;
    else if (result === "empty") processed.empty++;
    // "wrong-chat" never happens here — every message this poller fetches
    // came from the FAMILY_CHAT_GUID chat's own message endpoint.
  }
  return processed;
}

/**
 * Pulls messages newer than the stored watermark from BlueBubbles' REST API
 * for the family chat, and runs each one through processInboundMessage
 * (which no-ops via its guid dedup check for anything the webhook already
 * handled). Safe to run concurrently with the webhook and with itself — see
 * lib/inbound-processor.ts's already-processed check and message_log's
 * imessage_guid index.
 */
export async function pollInboundMessages(): Promise<PollInboundOutcome> {
  const bridgeUrlEnv = process.env.BLUEBUBBLES_URL;
  const password = process.env.BLUEBUBBLES_PASSWORD;
  const familyChatGuid = process.env.FAMILY_CHAT_GUID;
  if (!bridgeUrlEnv || !password || !familyChatGuid) {
    return { skipped: "no bridge configured" };
  }

  const watermark = await getWatermark();
  // getBridgeUrl() (not the raw env var) so a rotated tunnel URL (see
  // lib/bluebubbles.ts's setBridgeUrl, updated by the webhook's "server URL
  // changed" handling) is picked up here too.
  const bridgeUrl = await getBridgeUrl();
  const endpoint =
    `${bridgeUrl.replace(/\/$/, "")}/api/v1/chat/${encodeURIComponent(familyChatGuid)}/message` +
    `?password=${encodeURIComponent(password)}&limit=${FETCH_LIMIT}&sort=DESC&after=${watermark}`;

  let response: Response;
  try {
    response = await fetch(endpoint, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    // Network-level failure — DNS, connection refused, or the timeout
    // firing. Exactly the "Mac is asleep / tunnel is down" case this sweep
    // exists to survive: routine, not an error worth failing the cron over.
    return { skipped: "bridge unreachable", error: err instanceof Error ? err.message : String(err) };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return { skipped: "bridge unreachable", error: `[${response.status}] ${body || response.statusText}` };
  }

  const body = (await response.json().catch(() => null)) as { data?: BlueBubblesMessage[] } | null;
  const messages = body?.data ?? [];

  // `after` is a supported, server-side-filtering BlueBubbles query param
  // (verified against bluebubbles-server's chatRouter/messageInterface
  // source), but this client-side filter is kept anyway as a defensive
  // belt-and-suspenders against an inclusive-boundary surprise re-fetching
  // the watermark message itself forever.
  const fresh = messages
    .filter((m): m is BlueBubblesMessage & { dateCreated: number } => typeof m.dateCreated === "number" && m.dateCreated > watermark)
    .sort((a, b) => a.dateCreated - b.dateCreated); // oldest -> newest, matching webhook delivery order.

  const results: ProcessInboundMessageResult[] = [];
  for (const m of fresh) {
    results.push(
      await processInboundMessage({
        imessageGuid: m.guid,
        chatGuid: familyChatGuid,
        senderHandle: m.handle?.address,
        text: typeof m.text === "string" ? m.text : "",
        isFromMe: m.isFromMe,
      }),
    );
  }

  if (messages.length > 0) {
    const maxSeen = messages.reduce((max, m) => (typeof m.dateCreated === "number" && m.dateCreated > max ? m.dateCreated : max), watermark);
    await setWatermark(maxSeen);
  }

  return { fetched: messages.length, processed: tallyProcessed(results) };
}
