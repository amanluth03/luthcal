"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import type { FamilyMember } from "@/lib/mock/types";
import { NAV_LINKS } from "@/components/layout/nav-links";
import { FamilySwitcher } from "@/components/layout/family-switcher";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

export function AppTopbar({ members }: { members: FamilyMember[] }) {
  const pathname = usePathname();
  const current = NAV_LINKS.find((l) => l.href === pathname);

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background/80 px-3 backdrop-blur-sm md:hidden">
      <Sheet>
        <SheetTrigger render={<Button variant="ghost" size="icon" />}>
          <Menu />
          <span className="sr-only">Open navigation</span>
        </SheetTrigger>
        <SheetContent side="left" className="flex w-72 flex-col p-0">
          <SheetHeader className="border-b border-border">
            <SheetTitle className="font-heading text-lg">LuthCal</SheetTitle>
          </SheetHeader>
          <nav className="flex-1 space-y-0.5 p-3">
            {NAV_LINKS.map((link) => {
              const active = pathname === link.href;
              const Icon = link.icon;
              return (
                <SheetClose
                  key={link.href}
                  render={
                    <Link
                      href={link.href}
                      className={cn(
                        "flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                        active
                          ? "bg-accent text-accent-foreground"
                          : "text-foreground/70 hover:bg-accent/60 hover:text-accent-foreground"
                      )}
                    />
                  }
                >
                  <Icon className="size-4" />
                  {link.label}
                </SheetClose>
              );
            })}
          </nav>
          <div className="border-t border-border p-3">
            <FamilySwitcher members={members} />
          </div>
        </SheetContent>
      </Sheet>

      <span className="flex-1 truncate font-heading text-base font-medium">
        {current?.label ?? "LuthCal"}
      </span>

      <ThemeToggle />
    </header>
  );
}
