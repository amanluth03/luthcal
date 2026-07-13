import { runAgent, type RunAgentMessage } from "@/lib/agent";

// Dashboard chat endpoint: how the web dashboard (and QA) exercise the same
// agent that will eventually be wired to the BlueBubbles iMessage webhook.
//
// TODO(production): this route has no auth guard yet. It's fine for local
// dashboard use against `next dev`, but before this is reachable in
// production it needs the same kind of shared-secret/session check the rest
// of the dashboard uses (FAMILY_PASSCODE) — see frontend-design's dashboard
// auth for the pattern to match.
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const messages = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages) || !messages.every(isRunAgentMessage)) {
    return Response.json(
      { error: "Expected { messages: Array<{ role: 'user' | 'assistant', content: string }> }" },
      { status: 400 },
    );
  }

  try {
    const result = await runAgent({ messages, source: "dashboard" });
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
