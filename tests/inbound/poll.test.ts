import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// lib/inbound-poll.ts pollInboundMessages() is the REST-API poll backstop
// (app/api/cron/inbound) for when BlueBubbles Server's own webhook poller
// stalls (a switched-away second macOS session throttles its message poller
// for minutes-to-hours, even though its REST API keeps answering — see
// docs/bluebubbles-setup.md). Covers: skip-when-unconfigured, the watermark
// default/read/advance-on-success-only behavior, oldest->newest processing
// order regardless of what order the (mocked) BlueBubbles API returns
// messages in, and graceful (200-shaped) handling of a fetch failure.
//
// `@/lib/inbound-processor` (processInboundMessage) and `@/lib/bluebubbles`
// (getBridgeUrl) are mocked directly; `settings` reads/writes go through a
// small in-memory fake over `@/lib/db`, same fake-query-builder spirit as
// tests/agent/history.test.ts. `fetch` itself is mocked globally.
// ---------------------------------------------------------------------------

interface FakeSettingsRow {
  key: string;
  value: unknown;
}

const state = vi.hoisted(() => ({ settingsRows: [] as FakeSettingsRow[] }));

vi.mock("drizzle-orm", () => ({
  eq: (column: unknown, value: unknown) => ({ op: "eq" as const, column, value }),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select(projection: Record<string, unknown>) {
      return {
        from() {
          return {
            where(cond: { value: string }) {
              return {
                limit(n: number) {
                  const rows = state.settingsRows
                    .filter((r) => r.key === cond.value)
                    .map((r) => {
                      const out: Record<string, unknown> = {};
                      for (const outKey of Object.keys(projection)) out[outKey] = r.value;
                      return out;
                    });
                  return Promise.resolve(rows.slice(0, n));
                },
              };
            },
          };
        },
      };
    },
    insert() {
      return {
        values(vals: { key: string; value: unknown }) {
          return {
            onConflictDoUpdate({ set }: { set: { value: unknown } }) {
              const existing = state.settingsRows.find((r) => r.key === vals.key);
              if (existing) existing.value = set.value;
              else state.settingsRows.push({ key: vals.key, value: vals.value });
              return Promise.resolve();
            },
          };
        },
      };
    },
  }),
}));

const processInboundMessageMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/inbound-processor", () => ({ processInboundMessage: processInboundMessageMock }));

const getBridgeUrlMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/bluebubbles", () => ({ getBridgeUrl: getBridgeUrlMock }));

// Imported AFTER the mocks above so the module under test picks them up.
import { pollInboundMessages } from "@/lib/inbound-poll";

const FAMILY_CHAT = "iMessage;+;chat123";

function mockFetchOnce(response: { ok: boolean; status?: number; json?: () => Promise<unknown>; text?: () => Promise<string> }) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    json: response.json ?? (async () => ({ data: [] })),
    text: response.text ?? (async () => ""),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  state.settingsRows = [];
  processInboundMessageMock.mockReset();
  processInboundMessageMock.mockResolvedValue("engaged");
  getBridgeUrlMock.mockReset();
  getBridgeUrlMock.mockResolvedValue("https://bridge.example.com");
  vi.stubEnv("BLUEBUBBLES_URL", "https://bridge.example.com");
  vi.stubEnv("BLUEBUBBLES_PASSWORD", "s3cret");
  vi.stubEnv("FAMILY_CHAT_GUID", FAMILY_CHAT);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("pollInboundMessages — skip when not configured", () => {
  it("skips quietly when BLUEBUBBLES_URL is unset", async () => {
    vi.stubEnv("BLUEBUBBLES_URL", "");
    const fetchMock = mockFetchOnce({ ok: true });
    const result = await pollInboundMessages();
    expect(result).toEqual({ skipped: "no bridge configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips quietly when BLUEBUBBLES_PASSWORD is unset", async () => {
    vi.stubEnv("BLUEBUBBLES_PASSWORD", "");
    const result = await pollInboundMessages();
    expect(result).toEqual({ skipped: "no bridge configured" });
  });

  it("skips quietly when FAMILY_CHAT_GUID is unset", async () => {
    vi.stubEnv("FAMILY_CHAT_GUID", "");
    const result = await pollInboundMessages();
    expect(result).toEqual({ skipped: "no bridge configured" });
  });
});

describe("pollInboundMessages — the fetch it makes", () => {
  it("GETs /api/v1/chat/{encoded guid}/message with password, limit=50, sort=DESC, and after=<watermark>", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T12:00:00Z"));
    const fetchMock = mockFetchOnce({ ok: true, json: async () => ({ data: [] }) });

    await pollInboundMessages();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(`https://bridge.example.com/api/v1/chat/${encodeURIComponent(FAMILY_CHAT)}/message`);
    expect(parsed.searchParams.get("password")).toBe("s3cret");
    expect(parsed.searchParams.get("limit")).toBe("50");
    expect(parsed.searchParams.get("sort")).toBe("DESC");
    // First run, no watermark row yet: defaults to now - 30 minutes.
    expect(parsed.searchParams.get("after")).toBe(String(new Date("2026-09-07T11:30:00Z").getTime()));
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses the persisted watermark instead of the default once one exists", async () => {
    state.settingsRows.push({ key: "inbound_poll_watermark", value: 1_700_000_000_000 });
    const fetchMock = mockFetchOnce({ ok: true, json: async () => ({ data: [] }) });

    await pollInboundMessages();

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(new URL(url).searchParams.get("after")).toBe("1700000000000");
  });

  it("uses getBridgeUrl() (settings-stored, tunnel-rotation-aware) rather than the raw env var", async () => {
    getBridgeUrlMock.mockResolvedValue("https://rotated.example.com");
    const fetchMock = mockFetchOnce({ ok: true, json: async () => ({ data: [] }) });

    await pollInboundMessages();

    expect(new URL((fetchMock.mock.calls[0] as [string])[0]).origin).toBe("https://rotated.example.com");
  });
});

describe("pollInboundMessages — bridge unreachable", () => {
  it("returns {skipped, error} (not a throw) when fetch itself rejects (Mac asleep / tunnel down)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("fetch failed")),
    );
    const result = await pollInboundMessages();
    expect(result).toMatchObject({ skipped: "bridge unreachable" });
    expect((result as { error?: string }).error).toContain("fetch failed");
    expect(processInboundMessageMock).not.toHaveBeenCalled();
  });

  it("returns {skipped, error} for a non-2xx HTTP response", async () => {
    mockFetchOnce({ ok: false, status: 502, text: async () => "Bad Gateway" });
    const result = await pollInboundMessages();
    expect(result).toMatchObject({ skipped: "bridge unreachable" });
    expect(processInboundMessageMock).not.toHaveBeenCalled();
  });
});

