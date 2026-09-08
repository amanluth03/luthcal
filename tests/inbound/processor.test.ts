import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// lib/inbound-processor.ts processInboundMessage() is the per-message
// pipeline extracted out of app/api/webhooks/bluebubbles/route.ts so the new
// inbound-poll cron backstop (app/api/cron/inbound) can share it with the
// webhook. Same fake-query-builder pattern as tests/agent/history.test.ts:
// "drizzle-orm" is mocked down to plain condition-object builders, and
// "@/lib/db" resolves to an in-memory fake over that. lib/agent/history.ts's
// loadLastOutboundMessage runs for REAL against that fake db (not mocked) —
// only @/lib/agent (runAgent), @/lib/agent/engagement (decideEngagement),
// and @/lib/agent/outbound (enqueueOutbound) are mocked directly.
// ---------------------------------------------------------------------------

interface FakeMessageLogRow {
  id: string;
  direction: "inbound" | "outbound";
  source: "imessage" | "dashboard" | null;
  chatGuid: string | null;
  senderHandle: string | null;
  memberId: string | null;
  imessageGuid: string | null;
  text: string;
  createdAt: Date;
}

const state = vi.hoisted(() => ({ rows: [] as FakeMessageLogRow[], nextId: 1, claims: new Set<string>() }));

