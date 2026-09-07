"use client";

import { useId, useRef, useState } from "react";
import { ArrowUp, Bot, CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ChatMessage {
  id: string;
  role: "user" | "agent";
  text: string;
  status?: "sending" | "sent" | "failed";
}

// Wire contract for POST /api/chat, matching lib/agent's runAgent() exactly
// (read from app/api/chat/route.ts + lib/agent/index.ts — not modified here,
// just matched): request is `{ messages: { role: "user"|"assistant",
// content: string }[] }`, success is `{ reply: string, actions: [...] }`,
// failure is `{ error: string }` with a non-2xx status.
interface WireMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Dashboard chat with the agent. Posts to /api/chat — owned by senior-backend
 * and being built in parallel, so this degrades gracefully rather than
 * assuming the endpoint is reachable (e.g. ANTHROPIC_API_KEY unset locally):
 *  - a failed/missing/non-JSON response marks that message "Not Delivered"
 *    (an intentional nod to the iMessage bridge this whole product is built
 *    on) instead of throwing, and surfaces a one-time explanatory note.
 *  - a successful response renders `reply` like an ordinary chat — no code
 *    changes needed here once the route is fully wired up end to end.
 */
export function ChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [everFailed, setEverFailed] = useState(false);
  const [everSucceeded, setEverSucceeded] = useState(false);
  const inputId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending) return;

    const userMessageId = crypto.randomUUID();
    // The API is stateless per request — send the whole conversation so far
    // (including this new message), not just the latest turn.
    const wireHistory: WireMessage[] = [
      ...messages.map((m) => ({
        role: (m.role === "user" ? "user" : "assistant") as WireMessage["role"],
        content: m.text,
      })),
      { role: "user", content: text },
    ];

    setMessages((prev) => [
      ...prev,
      { id: userMessageId, role: "user", text, status: "sending" },
    ]);
    setInput("");
    setSending(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: wireHistory }),
      });

      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        throw new Error(`Chat endpoint returned non-JSON (status ${res.status})`);
      }

      const data: unknown = await res.json();
      if (!res.ok) {
        const message =
          typeof data === "object" && data !== null && "error" in data
            ? String((data as { error: unknown }).error)
            : `Chat endpoint returned ${res.status}`;
        throw new Error(message);
      }

      const reply =
        typeof data === "object" && data !== null && typeof (data as { reply?: unknown }).reply === "string"
          ? (data as { reply: string }).reply
          : null;
      if (reply === null) {
        throw new Error("Chat endpoint returned an unexpected response shape");
      }

      setMessages((prev) => [
        ...prev.map((m) => (m.id === userMessageId ? { ...m, status: "sent" as const } : m)),
        { id: crypto.randomUUID(), role: "agent", text: reply },
      ]);
      setEverSucceeded(true);
    } catch {
      setMessages((prev) =>
        prev.map((m) => (m.id === userMessageId ? { ...m, status: "failed" as const } : m))
      );
      setEverFailed(true);
    } finally {
      setSending(false);
      requestAnimationFrame(() => {
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
      });
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
            <Bot className="size-6 text-muted-foreground/70" />
            <p className="max-w-52">
              Ask the agent to add an event, check the schedule, or anything
              else you’d text the group chat.
            </p>
          </div>
        )}

        {messages.map((m) => (
          <div
            key={m.id}
            className={cn("flex flex-col gap-1", m.role === "user" ? "items-end" : "items-start")}
          >
            <div
              className={cn(
                "max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed",
                m.role === "user"
                  ? "rounded-br-sm bg-primary text-primary-foreground"
                  : "rounded-bl-sm bg-muted text-foreground"
              )}
            >
              {m.text}
            </div>
            {m.status === "failed" && (
              <span className="flex items-center gap-1 px-1 text-xs text-destructive">
                <CircleAlert className="size-3" />
                Not Delivered
              </span>
            )}
          </div>
        ))}

        {!everSucceeded && everFailed && (
          <div className="rounded-lg border border-dashed border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            Connecting agent… the dashboard chat endpoint isn’t live yet, so
            messages here won’t be delivered until it is. Text the family
            group chat directly in the meantime.
          </div>
        )}
      </div>

      <form onSubmit={handleSubmit} className="flex items-end gap-2 border-t border-border p-3">
        <label htmlFor={inputId} className="sr-only">
          Message the agent
        </label>
        <input
          id={inputId}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message the agent…"
          autoComplete="off"
          className="h-9 w-full min-w-0 rounded-lg border border-input bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        <Button type="submit" size="icon" disabled={!input.trim() || sending} aria-label="Send">
          <ArrowUp />
        </Button>
      </form>
    </div>
  );
}
