"use client";

import { useEffect } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Segment error boundary for the dashboard's content pages. The real data
 * adapter (lib/data/server-adapter.ts) deliberately lets DB / Google Calendar
 * failures propagate rather than masking them as empty content, so a transient
 * backend hiccup surfaces here as a designed "couldn't load" state with a
 * retry instead of Next's raw 500 page.
 *
 * Note: per Next's error-boundary semantics, this does NOT catch a throw from
 * app/(dashboard)/layout.tsx itself (the sidebar's roster fetch) — that bubbles
 * to the root. See the layout for its own guard.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Dashboard page failed to render:", error);
  }, [error]);

  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-12 text-center">
      <TriangleAlert className="size-6 text-muted-foreground/70" />
      <p className="text-sm font-medium text-foreground">Couldn&apos;t load this page</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        We hit a problem reaching the calendar or database. Your calendar data is
        safe — this is just the dashboard view. Try again in a moment.
      </p>
      <Button variant="outline" size="sm" onClick={reset} className="mt-1">
        Try again
      </Button>
    </div>
  );
}