vi.mock("drizzle-orm", () => ({
  eq: (column: unknown, value: unknown) => ({ op: "eq" as const, column, value }),
  and: (...conds: unknown[]) => ({ op: "and" as const, conds }),
  or: (...conds: unknown[]) => ({ op: "or" as const, conds }),
  gte: (column: unknown, value: unknown) => ({ op: "gte" as const, column, value }),
  isNull: (column: unknown) => ({ op: "isNull" as const, column }),
  desc: (column: unknown) => ({ op: "desc" as const, column }),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => {
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
    function project(rows: FakeMessageLogRow[], projection: Record<string, unknown>) {
      return rows.map((r) => {
        const out: Record<string, unknown> = {};
        for (const [outKey, col] of Object.entries(projection)) out[outKey] = r[columnKey(col)];
        return out;
      });
    }
    return {
      select(projection: Record<string, unknown>) {
        return {
          from() {
            return {
              where(cond: unknown) {
                const filtered = state.rows.filter((r) => matches(r, cond));
                return {
                  // hasAlreadyProcessed's query goes straight where -> limit
                  // (no ordering needed for an existence check).
                  limit(n: number) {
                    return Promise.resolve(project(filtered, projection).slice(0, n));
                  },
                  // loadLastOutboundMessage's query goes where -> orderBy -> limit.
                  orderBy(orderSpec: { op: string; column: unknown }) {
                    const key = columnKey(orderSpec.column);
                    const sorted = [...filtered].sort((a, b) => {
                      const diff = (a[key] as Date).getTime() - (b[key] as Date).getTime();
                      return orderSpec.op === "desc" ? -diff : diff;
                    });
                    return {
                      limit(n: number) {
                        return Promise.resolve(project(sorted, projection).slice(0, n));
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
          values(vals: Partial<FakeMessageLogRow>) {
            if (table === inboundClaims) {
              // The atomic claim: INSERT ... ON CONFLICT DO NOTHING RETURNING —
              // an empty result means someone else already holds the guid.
              return {
                onConflictDoNothing: () => ({
                  returning: () => {
                    const guid = vals.imessageGuid as string;
                    if (state.claims.has(guid)) return Promise.resolve([]);
                    state.claims.add(guid);
                    return Promise.resolve([{ guid }]);
                  },
                }),
              };
            }
            state.rows.push({
              id: `row-${state.nextId++}`,
              direction: "inbound",
              source: null,
              chatGuid: null,
              senderHandle: null,
              memberId: null,
              imessageGuid: null,
              text: "",
              createdAt: new Date(),
              ...vals,
            });
            return Promise.resolve();
          },
        };
      },
    };
  },
}));

const runAgentMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agent", () => ({ runAgent: runAgentMock }));

const decideEngagementMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agent/engagement", () => ({ decideEngagement: decideEngagementMock }));

const enqueueOutboundMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agent/outbound", () => ({ enqueueOutbound: enqueueOutboundMock }));

// Imported AFTER the mocks above so the module under test picks them up.
import { inboundClaims, messageLog } from "@/lib/db/schema";
import { processInboundMessage } from "@/lib/inbound-processor";

const FAMILY_CHAT = "chat-family";

beforeEach(() => {
  state.rows = [];
  state.nextId = 1;
  state.claims = new Set();
  runAgentMock.mockReset();
  decideEngagementMock.mockReset();
  enqueueOutboundMock.mockReset();
  vi.stubEnv("FAMILY_CHAT_GUID", FAMILY_CHAT);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("processInboundMessage", () => {
  it("drops a message with isFromMe: true, before any gate/DB work", async () => {
    const result = await processInboundMessage({ chatGuid: FAMILY_CHAT, text: "hi", isFromMe: true });
    expect(result).toBe("dropped-own");
    expect(state.rows).toEqual([]);
    expect(decideEngagementMock).not.toHaveBeenCalled();
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it("drops a message from AGENT_IMESSAGE_HANDLE (case-insensitive), a second independent loop guard", async () => {
    vi.stubEnv("AGENT_IMESSAGE_HANDLE", "agent@example.com");
    const result = await processInboundMessage({
      chatGuid: FAMILY_CHAT,
      senderHandle: "Agent@Example.com",
      text: "hi",
      isFromMe: false,
    });
    expect(result).toBe("dropped-own");
    expect(state.rows).toEqual([]);
    expect(decideEngagementMock).not.toHaveBeenCalled();
  });

  it("logs an audit row and returns 'wrong-chat' for a message outside FAMILY_CHAT_GUID, never reaching the gate", async () => {
    const result = await processInboundMessage({
      imessageGuid: "guid-1",
      chatGuid: "some-other-chat",
      senderHandle: "aman@example.com",
      text: "hello there",
    });
    expect(result).toBe("wrong-chat");
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({
      direction: "inbound",
      chatGuid: "some-other-chat",
      senderHandle: "aman@example.com",
      text: "hello there",
      imessageGuid: "guid-1",
    });
    expect(decideEngagementMock).not.toHaveBeenCalled();
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it("logs an audit row and returns 'empty' for a whitespace-only body in the family chat, never reaching the gate", async () => {
    const result = await processInboundMessage({
      imessageGuid: "guid-2",
      chatGuid: FAMILY_CHAT,
      senderHandle: "aman@example.com",
      text: "   ",
    });
    expect(result).toBe("empty");
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({ text: "(empty message)", imessageGuid: "guid-2" });
    expect(decideEngagementMock).not.toHaveBeenCalled();
  });

  it("claims the guid atomically: a second sighting of the same message returns 'already-processed' without touching the gate", async () => {
    decideEngagementMock.mockResolvedValue({ engage: true, reason: "mentioned", mode: "act" });
    runAgentMock.mockResolvedValue({ reply: "Added.", actions: [] });
    const msg = { imessageGuid: "dup-guid", chatGuid: FAMILY_CHAT, senderHandle: "aman@example.com", text: "LuthCal, add dentist Tuesday 3pm" };

    expect(await processInboundMessage(msg)).toBe("engaged");
    expect(await processInboundMessage(msg)).toBe("already-processed");

    expect(decideEngagementMock).toHaveBeenCalledTimes(1);
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(enqueueOutboundMock).toHaveBeenCalledTimes(1);
  });

  it("two sightings racing each other (webhook + poller) run the agent exactly once", async () => {
    decideEngagementMock.mockResolvedValue({ engage: true, reason: "mentioned", mode: "act" });
    runAgentMock.mockResolvedValue({ reply: "Added.", actions: [] });
    const msg = { imessageGuid: "race-guid", chatGuid: FAMILY_CHAT, senderHandle: "aman@example.com", text: "LuthCal, add dinner Wednesday 7pm" };

    const results = await Promise.all([processInboundMessage(msg), processInboundMessage(msg)]);

    expect(results.sort()).toEqual(["already-processed", "engaged"]);
    expect(runAgentMock).toHaveBeenCalledTimes(1);
  });

  it("a message with no guid can never be treated as already processed", async () => {
    decideEngagementMock.mockResolvedValue({ engage: false, reason: "none", mode: "silent" });
    const msg = { chatGuid: FAMILY_CHAT, senderHandle: "aman@example.com", text: "hey" };

    expect(await processInboundMessage(msg)).toBe("silent");
    expect(await processInboundMessage(msg)).toBe("silent");
    expect(decideEngagementMock).toHaveBeenCalledTimes(2);
  });

  it("gate silent: no message_log rows are written at all (ambient chatter gets zero footprint)", async () => {
    decideEngagementMock.mockResolvedValue({ engage: false, reason: "none", mode: "silent" });

    const result = await processInboundMessage({
      imessageGuid: "guid-3",
      chatGuid: FAMILY_CHAT,
      senderHandle: "aman@example.com",
      text: "anyone free later?",
    });

    expect(result).toBe("silent");
    expect(state.rows).toEqual([]);
    expect(runAgentMock).not.toHaveBeenCalled();
    expect(enqueueOutboundMock).not.toHaveBeenCalled();
  });

  it("gate engages: calls runAgent with the imessageGuid threaded through, then enqueues the reply", async () => {
    decideEngagementMock.mockResolvedValue({ engage: true, reason: "mentioned", mode: "act" });
    runAgentMock.mockResolvedValue({ reply: "Added it!", actions: [] });

    const result = await processInboundMessage({
      imessageGuid: "guid-4",
      chatGuid: FAMILY_CHAT,
      senderHandle: "aman@example.com",
      text: "LuthCal, add dentist Tuesday 3pm",
    });

    expect(result).toBe("engaged");
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(runAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: "user", content: "LuthCal, add dentist Tuesday 3pm" }],
        source: "imessage",
        chatGuid: FAMILY_CHAT,
        senderHandle: "aman@example.com",
        imessageGuid: "guid-4",
        engagementMode: "act",
      }),
    );
    expect(enqueueOutboundMock).toHaveBeenCalledWith(FAMILY_CHAT, "Added it!");
  });

  it("gate engages in 'suggest' mode: engagementMode passed through as 'suggest', not 'act'", async () => {
    decideEngagementMock.mockResolvedValue({ engage: true, reason: "event-detected", mode: "suggest" });
    runAgentMock.mockResolvedValue({ reply: "Want me to add this?", actions: [] });

    await processInboundMessage({
      imessageGuid: "guid-5",
      chatGuid: FAMILY_CHAT,
      senderHandle: "aman@example.com",
      text: "Maya has dentist Tuesday 3pm",
    });

    expect(runAgentMock).toHaveBeenCalledWith(expect.objectContaining({ engagementMode: "suggest" }));
  });
});
