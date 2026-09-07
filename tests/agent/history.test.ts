import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RosterMember } from "@/lib/agent/match-member";

// ---------------------------------------------------------------------------
// Shared memory across channels, section 1 (docs/superpowers/specs/2026-09-07-shared-memory-design.md):
// one family thread instead of one thread per channel. Four things under test:
//
//  - dedupeHistory (pure): filters raw ThreadHistoryRow entries against the
//    caller-resent messages, BEFORE any sender-name prefix is applied (the
//    prefix is now applied uniformly to both channels by formatHistory, so
//    dedup has to run on the underlying raw text or it would never match).
//  - loadRecentThreadHistory: family-thread scope (dashboard rows always in
//    scope; iMessage rows in scope for the run's own family chat), the
//    30-row/7-day window, and per-row sender-label resolution (now for BOTH
//    channels, not iMessage-only).
//  - formatHistory: turns loaded rows into ModelMessage[], adding a
//    "(via iMessage)"/"(via dashboard)" tag only when a row's channel
//    differs from the current run's channel.
//  - loadLastOutboundMessage: unchanged — the passive-listener engagement
//    gate's single-row helper.
// ---------------------------------------------------------------------------

interface FakeMessageLogRow {
  direction: "inbound" | "outbound";
  source: "imessage" | "dashboard" | null;
  chatGuid: string | null;
  senderHandle: string | null;
  memberId: string | null;
  text: string;
  createdAt: Date;
}

const state = vi.hoisted(() => ({ rows: [] as FakeMessageLogRow[], throwOnGetDb: false }));

