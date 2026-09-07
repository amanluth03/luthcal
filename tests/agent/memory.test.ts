import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RosterMember } from "@/lib/agent/match-member";

// ---------------------------------------------------------------------------
// Durable memory across sessions (docs/superpowers/specs/2026-09-07-shared-
// memory-design.md §2). Five things under test, against a fake in-memory
// `family_memory` + `message_log`, following the same real-drizzle-
// operators / fake-query-builder pattern as tests/agent/history.test.ts and
// tests/google/event-meta-dedup.test.ts:
//
//  - formatMemoriesForPrompt (pure): the prompt block, and its "nothing
//    remembered yet" empty case.
//  - loadActiveMemories: archived_at IS NULL only, newest first, capped.
//  - rememberMemory: inserts, but returns the existing row instead of a
//    second insert when an active memory has identical trimmed/case-folded
//    content — an archived duplicate doesn't count.
//  - forgetMemory: archives (never deletes) — a no-op sweep after archiving
//    finds nothing left un-archived.
//  - searchHistory: family-thread scope (reusing lib/agent/history.ts's
//    familyThreadCondition), every whitespace-separated term via ILIKE,
//    the sinceDays window, and sender/channel labeling for both directions.
// ---------------------------------------------------------------------------

interface FakeMemoryRow {
  id: string;
  content: string;
  kind: string;
  memberId: string | null;
  createdByMemberId: string | null;
  source: string | null;
  createdAt: Date;
  archivedAt: Date | null;
}

interface FakeMessageRow {
  direction: "inbound" | "outbound";
  source: "imessage" | "dashboard" | null;
  chatGuid: string | null;
  senderHandle: string | null;
  memberId: string | null;
  text: string;
  createdAt: Date;
}

const state = vi.hoisted(() => ({
  memories: [] as FakeMemoryRow[],
  messages: [] as FakeMessageRow[],
  throwOnGetDb: false,
  nextId: 0,
}));

