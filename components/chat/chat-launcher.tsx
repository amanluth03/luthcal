"use client";

import { MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { ChatPanel } from "@/components/chat/chat-panel";

/** Persistent entry point to the agent chat, mounted once in the dashboard
 * shell so it's reachable from every page. This is the future home of full
 * in-dashboard agent chat — today it talks to the same /api/chat route the
 * rest of the app will eventually use. */
export function ChatLauncher() {
  return (
    <Sheet>
      <SheetTrigger
        render={
          <Button
            size="icon-lg"
            className="fixed right-5 bottom-5 z-40 rounded-full shadow-lg shadow-primary/20 md:right-8 md:bottom-8"
          />
        }
      >
        <MessageCircle />
        <span className="sr-only">Chat with the agent</span>
      </SheetTrigger>
      <SheetContent side="right" className="flex w-full flex-col p-0 sm:max-w-sm">
        <SheetHeader className="border-b border-border">
          <SheetTitle className="font-heading">Ask the agent</SheetTitle>
          <SheetDescription>
            The same agent that runs in your family’s group chat.
          </SheetDescription>
        </SheetHeader>
        <ChatPanel />
      </SheetContent>
    </Sheet>
  );
}
