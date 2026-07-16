import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Passive-listener engagement gate (lib/agent/engagement.ts). This is the
// highest-value test surface for this pass — see docs/agent-core.md's
// passive-listener section for the full design writeup this exercises:
// mention detection, event-with-time detection (via a mocked cheap
// classifier call), the pending-confirmation extension, and the
// fail-safe-to-silent classifier-failure path.
//
// "ai"'s generateText/Output are mocked at the module level (same pattern
// as tests/agent/history.test.ts mocking "@/lib/db" / "drizzle-orm") so
// these tests never make a real network call and can deterministically
// control what the classifier "decides" per test.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  generateTextImpl: async (): Promise<{ output: { isSchedulableEventWithTime: boolean } }> => ({
    output: { isSchedulableEventWithTime: false },
  }),
  generateTextCalls: [] as unknown[],
}));

vi.mock("ai", () => ({
  generateText: (opts: unknown) => {
    state.generateTextCalls.push(opts);
    return state.generateTextImpl();
  },
  Output: {
    object: (spec: unknown) => spec,
  },
}));

import {
  DEFAULT_AGENT_NAMES,
  PENDING_CONFIRMATION_WINDOW_MS,
  decideEngagement,
  getDefaultAgentNames,
  isMentioned,
} from "@/lib/agent/engagement";

function resolvesTrue() {
  return async () => ({ output: { isSchedulableEventWithTime: true } });
}
function resolvesFalse() {
  return async () => ({ output: { isSchedulableEventWithTime: false } });
}
function throwsClassifierError() {
  return async () => {
    throw new Error("model call failed");
  };
}