vi.mock("drizzle-orm", () => ({
  eq: (column: unknown, value: unknown) => ({ op: "eq" as const, column, value }),
  isNull: (column: unknown) => ({ op: "isNull" as const, column }),
  gte: (column: unknown, value: unknown) => ({ op: "gte" as const, column, value }),
  ilike: (column: unknown, value: unknown) => ({ op: "ilike" as const, column, value }),
  and: (...conds: unknown[]) => ({ op: "and" as const, conds }),
  or: (...conds: unknown[]) => ({ op: "or" as const, conds }),
  desc: (column: unknown) => ({ op: "desc" as const, column }),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => {
    if (state.throwOnGetDb) throw new Error("DATABASE_URL is not set");

    function tableOf(column: unknown): "familyMemory" | "messageLog" {
      if (Object.values(familyMemory).includes(column as never)) return "familyMemory";
      if (Object.values(messageLog).includes(column as never)) return "messageLog";
      throw new Error("fake db: unrecognized column reference");
    }
    function keyOf(column: unknown): string {
      const table = tableOf(column) === "familyMemory" ? familyMemory : messageLog;
      const entry = Object.entries(table).find(([, col]) => col === column);
      if (!entry) throw new Error("fake db: unrecognized column reference");
      return entry[0];
    }
    function matches(row: Record<string, unknown>, cond: unknown): boolean {
      if (!cond) return true;
      const c = cond as { op: string; column?: unknown; value?: unknown; conds?: unknown[] };
      if (c.op === "and") return (c.conds ?? []).every((sub) => matches(row, sub));
      if (c.op === "or") return (c.conds ?? []).some((sub) => matches(row, sub));
      const key = keyOf(c.column);
      const val = row[key];
      if (c.op === "eq") return val === c.value;
      if (c.op === "isNull") return val == null;
      if (c.op === "gte") return (val as Date) >= (c.value as Date);
      if (c.op === "ilike") {
        const needle = String(c.value).replace(/^%/, "").replace(/%$/, "").toLowerCase();
        return typeof val === "string" && val.toLowerCase().includes(needle);
      }
      throw new Error(`fake db: unhandled condition op ${c.op}`);
    }
    function rowsFor(table: unknown): Record<string, unknown>[] {
      if (table === familyMemory) return state.memories as unknown as Record<string, unknown>[];
      if (table === messageLog) return state.messages as unknown as Record<string, unknown>[];
      throw new Error("fake db: unrecognized table reference");
    }
    function project(rows: Record<string, unknown>[], projection: Record<string, unknown>) {
      return rows.map((r) => {
        const out: Record<string, unknown> = {};
        for (const [outKey, col] of Object.entries(projection)) {
          out[outKey] = r[keyOf(col)];
        }
        return out;
      });
    }

    return {
      select(projection: Record<string, unknown>) {
        return {
          from(table: unknown) {
            return {
              where(cond: unknown) {
                const filtered = rowsFor(table).filter((r) => matches(r, cond));
                return {
                  orderBy(orderSpec: { op: string; column: unknown }) {
                    const key = keyOf(orderSpec.column);
                    const sorted = [...filtered].sort((a, b) => {
                      const av = a[key] as Date;
                      const bv = b[key] as Date;
                      const diff = av.getTime() - bv.getTime();
                      return orderSpec.op === "desc" ? -diff : diff;
                    });
                    return {
                      limit(n: number) {
                        return Promise.resolve(project(sorted.slice(0, n), projection));
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
      insert(table: unknown) {
        return {
          values(vals: Record<string, unknown>) {
            return {
              returning(projection: Record<string, unknown>) {
                if (table !== familyMemory) throw new Error("fake db: insert only supported for familyMemory in this test");
                const row: FakeMemoryRow = {
                  id: `mem-${++state.nextId}`,
                  content: vals.content as string,
                  kind: (vals.kind as string) ?? "fact",
                  memberId: (vals.memberId as string | undefined) ?? null,
                  createdByMemberId: (vals.createdByMemberId as string | undefined) ?? null,
                  source: (vals.source as string | undefined) ?? null,
                  createdAt: new Date(),
                  archivedAt: null,
                };
                state.memories.push(row);
                return Promise.resolve(project([row as unknown as Record<string, unknown>], projection));
              },
            };
          },
        };
      },
      update(table: unknown) {
        return {
          set(patch: Record<string, unknown>) {
            return {
              where(cond: unknown) {
                for (const r of rowsFor(table)) {
                  if (matches(r, cond)) Object.assign(r, patch);
                }
                return Promise.resolve();
              },
            };
          },
        };
      },
    };
  },
}));

// Imported AFTER the mocks above so the module under test picks them up.
import { familyMemory, messageLog } from "@/lib/db/schema";
import {
  forgetMemory,
  formatMemoriesForPrompt,
  loadActiveMemories,
  MEMORY_LIMIT,
  rememberMemory,
  searchHistory,
  SEARCH_HISTORY_LIMIT,
  type MemoryRow,
} from "@/lib/agent/memory";

function seedMemory(row: Partial<FakeMemoryRow> & { content: string; createdAt: Date }) {
  const full: FakeMemoryRow = {
    id: `mem-${++state.nextId}`,
    kind: "fact",
    memberId: null,
    createdByMemberId: null,
    source: null,
    archivedAt: null,
    ...row,
  };
  state.memories.push(full);
  return full;
}

function seedMessage(row: Partial<FakeMessageRow> & { direction: "inbound" | "outbound"; text: string; createdAt: Date }) {
  state.messages.push({ source: null, chatGuid: null, senderHandle: null, memberId: null, ...row });
}

const roster: RosterMember[] = [
  { id: "m-aman", name: "Aman", aliases: [], imessageHandle: "aman@example.com", phone: null },
  { id: "m-ekta", name: "Ekta", aliases: [], imessageHandle: null, phone: "+15125550100" },
  { id: "m-yash", name: "Yash", aliases: [], imessageHandle: null, phone: null },
];

beforeEach(() => {
  state.memories = [];
  state.messages = [];
  state.throwOnGetDb = false;
  state.nextId = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// formatMemoriesForPrompt (pure)
// ---------------------------------------------------------------------------

describe("formatMemoriesForPrompt(memories, roster)", () => {
  beforeEach(() => {
    vi.stubEnv("FAMILY_TZ", "America/Chicago");
  });

  it("returns a one-line empty-store message when there are no memories", () => {
    expect(formatMemoriesForPrompt([], roster)).toBe("(Nothing remembered yet.)");
  });

  it("formats a memory about a member, saved by another member, as one line", () => {
    const memories: MemoryRow[] = [
      {
        id: "mem-1",
        content: "Yash has soccer every Tuesday 5-6pm",
        kind: "pattern",
        memberId: "m-yash",
        createdByMemberId: "m-ekta",
        source: "imessage",
        createdAt: new Date("2026-09-07T17:00:00Z"), // noon-ish CDT
      },
    ];
    expect(formatMemoriesForPrompt(memories, roster)).toBe(
      "- [pattern] Yash has soccer every Tuesday 5-6pm (about Yash; from Ekta, Sep 7) [id: mem-1]",
    );
  });

  it("omits 'about X' when the memory isn't about a specific member", () => {
    const memories: MemoryRow[] = [
      { id: "mem-1", content: "We decided the beach trip is the 20th", kind: "decision", memberId: null, createdByMemberId: "m-aman", source: "dashboard", createdAt: new Date("2026-09-07T17:00:00Z") },
    ];
    expect(formatMemoriesForPrompt(memories, roster)).toBe("- [decision] We decided the beach trip is the 20th (from Aman, Sep 7) [id: mem-1]");
  });

  it("omits 'from X' when the creator didn't resolve to a roster member", () => {
    const memories: MemoryRow[] = [
      { id: "mem-1", content: "Dad means Vijay", kind: "fact", memberId: null, createdByMemberId: null, source: "imessage", createdAt: new Date("2026-09-07T17:00:00Z") },
    ];
    expect(formatMemoriesForPrompt(memories, roster)).toBe("- [fact] Dad means Vijay (Sep 7) [id: mem-1]");
  });

  it("joins multiple memories with newlines, preserving the given order, each carrying its own id so forget can target it", () => {
    const memories: MemoryRow[] = [
      { id: "mem-1", content: "first", kind: "fact", memberId: null, createdByMemberId: null, source: null, createdAt: new Date("2026-09-07T17:00:00Z") },
      { id: "mem-2", content: "second", kind: "fact", memberId: null, createdByMemberId: null, source: null, createdAt: new Date("2026-09-07T17:00:00Z") },
    ];
    expect(formatMemoriesForPrompt(memories, roster)).toBe("- [fact] first (Sep 7) [id: mem-1]\n- [fact] second (Sep 7) [id: mem-2]");
  });
});

// ---------------------------------------------------------------------------
// loadActiveMemories
// ---------------------------------------------------------------------------

describe("loadActiveMemories()", () => {
  it("returns only archived_at IS NULL rows, newest first", async () => {
    seedMemory({ content: "older active", createdAt: new Date("2026-09-01T00:00:00Z") });
    seedMemory({ content: "archived", createdAt: new Date("2026-09-02T00:00:00Z"), archivedAt: new Date() });
    seedMemory({ content: "newer active", createdAt: new Date("2026-09-03T00:00:00Z") });

    const memories = await loadActiveMemories();
    expect(memories.map((m) => m.content)).toEqual(["newer active", "older active"]);
  });

  it("caps at MEMORY_LIMIT", async () => {
    for (let i = 0; i < MEMORY_LIMIT + 5; i++) {
      seedMemory({ content: `mem-${i}`, createdAt: new Date(2026, 8, 1, 0, 0, i) });
    }
    const memories = await loadActiveMemories();
    expect(memories).toHaveLength(MEMORY_LIMIT);
  });

  it("degrades to [] (no throw) when getDb() throws", async () => {
    state.throwOnGetDb = true;
    await expect(loadActiveMemories()).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// rememberMemory
// ---------------------------------------------------------------------------

describe("rememberMemory(input)", () => {
  it("inserts a new memory and returns it", async () => {
    const result = await rememberMemory({ content: "Kai is allergic to peanuts", createdByMemberId: "m-aman", source: "imessage" });
    expect(result).not.toBeNull();
    expect(result?.content).toBe("Kai is allergic to peanuts");
    expect(state.memories).toHaveLength(1);
  });

  it("defaults kind to 'fact' when omitted", async () => {
    const result = await rememberMemory({ content: "some fact" });
    expect(result?.kind).toBe("fact");
  });

  it("returns the existing active row instead of inserting a duplicate (trimmed, case-folded match)", async () => {
    seedMemory({ content: "Kai is allergic to peanuts", createdAt: new Date() });

    const result = await rememberMemory({ content: "  kai IS allergic to PEANUTS  " });
    expect(result?.id).toBe(state.memories[0].id);
    expect(state.memories).toHaveLength(1); // no second row inserted
  });

  it("does NOT treat an archived memory with the same content as a duplicate", async () => {
    seedMemory({ content: "Kai is allergic to peanuts", createdAt: new Date(), archivedAt: new Date() });

    const result = await rememberMemory({ content: "Kai is allergic to peanuts" });
    expect(result).not.toBeNull();
    expect(state.memories).toHaveLength(2); // the archived one, plus a fresh active one
  });

  it("degrades to null (no throw) when getDb() throws", async () => {
    state.throwOnGetDb = true;
    await expect(rememberMemory({ content: "anything" })).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// forgetMemory
// ---------------------------------------------------------------------------

describe("forgetMemory(id)", () => {
  it("sets archived_at on the matching row", async () => {
    const row = seedMemory({ content: "to forget", createdAt: new Date() });
    await forgetMemory(row.id);
    expect(state.memories.find((m) => m.id === row.id)?.archivedAt).toBeInstanceOf(Date);
  });

  it("a repeated forget on an already-archived memory is a harmless no-op", async () => {
    const row = seedMemory({ content: "to forget", createdAt: new Date(), archivedAt: new Date("2026-01-01T00:00:00Z") });
    await forgetMemory(row.id);
    await expect(forgetMemory(row.id)).resolves.toBeUndefined();
  });

  it("forgetting an id with no matching row is a harmless no-op", async () => {
    await expect(forgetMemory("does-not-exist")).resolves.toBeUndefined();
  });

  it("degrades without throwing when getDb() throws", async () => {
    state.throwOnGetDb = true;
    await expect(forgetMemory("mem-1")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// searchHistory
// ---------------------------------------------------------------------------

describe("searchHistory({ query, sinceDays }, roster)", () => {
  it("matches only messages containing EVERY whitespace-separated term", async () => {
    seedMessage({ direction: "inbound", source: "dashboard", text: "book the dentist for Maya", createdAt: new Date() });
    seedMessage({ direction: "inbound", source: "dashboard", text: "book a haircut for Kai", createdAt: new Date() });

    const results = await searchHistory({ query: "dentist Maya" }, roster);
    expect(results.map((r) => r.text)).toEqual(["book the dentist for Maya"]);
  });

  it("is case-insensitive (ILIKE)", async () => {
    seedMessage({ direction: "inbound", source: "dashboard", text: "book the DENTIST for maya", createdAt: new Date() });
    const results = await searchHistory({ query: "dentist" }, roster);
    expect(results).toHaveLength(1);
  });

  it("scopes to the family thread — excludes a different iMessage chat's rows", async () => {
    vi.stubEnv("FAMILY_CHAT_GUID", "chat-a");
    seedMessage({ direction: "inbound", source: "imessage", chatGuid: "chat-a", text: "family chat dentist", createdAt: new Date() });
    seedMessage({ direction: "inbound", source: "imessage", chatGuid: "chat-b", text: "other chat dentist", createdAt: new Date() });
    seedMessage({ direction: "inbound", source: "dashboard", text: "dashboard dentist", createdAt: new Date() });

    const results = await searchHistory({ query: "dentist" }, roster);
    expect(results.map((r) => r.text).sort()).toEqual(["dashboard dentist", "family chat dentist"]);
  });

  it("defaults sinceDays to 90 and excludes older rows", async () => {
    const now = new Date("2026-09-07T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    seedMessage({ direction: "inbound", source: "dashboard", text: "recent dentist", createdAt: new Date(now.getTime() - 24 * 60 * 60 * 1000) });
    seedMessage({
      direction: "inbound",
      source: "dashboard",
      text: "old dentist",
      createdAt: new Date(now.getTime() - 91 * 24 * 60 * 60 * 1000),
    });

    const results = await searchHistory({ query: "dentist" }, roster);
    expect(results.map((r) => r.text)).toEqual(["recent dentist"]);
  });

  it("respects a custom sinceDays", async () => {
    const now = new Date("2026-09-07T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    seedMessage({
      direction: "inbound",
      source: "dashboard",
      text: "dentist 10 days ago",
      createdAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
    });

    expect((await searchHistory({ query: "dentist", sinceDays: 5 }, roster)).map((r) => r.text)).toEqual([]);
    expect((await searchHistory({ query: "dentist", sinceDays: 30 }, roster)).map((r) => r.text)).toEqual(["dentist 10 days ago"]);
  });

  it("returns newest first, capped at SEARCH_HISTORY_LIMIT", async () => {
    const base = new Date("2026-09-07T12:00:00Z").getTime();
    for (let i = 0; i < SEARCH_HISTORY_LIMIT + 5; i++) {
      seedMessage({ direction: "inbound", source: "dashboard", text: `dentist ${i}`, createdAt: new Date(base + i * 1000) });
    }

    const results = await searchHistory({ query: "dentist" }, roster);
    expect(results).toHaveLength(SEARCH_HISTORY_LIMIT);
    expect(results[0].text).toBe(`dentist ${SEARCH_HISTORY_LIMIT + 4}`);
  });

  it("labels an inbound row with the resolved roster name, falling back to the raw handle", async () => {
    seedMessage({ direction: "inbound", source: "dashboard", memberId: "m-aman", senderHandle: "aman@example.com", text: "dentist for Maya", createdAt: new Date() });
    seedMessage({ direction: "inbound", source: "dashboard", memberId: null, senderHandle: "+15125550199", text: "dentist follow-up", createdAt: new Date() });

    const results = await searchHistory({ query: "dentist" }, roster);
    const byText = new Map(results.map((r) => [r.text, r]));
    expect(byText.get("dentist for Maya")?.senderName).toBe("Aman");
    expect(byText.get("dentist follow-up")?.senderName).toBe("+15125550199");
  });

  it("labels an outbound row as LuthCal and carries its channel", async () => {
    seedMessage({ direction: "outbound", source: "imessage", chatGuid: "chat-a", text: "dentist booked!", createdAt: new Date() });
    vi.stubEnv("FAMILY_CHAT_GUID", "chat-a");

    const results = await searchHistory({ query: "dentist" }, roster);
    expect(results[0].senderName).toBe("LuthCal");
    expect(results[0].channel).toBe("imessage");
  });

  it("degrades to [] (no throw) when getDb() throws", async () => {
    state.throwOnGetDb = true;
    await expect(searchHistory({ query: "dentist" }, roster)).resolves.toEqual([]);
  });
});
