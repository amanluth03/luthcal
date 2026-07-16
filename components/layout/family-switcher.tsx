"use client";

import { useState } from "react";
import { ChevronsUpDown, Check } from "lucide-react";
import type { FamilyMember } from "@/lib/mock/types";
import { MemberAvatar } from "@/components/member/member-avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

/**
 * "Viewing as" switcher — static per spec (no auth/session yet). Purely
 * changes which member is highlighted as "you" in this browser tab; doesn't
 * persist or affect any data.
 */
export function FamilySwitcher({ members }: { members: FamilyMember[] }) {
  const [activeId, setActiveId] = useState(members[0]?.id);
  const active = members.find((m) => m.id === activeId) ?? members[0];

  if (!active) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            className="w-full justify-start gap-2 px-2"
          />
        }
      >
        <MemberAvatar member={active} size="sm" />
        <span className="flex-1 truncate text-left text-sm font-medium">
          {active.name}
        </span>
        <ChevronsUpDown className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Viewing as</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {members.map((m) => (
            <DropdownMenuItem key={m.id} onClick={() => setActiveId(m.id)}>
              <MemberAvatar member={m} size="sm" />
              <span className="flex-1 truncate">{m.name}</span>
              {m.id === active.id && <Check className="size-3.5" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
