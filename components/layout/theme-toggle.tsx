"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const MODES = ["light", "dark", "system"] as const;
type Mode = (typeof MODES)[number];

const ICONS: Record<Mode, typeof Sun> = { light: Sun, dark: Moon, system: Monitor };
const LABELS: Record<Mode, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  // Avoid a hydration mismatch: the real theme isn't knowable until mounted.
  const [mounted, setMounted] = useState(false);
  // One-shot mount flag: the server render can't know the resolved theme, so we
  // intentionally flip this once after hydration. This is the canonical
  // next-themes pattern; the set-state-in-effect rule doesn't apply to a
  // mount-only guard that never re-runs.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);

  const current = (mounted ? (theme as Mode) : "system") ?? "system";
  const Icon = ICONS[current];

  function cycle() {
    const idx = MODES.indexOf(current);
    setTheme(MODES[(idx + 1) % MODES.length]);
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={cycle}
      aria-label={`Theme: ${LABELS[current]}. Click to change.`}
      className={cn("text-muted-foreground hover:text-foreground", className)}
    >
      <Icon />
    </Button>
  );
}