beforeEach(() => {
  state.generateTextImpl = resolvesFalse();
  state.generateTextCalls = [];
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// isMentioned — deterministic mention detection (no model call involved)
// ---------------------------------------------------------------------------

describe("isMentioned(text, agentNames)", () => {
  const names = ["LuthCal", "calendar"];

  it("matches the bare name", () => {
    expect(isMentioned("LuthCal add Maya's dentist", names)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isMentioned("luthcal add Maya's dentist", names)).toBe(true);
    expect(isMentioned("LUTHCAL add Maya's dentist", names)).toBe(true);
  });

  it("is robust to punctuation ('@LuthCal', 'LuthCal!', 'hey, calendar?')", () => {
    expect(isMentioned("@LuthCal can you add this?", names)).toBe(true);
    expect(isMentioned("LuthCal! add it please", names)).toBe(true);
    expect(isMentioned("hey, calendar? add this", names)).toBe(true);
  });

  it("matches mid-sentence, not just at the start", () => {
    expect(isMentioned("can you ask LuthCal to add this", names)).toBe(true);
    expect(isMentioned("hey calendar, what's on tomorrow", names)).toBe(true);
  });

  it("does not match a name embedded inside a longer word (word-boundary only)", () => {
    // "calendar" should not match inside "calendars" or "calendared".
    expect(isMentioned("check the calendars app", names)).toBe(false);
  });

  it("does not match ordinary chatter with no name/alias present", () => {
    expect(isMentioned("did you see the game last night", names)).toBe(false);
    expect(isMentioned("we should get dinner sometime", names)).toBe(false);
  });

  it("matches a custom agentNames override, including a multi-word alias as a contiguous phrase", () => {
    expect(isMentioned("hey scheduling bot, add this", ["scheduling bot"])).toBe(true);
    expect(isMentioned("hey scheduling something bot, add this", ["scheduling bot"])).toBe(false);
  });

  it("matches an iMessage-handle-style name (phone number)", () => {
    expect(isMentioned("hey +15125550123 can you add this", ["+15125550123"])).toBe(true);
  });

  it("returns false for empty/whitespace-only text or an empty agentNames list", () => {
    expect(isMentioned("", names)).toBe(false);
    expect(isMentioned("   ", names)).toBe(false);
    expect(isMentioned("LuthCal add this", [])).toBe(false);
  });
});

describe("getDefaultAgentNames()", () => {
  it("defaults to DEFAULT_AGENT_NAMES when AGENT_NAMES/AGENT_IMESSAGE_HANDLE are unset", () => {
    vi.stubEnv("AGENT_NAMES", "");
    vi.stubEnv("AGENT_IMESSAGE_HANDLE", "");
    expect(getDefaultAgentNames()).toEqual(DEFAULT_AGENT_NAMES);
  });

  it("uses AGENT_NAMES (comma-separated, trimmed) when set", () => {
    vi.stubEnv("AGENT_NAMES", " Robo , Assistant ");
    vi.stubEnv("AGENT_IMESSAGE_HANDLE", "");
    expect(getDefaultAgentNames()).toEqual(["Robo", "Assistant"]);
  });

  it("always appends AGENT_IMESSAGE_HANDLE when set", () => {
    vi.stubEnv("AGENT_NAMES", "");
    vi.stubEnv("AGENT_IMESSAGE_HANDLE", "agent@icloud.com");
    expect(getDefaultAgentNames()).toEqual([...DEFAULT_AGENT_NAMES, "agent@icloud.com"]);
  });
});

// ---------------------------------------------------------------------------
// decideEngagement — the full gate
// ---------------------------------------------------------------------------

describe("decideEngagement — mention trigger", () => {
  it("engages in 'act' mode on an explicit mention, and never calls the classifier", async () => {
    const decision = await decideEngagement({ text: "LuthCal, add Maya's dentist tuesday 3pm", agentNames: ["LuthCal"] });
    expect(decision).toEqual({ engage: true, reason: "mentioned", mode: "act" });
    expect(state.generateTextCalls).toHaveLength(0);
  });
});

describe("decideEngagement — event-with-time trigger", () => {
  it("engages in 'suggest' mode when the classifier confidently detects a schedulable event with a time", async () => {
    state.generateTextImpl = resolvesTrue();
    const decision = await decideEngagement({ text: "Maya has dentist Tuesday 3pm", agentNames: ["LuthCal"] });
    expect(decision).toEqual({ engage: true, reason: "event-detected", mode: "suggest" });
    expect(state.generateTextCalls).toHaveLength(1);
  });

  it("stays silent for ambient chatter/greetings the classifier rejects", async () => {
    state.generateTextImpl = resolvesFalse();
    const decision = await decideEngagement({ text: "did you see the game last night", agentNames: ["LuthCal"] });
    expect(decision).toEqual({ engage: false, reason: "none", mode: "silent" });
  });

  it("stays silent for a vague plan with no specific time (classifier rejects)", async () => {
    state.generateTextImpl = resolvesFalse();
    const decision = await decideEngagement({ text: "we should do dinner sometime this week", agentNames: ["LuthCal"] });
    expect(decision).toEqual({ engage: false, reason: "none", mode: "silent" });
  });

  it("stays silent for logistics-without-time chatter (classifier rejects)", async () => {
    state.generateTextImpl = resolvesFalse();
    const decision = await decideEngagement({ text: "someone needs to pick up milk", agentNames: ["LuthCal"] });
    expect(decision).toEqual({ engage: false, reason: "none", mode: "silent" });
  });
});

describe("decideEngagement — classifier failure fails toward silent", () => {
  it("defaults to silent when the classifier call throws, rather than engaging", async () => {
    state.generateTextImpl = throwsClassifierError();
    const decision = await decideEngagement({ text: "Maya has dentist Tuesday 3pm", agentNames: ["LuthCal"] });
    expect(decision).toEqual({ engage: false, reason: "none", mode: "silent" });
  });

  it("does not throw out of decideEngagement even when the model call rejects", async () => {
    state.generateTextImpl = throwsClassifierError();
    await expect(decideEngagement({ text: "anything", agentNames: ["LuthCal"] })).resolves.toBeDefined();
  });
});

describe("decideEngagement — pending-confirmation reply", () => {
  it("engages in 'act' mode when the agent's last message was a recent question, without calling the classifier", async () => {
    const decision = await decideEngagement({
      text: "yes",
      agentNames: ["LuthCal"],
      lastAgentMessage: { text: "Want me to add Maya's dentist for Tue 3pm?", sentAt: new Date(Date.now() - 60_000) },
    });
    expect(decision).toEqual({ engage: true, reason: "pending-confirmation", mode: "act" });
    expect(state.generateTextCalls).toHaveLength(0);
  });

  it("falls through to the classifier when the agent's last message did not end in a question mark", async () => {
    state.generateTextImpl = resolvesFalse();
    const decision = await decideEngagement({
      text: "ok cool",
      agentNames: ["LuthCal"],
      lastAgentMessage: { text: "Added Maya's dentist for Tue 3pm.", sentAt: new Date(Date.now() - 60_000) },
    });
    expect(decision.reason).not.toBe("pending-confirmation");
    expect(state.generateTextCalls).toHaveLength(1);
  });

  it("falls through to the classifier once the pending-confirmation window has elapsed", async () => {
    state.generateTextImpl = resolvesFalse();
    const decision = await decideEngagement({
      text: "yes",
      agentNames: ["LuthCal"],
      lastAgentMessage: {
        text: "Want me to add Maya's dentist for Tue 3pm?",
        sentAt: new Date(Date.now() - PENDING_CONFIRMATION_WINDOW_MS - 1_000),
      },
    });
    expect(decision.reason).not.toBe("pending-confirmation");
    expect(state.generateTextCalls).toHaveLength(1);
  });

  it("is a no-op when there is no lastAgentMessage at all", async () => {
    state.generateTextImpl = resolvesFalse();
    const decision = await decideEngagement({ text: "yes", agentNames: ["LuthCal"] });
    expect(decision.reason).not.toBe("pending-confirmation");
  });

  it("mention still takes priority over a pending-confirmation reply", async () => {
    const decision = await decideEngagement({
      text: "LuthCal yes please",
      agentNames: ["LuthCal"],
      lastAgentMessage: { text: "Want me to add Maya's dentist for Tue 3pm?", sentAt: new Date(Date.now() - 60_000) },
    });
    expect(decision).toEqual({ engage: true, reason: "mentioned", mode: "act" });
    expect(state.generateTextCalls).toHaveLength(0);
  });
});

describe("decideEngagement — agentNames defaulting", () => {
  it("uses getDefaultAgentNames() (env-driven) when agentNames is omitted", async () => {
    vi.stubEnv("AGENT_NAMES", "TotallyCustomBotName");
    vi.stubEnv("AGENT_IMESSAGE_HANDLE", "");
    const decision = await decideEngagement({ text: "hey TotallyCustomBotName, add this" });
    expect(decision).toEqual({ engage: true, reason: "mentioned", mode: "act" });
  });
});
