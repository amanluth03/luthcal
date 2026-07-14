import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { settings } from "@/lib/db/schema";

// BlueBubbles REST send client. Endpoint/body shape per the BlueBubbles
// server's documented REST API:
//   POST {serverUrl}/api/v1/message/text?password={password}
//   body: { chatGuid, tempGuid, message, method }
// (https://docs.bluebubbles.app/server/developer-guides/rest-api-and-webhooks
// — the full request/response schema lives in the linked Postman collection,
// which is a JS-rendered SPA this environment couldn't fetch directly; the
// shape above is cross-checked against BlueBubblesApp/bluebubbles-server
// issue reports and third-party integration examples that show the same
// `chatGuid`/`tempGuid`/`message`/`method` body and `?password=` query auth.
// Worth a one-time spot-check against a live server during setup — see
// docs/bluebubbles-setup.md.)

const SETTINGS_KEY_BRIDGE_URL = "bluebubbles_url";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

/**
 * Reads the current BlueBubbles bridge URL. Prefers a value persisted in the
 * `settings` table (updated by the inbound webhook when BlueBubbles reports
 * its "server URL changed" event — its tunnel URL rotates, e.g. a fresh
 * Cloudflare Tunnel/ngrok hostname), falling back to the BLUEBUBBLES_URL env
 * var. Best-effort: any DB read failure (no DATABASE_URL configured, a
 * transient error) silently falls back to env rather than throwing, mirroring
 * getDb()'s lazy-safe-to-import posture.
 */
export async function getBridgeUrl(): Promise<string> {
  try {
    const db = getDb();
    const rows = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, SETTINGS_KEY_BRIDGE_URL))
      .limit(1);
    const stored = rows[0]?.value;
    if (typeof stored === "string" && stored.length > 0) return stored;
  } catch {
    // No DB configured, or a transient failure — fall back to env.
  }
  return requireEnv("BLUEBUBBLES_URL");
}

/**
 * Persists a new bridge URL. Called by the inbound webhook route when
 * BlueBubbles reports its server URL changed, so subsequent sends (and the
 * outbound queue retry sweep) target the new tunnel URL without redeploying.
 */
export async function setBridgeUrl(url: string): Promise<void> {
  const db = getDb();
  await db
    .insert(settings)
    .values({ key: SETTINGS_KEY_BRIDGE_URL, value: url, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: url, updatedAt: new Date() } });
}

function getPassword(): string {
  return requireEnv("BLUEBUBBLES_PASSWORD");
}

/** "apple-script" works out of the box on a stock BlueBubbles install (simple
 * group sends only); "private-api" needs SIP disabled on the Mac but gets
 * richer delivery/read-receipt behavior — see docs/bluebubbles-setup.md.
 * Defaults to "apple-script" so sends work without extra Mac configuration;
 * override via BLUEBUBBLES_SEND_METHOD once Private API is set up. */
export type SendMethod = "apple-script" | "private-api";

function getSendMethod(): SendMethod {
  return process.env.BLUEBUBBLES_SEND_METHOD === "private-api" ? "private-api" : "apple-script";
}

export type SendResult =
  | { ok: true; guid: string }
  | { ok: false; status: number; error: string; retryable: boolean };

// F1 (tech-lead follow-up): the fetch below previously had no timeout, so a
// dead tunnel / black-holed connection to the Mac could hang for the entire
// remaining function budget, starving every other row still waiting in the
// same outbound-processor batch. AbortSignal.timeout below bounds a single
// send attempt; the resulting AbortError is caught by the existing
// network-failure branch and returned as a normal, retryable SendResult —
// never thrown up to abort the batch.
const SEND_TIMEOUT_MS = 10_000;

/**
 * Sends a text message to an iMessage chat via the BlueBubbles REST API.
 * Returns a discriminated result rather than throwing on a failed send — the
 * outbound queue processor (lib/outbound-processor.ts) decides retry vs.
 * give-up based on `retryable`, and a "the Mac is asleep" failure here is an
 * expected, routine condition, not an exceptional one. A request that hangs
 * past `SEND_TIMEOUT_MS` (dead tunnel, black-holed connection) is treated the
 * same way — see the note above.
 *
 * Throws only for a genuine misconfiguration (BLUEBUBBLES_URL/PASSWORD
 * unset) — that's a setup bug, not a transient send failure, so it's
 * surfaced loudly rather than silently queued forever.
 */
export async function sendGroupMessage(chatGuid: string, text: string): Promise<SendResult> {
  const bridgeUrl = await getBridgeUrl();
  const password = getPassword();
  const method = getSendMethod();

  const endpoint = `${bridgeUrl.replace(/\/$/, "")}/api/v1/message/text?password=${encodeURIComponent(password)}`;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatGuid,
        tempGuid: randomUUID(),
        message: text,
        method,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (err) {
    // Network-level failure — DNS, connection refused, timeout, or the
    // SEND_TIMEOUT_MS abort firing. This is exactly the "Mac is asleep /
    // tunnel is down" case the outbound_queue exists for: always retryable.
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
      retryable: true,
    };
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    // 4xx (bad password, malformed chatGuid/body) won't be fixed by
    // retrying the same request; 5xx is a transient server-side issue on
    // the Mac and is worth retrying.
    const retryable = response.status >= 500;
    return { ok: false, status: response.status, error: bodyText || response.statusText, retryable };
  }

  const body = (await response.json().catch(() => null)) as { data?: { guid?: string } } | null;
  return { ok: true, guid: body?.data?.guid ?? "" };
}
