"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { FamilyMember } from "@/lib/mock/types";
import { NAV_LINKS } from "@/components/layout/nav-links";
import { FamilySwitcher } from "@/components/layout/family-switcher";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { cn } from "@/lib/utils";

export function AppSidebar({ members }: { members: FamilyMember[] }) {
  const pathname = usePathname();

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex">
      <div className="flex h-16 shrink-0 items-center gap-2 px-5">
        <span className="font-heading text-lg font-semibold tracking-tight text-sidebar-foreground">
          LuthCal
        </span>
      </div>

      <nav className="flex-1 space-y-0.5 px-3">
        {NAV_LINKS.map((link) => {
          const active = pathname === link.href;
          const Icon = link.icon;
          return (
            <Link
              key={link.href}
              href={link.href}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
              )}
            >
              <Icon className="size-4" />
              {link.label}
            </Link>
          );
        })}
      </nav>

      <div className="space-y-1 border-t border-sidebar-border p-3">
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">
            <FamilySwitcher members={members} />
          </div>
          <ThemeToggle />
        </div>
      </div>
    </aside>
  );
}