vi.mock("drizzle-orm", () => ({
  eq: (column: unknown, value: unknown) => ({ op: "eq" as const, column, value }),
  isNull: (column: unknown) => ({ op: "isNull" as const, column }),
  gte: (column: unknown, value: unknown) => ({ op: "gte" as const, column, value }),
  and: (...conds: unknown[]) => ({ op: "and" as const, conds }),
  or: (...conds: unknown[]) => ({ op: "or" as const, conds }),
  desc: (column: unknown) => ({ op: "desc" as const, column }),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => {
    if (state.throwOnGetDb) throw new Error("DATABASE_URL is not set");
    function columnKey(column: unknown): keyof FakeMessageLogRow {
      const entry = Object.entries(messageLog).find(([, col]) => col === column);
      if (!entry) throw new Error("fake db: unrecognized column reference");
      return entry[0] as keyof FakeMessageLogRow;
    }
    function matches(row: FakeMessageLogRow, cond: unknown): boolean {
      if (!cond) return true;
      const c = cond as { op: string; column?: unknown; value?: unknown; conds?: unknown[] };
      if (c.op === "and") return (c.conds ?? []).every((sub) => matches(row, sub));
      if (c.op === "or") return (c.conds ?? []).some((sub) => matches(row, sub));
      const key = columnKey(c.column);
      if (c.op === "eq") return row[key] === c.value;
      if (c.op === "isNull") return row[key] == null;
      if (c.op === "gte") return (row[key] as Date) >= (c.value as Date);
      throw new Error(`fake db: unhandled condition op ${c.op}`);
    }
    return {
      select(projection: Record<string, unknown>) {
        return {
          from() {
            return {
              where(cond: unknown) {
                const filtered = state.rows.filter((r) => matches(r, cond));
                return {
                  orderBy(orderSpec: { op: string; column: unknown }) {
                    const key = columnKey(orderSpec.column);
                    const sorted = [...filtered].sort((a, b) => {
                      const av = a[key] as Date;
                      const bv = b[key] as Date;
                      const diff = av.getTime() - bv.getTime();
                      return orderSpec.op === "desc" ? -diff : diff;
                    });
                    return {
                      limit(n: number) {
                        return Promise.resolve(
                          sorted.slice(0, n).map((r) => {
                            const out: Record<string, unknown> = {};
                            for (const [outKey, col] of Object.entries(projection)) {
                              out[outKey] = r[columnKey(col)];
                            }
                            return out;
                          }),
                        );
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
    };
  },
}));

// Imported AFTER the mocks above so the module under test picks them up.
import { messageLog } from "@/lib/db/schema";
import {
  dedupeHistory,
  formatHistory,
  HISTORY_MAX_AGE_MS,
  HISTORY_MESSAGE_LIMIT,
  loadLastOutboundMessage,
  loadRecentThreadHistory,
  type ThreadHistoryRow,
} from "@/lib/agent/history";

function seedRow(row: Partial<FakeMessageLogRow> & { direction: "inbound" | "outbound"; text: string; createdAt: Date }) {
  state.rows.push({ source: null, chatGuid: null, senderHandle: null, memberId: null, ...row });
}

beforeEach(() => {
  state.rows = [];
  state.throwOnGetDb = false;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// dedupeHistory (pure)
// ---------------------------------------------------------------------------

describe("dedupeHistory(rows, callerMessages)", () => {
  it("drops a row whose (direction-as-role, raw text) already appears in callerMessages", () => {
    const rows: ThreadHistoryRow[] = [
      { direction: "inbound", text: "book dentist tuesday", senderLabel: "Aman", source: "dashboard" },
      { direction: "outbound", text: "Done!", source: "dashboard" },
    ];
    const caller = [
      { role: "user" as const, content: "book dentist tuesday" },
      { role: "assistant" as const, content: "Done!" },
      { role: "user" as const, content: "actually move it to 4" },
    ];
    expect(dedupeHistory(rows, caller)).toEqual([]);
  });

  it("passes through rows the caller has no record of", () => {
    const rows: ThreadHistoryRow[] = [{ direction: "inbound", text: "book dentist tuesday", senderLabel: "Aman", source: "dashboard" }];
    const caller = [{ role: "user" as const, content: "actually move it to 4" }];
    expect(dedupeHistory(rows, caller)).toEqual(rows);
  });

  it("only drops an exact (role, raw text) match, not a same-role/different-content pair", () => {
    const rows: ThreadHistoryRow[] = [{ direction: "inbound", text: "book dentist tuesday", source: "dashboard" }];
    const caller = [{ role: "user" as const, content: "something else entirely" }];
    expect(dedupeHistory(rows, caller)).toEqual(rows);
  });

  it("dedupes on RAW text, before any sender-name prefix would be applied", () => {
    // If dedup ran on formatted ("Aman: book dentist tuesday") instead of raw
    // text, this would fail to match the caller's unprefixed resend.
    const rows: ThreadHistoryRow[] = [{ direction: "inbound", text: "book dentist tuesday", senderLabel: "Aman", source: "dashboard" }];
    const caller = [{ role: "user" as const, content: "book dentist tuesday" }];
    expect(dedupeHistory(rows, caller)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// loadRecentThreadHistory — family-thread scope
// ---------------------------------------------------------------------------

const roster: RosterMember[] = [
  { id: "m-aman", name: "Aman", aliases: [], imessageHandle: "aman@example.com", phone: null },
  { id: "m-vijay", name: "Vijay", aliases: [], imessageHandle: null, phone: "+15125550100" },
];

describe("loadRecentThreadHistory(source, chatGuid, roster) — family-thread scope", () => {
  it("iMessage run: includes dashboard rows and this chat's iMessage rows; excludes other chats", async () => {
    seedRow({ direction: "inbound", source: "imessage", chatGuid: "chat-a", text: "in chat a", createdAt: new Date() });
    seedRow({ direction: "inbound", source: "imessage", chatGuid: "chat-b", text: "in chat b", createdAt: new Date() });
    seedRow({ direction: "inbound", source: "dashboard", chatGuid: null, text: "dashboard message", createdAt: new Date() });

    const history = await loadRecentThreadHistory("imessage", "chat-a", []);
    expect(history.map((r) => r.text).sort()).toEqual(["dashboard message", "in chat a"].sort());
  });

  it("dashboard run: includes dashboard rows and FAMILY_CHAT_GUID's iMessage rows when set", async () => {
    vi.stubEnv("FAMILY_CHAT_GUID", "chat-a");
    seedRow({ direction: "inbound", source: "imessage", chatGuid: "chat-a", text: "in the family chat", createdAt: new Date() });
    seedRow({ direction: "inbound", source: "imessage", chatGuid: "chat-b", text: "in some other chat", createdAt: new Date() });
    seedRow({ direction: "inbound", source: "dashboard", chatGuid: null, text: "dashboard message", createdAt: new Date() });

    const history = await loadRecentThreadHistory("dashboard", undefined, []);
    expect(history.map((r) => r.text).sort()).toEqual(["dashboard message", "in the family chat"].sort());
  });

  it("dashboard run: falls back to dashboard-only scope when FAMILY_CHAT_GUID is unset", async () => {
    seedRow({ direction: "inbound", source: "imessage", chatGuid: "chat-a", text: "in chat a", createdAt: new Date() });
    seedRow({ direction: "inbound", source: "dashboard", chatGuid: null, text: "dashboard message", createdAt: new Date() });

    const history = await loadRecentThreadHistory("dashboard", undefined, []);
    expect(history.map((r) => r.text)).toEqual(["dashboard message"]);
  });

  it("F1: rows with no source at all (written before the column existed) match neither scope", async () => {
    seedRow({ direction: "inbound", source: null, chatGuid: "chat-a", text: "pre-migration row", createdAt: new Date() });

    expect(await loadRecentThreadHistory("imessage", "chat-a", [])).toEqual([]);
    expect(await loadRecentThreadHistory("dashboard", undefined, [])).toEqual([]);
  });

  it("returns rows oldest-first even though they're queried newest-first (for the LIMIT)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T12:00:00Z"));

    seedRow({ direction: "inbound", source: "imessage", chatGuid: "chat-a", text: "first", createdAt: new Date("2026-07-13T10:00:00Z") });
    seedRow({ direction: "outbound", source: "imessage", chatGuid: "chat-a", text: "second", createdAt: new Date("2026-07-13T10:01:00Z") });
    seedRow({ direction: "inbound", source: "imessage", chatGuid: "chat-a", text: "third", createdAt: new Date("2026-07-13T10:02:00Z") });

    const history = await loadRecentThreadHistory("imessage", "chat-a", []);
    expect(history.map((m) => m.text)).toEqual(["first", "second", "third"]);
    expect(history.map((m) => m.direction)).toEqual(["inbound", "outbound", "inbound"]);
  });

  it("excludes rows older than HISTORY_MAX_AGE_MS (7 days)", async () => {
    const now = new Date("2026-07-13T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    seedRow({ direction: "inbound", source: "imessage", chatGuid: "chat-a", text: "recent", createdAt: new Date(now.getTime() - 1000) });
    seedRow({
      direction: "inbound",
      source: "imessage",
      chatGuid: "chat-a",
      text: "stale",
      createdAt: new Date(now.getTime() - HISTORY_MAX_AGE_MS - 1000),
    });

    const history = await loadRecentThreadHistory("imessage", "chat-a", []);
    expect(history.map((m) => m.text)).toEqual(["recent"]);
  });

  it("HISTORY_MAX_AGE_MS is 7 days and HISTORY_MESSAGE_LIMIT is 30", () => {
    expect(HISTORY_MAX_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(HISTORY_MESSAGE_LIMIT).toBe(30);
  });

  it("caps at HISTORY_MESSAGE_LIMIT, keeping the most recent rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T12:00:10Z"));

    const base = new Date("2026-07-13T12:00:00Z").getTime();
    for (let i = 0; i < HISTORY_MESSAGE_LIMIT + 5; i++) {
      seedRow({ direction: "inbound", source: "imessage", chatGuid: "chat-a", text: `msg-${i}`, createdAt: new Date(base + i * 1000) });
    }

    const history = await loadRecentThreadHistory("imessage", "chat-a", []);
    expect(history).toHaveLength(HISTORY_MESSAGE_LIMIT);
    expect(history[0].text).toBe("msg-5");
    expect(history[history.length - 1].text).toBe(`msg-${HISTORY_MESSAGE_LIMIT + 4}`);
  });

  it("resolves a sender label for inbound rows from BOTH channels (roster name, falling back to raw handle)", async () => {
    const now = Date.now();
    seedRow({
      direction: "inbound",
      source: "imessage",
      chatGuid: "chat-a",
      memberId: "m-aman",
      senderHandle: "aman@example.com",
      text: "dentist for Maya tuesday",
      createdAt: new Date(now - 3000),
    });
    seedRow({
      direction: "inbound",
      source: "dashboard",
      chatGuid: null,
      memberId: "m-vijay",
      senderHandle: "vijay@example.com",
      text: "book dentist",
      createdAt: new Date(now - 2000),
    });
    seedRow({
      direction: "inbound",
      source: "imessage",
      chatGuid: "chat-a",
      memberId: null,
      senderHandle: "+15125550199",
      text: "hi",
      createdAt: new Date(now - 1000),
    });

    const history = await loadRecentThreadHistory("imessage", "chat-a", roster);
    expect(history.map((r) => r.senderLabel)).toEqual(["Aman", "Vijay", "+15125550199"]);
  });

  it("outbound rows carry no senderLabel", async () => {
    seedRow({ direction: "outbound", source: "imessage", chatGuid: "chat-a", text: "Done!", createdAt: new Date() });
    const history = await loadRecentThreadHistory("imessage", "chat-a", roster);
    expect(history[0].senderLabel).toBeUndefined();
  });

  it("degrades to [] (no throw) when getDb() throws — e.g. no DATABASE_URL set", async () => {
    state.throwOnGetDb = true;
    await expect(loadRecentThreadHistory("imessage", "chat-a", [])).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// formatHistory — attribution + cross-channel tag
// ---------------------------------------------------------------------------

describe("formatHistory(rows, currentSource)", () => {
  it("prefixes an inbound row's own-channel text with just the sender label", () => {
    const rows: ThreadHistoryRow[] = [{ direction: "inbound", text: "dentist for Maya tuesday", senderLabel: "Aman", source: "imessage" }];
    expect(formatHistory(rows, "imessage")).toEqual([{ role: "user", content: "Aman: dentist for Maya tuesday" }]);
  });

  it("tags a cross-channel row '(via iMessage)' when formatting for a dashboard run", () => {
    const rows: ThreadHistoryRow[] = [{ direction: "inbound", text: "book dentist", senderLabel: "Vijay", source: "imessage" }];
    expect(formatHistory(rows, "dashboard")).toEqual([{ role: "user", content: "Vijay (via iMessage): book dentist" }]);
  });

  it("tags a cross-channel row '(via dashboard)' when formatting for an iMessage run", () => {
    const rows: ThreadHistoryRow[] = [{ direction: "inbound", text: "book dentist", senderLabel: "Aman", source: "dashboard" }];
    expect(formatHistory(rows, "imessage")).toEqual([{ role: "user", content: "Aman (via dashboard): book dentist" }]);
  });

  it("does not tag a same-channel row even for a dashboard row formatted for a dashboard run", () => {
    const rows: ThreadHistoryRow[] = [{ direction: "inbound", text: "book dentist", senderLabel: "Aman", source: "dashboard" }];
    expect(formatHistory(rows, "dashboard")).toEqual([{ role: "user", content: "Aman: book dentist" }]);
  });

  it("renders outbound rows as plain assistant messages, untagged and unprefixed", () => {
    const rows: ThreadHistoryRow[] = [{ direction: "outbound", text: "Done!", source: "imessage" }];
    expect(formatHistory(rows, "dashboard")).toEqual([{ role: "assistant", content: "Done!" }]);
  });

  it("leaves an inbound row with no resolvable senderLabel unprefixed", () => {
    const rows: ThreadHistoryRow[] = [{ direction: "inbound", text: "hi", source: "dashboard" }];
    expect(formatHistory(rows, "dashboard")).toEqual([{ role: "user", content: "hi" }]);
  });
});

// ---------------------------------------------------------------------------
// loadLastOutboundMessage — unchanged, the narrower single-row helper the
// passive-listener engagement gate (lib/agent/engagement.ts) uses for its
// pending-confirmation check.
// ---------------------------------------------------------------------------

describe("loadLastOutboundMessage(chatGuid)", () => {
  it("returns the most recent outbound row for that chat", async () => {
    seedRow({ direction: "outbound", source: "imessage", chatGuid: "chat-a", text: "older reply", createdAt: new Date("2026-07-13T10:00:00Z") });
    seedRow({ direction: "outbound", source: "imessage", chatGuid: "chat-a", text: "newer reply?", createdAt: new Date("2026-07-13T10:05:00Z") });

    const result = await loadLastOutboundMessage("chat-a");
    expect(result).not.toBeNull();
    expect(result?.text).toBe("newer reply?");
    expect(result?.createdAt).toEqual(new Date("2026-07-13T10:05:00Z"));
  });

  it("ignores inbound rows and rows from a different chat", async () => {
    seedRow({ direction: "inbound", source: "imessage", chatGuid: "chat-a", text: "user said this", createdAt: new Date() });
    seedRow({ direction: "outbound", source: "imessage", chatGuid: "chat-b", text: "reply in a different chat", createdAt: new Date() });

    expect(await loadLastOutboundMessage("chat-a")).toBeNull();
  });

  it("ignores dashboard-source rows even if chatGuid somehow matched", async () => {
    seedRow({ direction: "outbound", source: "dashboard", chatGuid: "chat-a", text: "dashboard reply", createdAt: new Date() });

    expect(await loadLastOutboundMessage("chat-a")).toBeNull();
  });

  it("returns null when there is no outbound message yet", async () => {
    expect(await loadLastOutboundMessage("chat-a")).toBeNull();
  });

  it("degrades to null (no throw) when getDb() throws", async () => {
    state.throwOnGetDb = true;
    await expect(loadLastOutboundMessage("chat-a")).resolves.toBeNull();
  });
});
