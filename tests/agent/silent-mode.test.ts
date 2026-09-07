import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Silent mode (AGENT_SILENT=true, lib/agent/silent.ts): the agent listens and
// acts on the calendar but never sends a text — no outbound queue rows, no
// passive "want me to add that?" suggestions, no sendGroupMessage tool.

const state = vi.hoisted(() => ({
  inserted: [] as unknown[],
  classifierCalls: 0,
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    insert: () => ({
      values: async (row: unknown) => {
        state.inserted.push(row);
      },
    }),
  }),
}));

vi.mock("ai", () => ({
  generateText: async () => {
    state.classifierCalls++;
    return { output: { isSchedulableEventWithTime: true } };
  },
  Output: { object: (o: unknown) => o },
  tool: (def: unknown) => def,
  stepCountIs: () => () => false,
}));

vi.mock("@/lib/google/conflicts", () => ({ checkConflicts: async () => [] }));
vi.mock("@/lib/google/duplicates", () => ({ findNearDuplicateEvent: async () => null }));
vi.mock("@/lib/google/events", () => ({
  createEvent: async () => null,
  deleteEvent: async () => null,
  listEvents: async () => [],
  updateEvent: async () => null,
}));
vi.mock("@/lib/agent/memory", () => ({
  forgetMemory: async () => undefined,
  rememberMemory: async () => null,
  searchHistory: async () => [],
}));

import { isAgentSilent } from "@/lib/agent/silent";
import { enqueueOutbound } from "@/lib/agent/outbound";
import { decideEngagement } from "@/lib/agent/engagement";
import { buildAgentTools } from "@/lib/agent/tools";

beforeEach(() => {
  state.inserted = [];
  state.classifierCalls = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isAgentSilent", () => {
  it("is false unless AGENT_SILENT is exactly 'true'", () => {
    vi.stubEnv("AGENT_SILENT", "");
    expect(isAgentSilent()).toBe(false);
    vi.stubEnv("AGENT_SILENT", "1");
    expect(isAgentSilent()).toBe(false);
    vi.stubEnv("AGENT_SILENT", "true");
    expect(isAgentSilent()).toBe(true);
  });
});

describe("enqueueOutbound in silent mode", () => {
  it("queues normally when not silent", async () => {
    vi.stubEnv("AGENT_SILENT", "");
    await enqueueOutbound("chat-1", "hello");
    expect(state.inserted).toEqual([{ chatGuid: "chat-1", text: "hello" }]);
  });

  it("writes nothing to the outbound queue when silent", async () => {
    vi.stubEnv("AGENT_SILENT", "true");
    await enqueueOutbound("chat-1", "hello");
    expect(state.inserted).toEqual([]);
  });
});

describe("decideEngagement in silent mode", () => {
  beforeEach(() => {
    vi.stubEnv("AGENT_SILENT", "true");
  });

  it("still engages in act mode on an explicit mention", async () => {
    const decision = await decideEngagement({ text: "LuthCal, add dentist Tuesday 3pm" });
    expect(decision).toEqual({ engage: true, reason: "mentioned", mode: "act" });
  });

  it("never runs the event classifier or suggests, even for a clear event with a time", async () => {
    const decision = await decideEngagement({ text: "Maya has a dentist appt Tuesday at 3" });
    expect(decision).toEqual({ engage: false, reason: "none", mode: "silent" });
    expect(state.classifierCalls).toBe(0);
  });

  it("ignores pending-confirmation replies, since it never asked anything", async () => {
    const decision = await decideEngagement({
      text: "yes",
      lastAgentMessage: { text: "Want me to add Maya's dentist for Tue 3pm?", sentAt: new Date() },
    });
    expect(decision).toEqual({ engage: false, reason: "none", mode: "silent" });
  });
});

describe("buildAgentTools in silent mode", () => {
  it("keeps sendGroupMessage when not silent", () => {
    vi.stubEnv("AGENT_SILENT", "");
    expect(Object.keys(buildAgentTools({ source: "imessage", roster: [] }))).toContain("sendGroupMessage");
  });

  it("removes sendGroupMessage but keeps every calendar and memory tool when silent", () => {
    vi.stubEnv("AGENT_SILENT", "true");
    const names = Object.keys(buildAgentTools({ source: "imessage", roster: [] })).sort();
    expect(names).toEqual(["checkConflicts", "createEvent", "deleteEvent", "forget", "listEvents", "remember", "searchHistory", "updateEvent"]);
  });

  it("removes sendGroupMessage from the suggest-mode allowlist too", () => {
    vi.stubEnv("AGENT_SILENT", "true");
    const names = Object.keys(buildAgentTools({ source: "imessage", roster: [], mode: "suggest" })).sort();
    expect(names).toEqual(["checkConflicts", "listEvents", "searchHistory"]);
  });
});
