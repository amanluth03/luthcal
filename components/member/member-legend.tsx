import type { FamilyMember } from "@/lib/mock/types";
import { MemberColorDot } from "@/components/member/member-color-dot";
import { cn } from "@/lib/utils";

export function MemberLegend({
  members,
  className,
}: {
  members: FamilyMember[];
  className?: string;
}) {
  return (
    <ul className={cn("flex flex-wrap items-center gap-x-4 gap-y-1.5", className)}>
      {members.map((m) => (
        <li key={m.id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <MemberColorDot color={m.color} />
          {m.name}
        </li>
      ))}
    </ul>
  );
}
