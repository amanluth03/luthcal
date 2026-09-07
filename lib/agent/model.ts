import { createAnthropic } from "@ai-sdk/anthropic";

// Direct Anthropic API (ANTHROPIC_API_KEY). The key is read at request time,
// so importing this module with no env set — e.g. during `next build` — is
// safe.
const anthropic = createAnthropic();

/** The full tool-loop agent (lib/agent/index.ts). */
export const AGENT_MODEL = anthropic("claude-sonnet-5");

/** The passive-listener classifier (lib/agent/engagement.ts) — cheaper and faster, runs on far more messages. */
export const CLASSIFIER_MODEL = anthropic("claude-haiku-4-5");
