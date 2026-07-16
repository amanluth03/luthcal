import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";

import type { RosterMember } from "@/lib/agent/match-member";

// ---------------------------------------------------------------------------
// BUG 2: Level-1 conversation memory. Two things under test:
//
//  - dedupeHistory (pure): the merge logic that stops the dashboard's
//    resent history from being doubled up with what loadRecentThreadHistory
//    pulls back from message_log.
//  - loadRecentThreadHistory: scope (thread = chatGuid, or NULL chatGuid for
//    "dashboard"), window (last N rows / last X ms), and sender-attribution
//    (name-prefixed only when chatGuid is set). Exercised against a fake
//    in-memory message_log, following the same real-drizzle-operators /
//    fake-query-builder pattern as tests/google/event-meta-dedup.test.ts, so
//    the actual production where/orderBy/limit logic runs for real.
// ---------------------------------------------------------------------------

interface FakeMessageLogRow {
  direction: "inbound" | "outbound";
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
import { dedupeHistory, HISTORY_MAX_AGE_MS, HISTORY_MESSAGE_LIMIT, loadRecentThreadHistory } from "@/lib/agent/history";

function seedRow(row: Partial<FakeMessageLogRow> & { direction: "inbound" | "outbound"; text: string; createdAt: Date }) {
  state.rows.push({ chatGuid: null, senderHandle: null, memberId: null, ...row });
}

beforeEach(() => {
  state.rows = [];
  state.throwOnGetDb = false;
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// dedupeHistory (pure)
// ---------------------------------------------------------------------------

describe("dedupeHistory(history, callerMessages)", () => {
  it("drops a history message whose (role, content) already appears in callerMessages", () => {
    const history: ModelMessage[] = [
      { role: "user", content: "book dentist tuesday" },
      { role: "assistant", content: "Done!" },
    ];
    const caller = [
      { role: "user" as const, content: "book dentist tuesday" },
      { role: "assistant" as const, content: "Done!" },
      { role: "user" as const, content: "actually move it to 4" },
    ];
    expect(dedupeHistory(history, caller)).toEqual([]);
  });

  it("passes through history the caller has no record of (the reload / iMessage case)", () => {
    const history: ModelMessage[] = [
      { role: "user", content: "book dentist tuesday" },
      { role: "assistant", content: "Done!" },
    ];
    const caller = [{ role: "user" as const, content: "actually move it to 4" }];
    expect(dedupeHistory(history, caller)).toEqual(history);
  });

  it("only drops an exact (role, content) match, not a same-role/different-content pair", () => {
    const history: ModelMessage[] = [{ role: "user", content: "book dentist tuesday" }];
    const caller = [{ role: "user" as const, content: "something else entirely" }];
    expect(dedupeHistory(history, caller)).toEqual(history);
  });
});

// ---------------------------------------------------------------------------
// loadRecentThreadHistory
// ---------------------------------------------------------------------------

const roster: RosterMember[] = [{ id: "m-aman", name: "Aman", aliases: [], imessageHandle: "aman@example.com", phone: null }];

describe("loadRecentThreadHistory(chatGuid, roster)", () => {
  it("scopes to the given chatGuid, excluding rows from other chats and NULL-chatGuid (dashboard) rows", async () => {
    seedRow({ direction: "inbound", chatGuid: "chat-a", text: "in chat a", createdAt: new Date() });
    seedRow({ direction: "inbound", chatGuid: "chat-b", text: "in chat b", createdAt: new Date() });
    seedRow({ direction: "inbound", chatGuid: null, text: "dashboard message", createdAt: new Date() });

    const history = await loadRecentThreadHistory("chat-a", []);
    expect(history).toHaveLength(1);
    expect(history[0].content).toBe("in chat a");
  });

  it("scopes to NULL chatGuid rows (dashboard thread) when chatGuid is undefined", async () => {
    seedRow({ direction: "inbound", chatGuid: "chat-a", text: "in chat a", createdAt: new Date() });
    seedRow({ direction: "inbound", chatGuid: null, text: "dashboard message", createdAt: new Date() });

    const history = await loadRecentThreadHistory(undefined, []);
    expect(history).toHaveLength(1);
    expect(history[0].content).toBe("dashboard message");
  });

  it("returns rows oldest-first even though they're queried newest-first (for the LIMIT)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T12:00:00Z"));

    seedRow({ direction: "inbound", chatGuid: "chat-a", text: "first", createdAt: new Date("2026-07-13T10:00:00Z") });
    seedRow({ direction: "outbound", chatGuid: "chat-a", text: "second", createdAt: new Date("2026-07-13T10:01:00Z") });
    seedRow({ direction: "inbound", chatGuid: "chat-a", text: "third", createdAt: new Date("2026-07-13T10:02:00Z") });

    const history = await loadRecentThreadHistory("chat-a", []);
    expect(history.map((m) => m.content)).toEqual(["first", "second", "third"]);
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("excludes rows older than HISTORY_MAX_AGE_MS", async () => {
    const now = new Date("2026-07-13T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    seedRow({ direction: "inbound", chatGuid: "chat-a", text: "recent", createdAt: new Date(now.getTime() - 1000) });
    seedRow({
      direction: "inbound",
      chatGuid: "chat-a",
      text: "stale",
      createdAt: new Date(now.getTime() - HISTORY_MAX_AGE_MS - 1000),
    });

    const history = await loadRecentThreadHistory("chat-a", []);
    expect(history.map((m) => m.content)).toEqual(["recent"]);
  });

  it("caps at HISTORY_MESSAGE_LIMIT, keeping the most recent rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T12:00:10Z"));

    const base = new Date("2026-07-13T12:00:00Z").getTime();
    for (let i = 0; i < HISTORY_MESSAGE_LIMIT + 5; i++) {
      seedRow({ direction: "inbound", chatGuid: "chat-a", text: `msg-${i}`, createdAt: new Date(base + i * 1000) });
    }

    const history = await loadRecentThreadHistory("chat-a", []);
    expect(history).toHaveLength(HISTORY_MESSAGE_LIMIT);
    // Oldest 5 (msg-0..msg-4) fall outside the LIMIT-most-recent window.
    expect(history[0].content).toBe("msg-5");
    expect(history[history.length - 1].content).toBe(`msg-${HISTORY_MESSAGE_LIMIT + 4}`);
  });

  it("prefixes inbound messages with the resolved member's name when chatGuid is set (multi-sender iMessage thread)", async () => {
    seedRow({
      direction: "inbound",
      chatGuid: "chat-a",
      memberId: "m-aman",
      senderHandle: "aman@example.com",
      text: "dentist for Maya tuesday",
      createdAt: new Date(),
    });

    const history = await loadRecentThreadHistory("chat-a", roster);
    expect(history[0].content).toBe("Aman: dentist for Maya tuesday");
  });

  it("falls back to the raw senderHandle when memberId doesn't resolve to a roster name", async () => {
    seedRow({
      direction: "inbound",
      chatGuid: "chat-a",
      memberId: null,
      senderHandle: "+15125550199",
      text: "hi",
      createdAt: new Date(),
    });

    const history = await loadRecentThreadHistory("chat-a", roster);
    expect(history[0].content).toBe("+15125550199: hi");
  });

  it("does NOT prefix dashboard (NULL chatGuid) history, even with a resolvable member", async () => {
    seedRow({
      direction: "inbound",
      chatGuid: null,
      memberId: "m-aman",
      senderHandle: "aman@example.com",
      text: "book dentist",
      createdAt: new Date(),
    });

    const history = await loadRecentThreadHistory(undefined, roster);
    expect(history[0].content).toBe("book dentist");
  });

  it("degrades to [] (no throw) when getDb() throws — e.g. no DATABASE_URL set", async () => {
    state.throwOnGetDb = true;
    await expect(loadRecentThreadHistory("chat-a", [])).resolves.toEqual([]);
  });
});
