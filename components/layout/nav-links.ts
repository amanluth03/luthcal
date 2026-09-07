import type { LucideIcon } from "lucide-react";
import {
  BrainCircuit,
  CalendarDays,
  ListChecks,
  MessageSquareText,
  Settings2,
  Users,
} from "lucide-react";

export interface NavLink {
  href: string;
  label: string;
  icon: LucideIcon;
}

// Shared between the desktop sidebar and the mobile sheet nav so the two
// never drift out of sync.
export const NAV_LINKS: NavLink[] = [
  { href: "/", label: "Calendar", icon: CalendarDays },
  { href: "/digests", label: "Digests", icon: MessageSquareText },
  { href: "/activity", label: "Activity", icon: ListChecks },
  { href: "/memory", label: "Memory", icon: BrainCircuit },
  { href: "/family", label: "Family", icon: Users },
  { href: "/settings", label: "Settings", icon: Settings2 },
];
