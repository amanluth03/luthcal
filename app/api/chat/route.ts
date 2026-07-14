import { runAgent, type RunAgentMessage } from "@/lib/agent";
import { MAX_INBOUND_LENGTH, normalizeInboundText } from "@/lib/agent/normalize-inbound";

// -----------------------------------------------------------------------------
// POST /api/chat — dashboard chat endpoint. Drives the same agent
// (lib/agent/index.ts runAgent) the BlueBubbles iMessage webhook will use, so
// the dashboard chat panel and the group chat share one brain. Full contract
// also documented in docs/agent-core.md §2b — keep both in sync.
//
// Request body:
//   { messages: Array<{ role: "user" | "assistant", content: string }> }
//   - `messages` must be a non-empty array.
//   - The LAST message must have role "user" — it's the turn being submitted
//     this request.
//   - Everything before the last message is prior conversation history.
//     There is NO server-side session/thread store: the caller (dashboard
//     client) is responsible for keeping and resending the full history on
//     every request (append the previous response's `reply` as an
//     "assistant" message, then the user's next message, and send the whole
//     array again). runAgent forwards `messages` to the model as-is, so this
//     is what makes the chat multi-turn — e.g. resolving "make it 4 instead"
//     against an event discussed two turns ago.
//   - Only the last message's `content` is run through
//     lib/agent/normalize-inbound.ts's normalizeInboundText before anything
//     else happens: empty/whitespace-only or over-MAX_INBOUND_LENGTH content
//     is rejected with 400 *before* runAgent is called and before any
//     message_log row is written. Prior history isn't re-checked — it was
//     already validated when it was originally submitted as *its* turn's
//     last message.
//
// Response (200):
//   { reply: string, actions: Array<{ tool: string, input: unknown, output: unknown }> }
//   - `reply` is the assistant's reply text for this turn only — append it
//     to the caller's own message list to build history for the next
//     request.
//   - `actions` is every tool call runAgent made this turn (createEvent,
//     checkConflicts, etc.), in call order. Not required to render the
//     reply; available for surfacing "what the agent did" in the UI. This is
//     RunAgentResult (lib/agent/index.ts) returned as-is.
//
// Error responses: { error: string }
//   - 400: invalid/absent JSON body, wrong shape, empty `messages`, last
//     message not role "user", or its content is empty/whitespace-only or
//     too long.
//   - 500: runAgent threw (upstream model/tool failure).
//
// TODO(production): this route has no auth guard yet. It's fine for local
// dashboard use against `next dev`, but before this is reachable in
// production it needs the same kind of shared-secret/session check the rest
// of the dashboard uses (FAMILY_PASSCODE) — see frontend-design's dashboard
// auth for the pattern to match.
// -----------------------------------------------------------------------------
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const messages = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages) || messages.length === 0 || !messages.every(isRunAgentMessage)) {
    return Response.json(
      {
        error:
          "Expected { messages: Array<{ role: 'user' | 'assistant', content: string }> } with at least one message",
      },
      { status: 400 },
    );
  }

  const lastMessage = messages[messages.length - 1];
  if (lastMessage.role !== "user") {
    return Response.json({ error: "The last message must have role 'user'" }, { status: 400 });
  }

  // Reject empty/over-length input before runAgent is ever called and before
  // any message_log row is written (runAgent logs the inbound message as its
  // first side effect) — see docs/agent-core.md §2a.
  const normalized = normalizeInboundText(lastMessage.content);
  if (normalized.isEmpty) {
    return Response.json({ error: "Message is empty" }, { status: 400 });
  }
  if (normalized.isTooLong) {
    return Response.json({ error: `Message is too long (max ${MAX_INBOUND_LENGTH} characters)` }, { status: 400 });
  }

  const normalizedMessages: RunAgentMessage[] = [...messages.slice(0, -1), { role: "user", content: normalized.text }];

  try {
    const result = await runAgent({ messages: normalizedMessages, source: "dashboard" });
    return Response.json(result);
  } catch (err) {
    console.error("[api/chat] runAgent failed", err);
    return Response.json({ error: "The agent failed to respond. Please try again." }, { status: 500 });
  }
}

function isRunAgentMessage(value: unknown): value is RunAgentMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { role?: unknown; content?: unknown };
  return (candidate.role === "user" || candidate.role === "assistant") && typeof candidate.content === "string";
}
