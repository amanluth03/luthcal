import { memberSolidStyle } from "@/lib/mock/colors";
import type { FamilyMember } from "@/lib/mock/types";
import { cn } from "@/lib/utils";

/** A solid, member-colored badge — used where the member's identity needs to
 * read at a glance (event dialogs, family table). For a lower-emphasis
 * inline mention, use `MemberColorDot` + plain text instead. */
export function MemberBadge({
  member,
  className,
}: {
  member: Pick<FamilyMember, "name" | "color">;
  className?: string;
}) {
  return (
    <span
      style={memberSolidStyle(member.color)}
      className={cn(
        "inline-flex h-5 items-center rounded-full px-2 text-xs font-medium whitespace-nowrap",
        className
      )}
    >
      {member.name}
    </span>
  );
}