describe("pollInboundMessages — ordering, dispatch, and watermark advance", () => {
  it("processes messages oldest -> newest regardless of the order BlueBubbles returned them in", async () => {
    state.settingsRows.push({ key: "inbound_poll_watermark", value: 0 });
    mockFetchOnce({
      ok: true,
      json: async () => ({
        data: [
          { guid: "g-newest", text: "third", isFromMe: false, dateCreated: 3000, handle: { address: "a@example.com" } },
          { guid: "g-oldest", text: "first", isFromMe: false, dateCreated: 1000, handle: { address: "a@example.com" } },
          { guid: "g-middle", text: "second", isFromMe: false, dateCreated: 2000, handle: { address: "a@example.com" } },
        ],
      }),
    });

    await pollInboundMessages();

    expect(processInboundMessageMock).toHaveBeenCalledTimes(3);
    expect(processInboundMessageMock.mock.calls.map((c) => c[0].imessageGuid)).toEqual(["g-oldest", "g-middle", "g-newest"]);
  });

  it("passes chatGuid = FAMILY_CHAT_GUID and threads guid/text/isFromMe/senderHandle through to processInboundMessage", async () => {
    state.settingsRows.push({ key: "inbound_poll_watermark", value: 0 });
    mockFetchOnce({
      ok: true,
      json: async () => ({
        data: [{ guid: "g-1", text: "Maya has dentist Tuesday 3pm", isFromMe: false, dateCreated: 5000, handle: { address: "aman@example.com" } }],
      }),
    });

    await pollInboundMessages();

    expect(processInboundMessageMock).toHaveBeenCalledWith({
      imessageGuid: "g-1",
      chatGuid: FAMILY_CHAT,
      senderHandle: "aman@example.com",
      text: "Maya has dentist Tuesday 3pm",
      isFromMe: false,
    });
  });

  it("advances the watermark in settings to the max dateCreated seen", async () => {
    state.settingsRows.push({ key: "inbound_poll_watermark", value: 0 });
    mockFetchOnce({
      ok: true,
      json: async () => ({
        data: [
          { guid: "g-1", text: "a", isFromMe: false, dateCreated: 1000, handle: {} },
          { guid: "g-2", text: "b", isFromMe: false, dateCreated: 4000, handle: {} },
        ],
      }),
    });

    await pollInboundMessages();

    expect(state.settingsRows.find((r) => r.key === "inbound_poll_watermark")?.value).toBe(4000);
  });

  it("does NOT touch the watermark when zero messages were fetched", async () => {
    state.settingsRows.push({ key: "inbound_poll_watermark", value: 1000 });
    mockFetchOnce({ ok: true, json: async () => ({ data: [] }) });

    await pollInboundMessages();

    expect(state.settingsRows.find((r) => r.key === "inbound_poll_watermark")?.value).toBe(1000);
  });

  it("tallies the returned outcomes into processed.{engaged,silent,alreadyProcessed,droppedOwn,empty} and reports fetched", async () => {
    processInboundMessageMock
      .mockResolvedValueOnce("engaged")
      .mockResolvedValueOnce("silent")
      .mockResolvedValueOnce("already-processed")
      .mockResolvedValueOnce("dropped-own")
      .mockResolvedValueOnce("empty");
    state.settingsRows.push({ key: "inbound_poll_watermark", value: 0 });
    mockFetchOnce({
      ok: true,
      json: async () => ({
        data: [
          { guid: "g-1", text: "a", isFromMe: false, dateCreated: 1000, handle: {} },
          { guid: "g-2", text: "b", isFromMe: false, dateCreated: 2000, handle: {} },
          { guid: "g-3", text: "c", isFromMe: false, dateCreated: 3000, handle: {} },
          { guid: "g-4", text: "d", isFromMe: true, dateCreated: 4000, handle: {} },
          { guid: "g-5", text: "", isFromMe: false, dateCreated: 5000, handle: {} },
        ],
      }),
    });

    const result = await pollInboundMessages();

    expect(result).toEqual({
      fetched: 5,
      processed: { engaged: 1, silent: 1, alreadyProcessed: 1, droppedOwn: 1, empty: 1 },
    });
  });
});
