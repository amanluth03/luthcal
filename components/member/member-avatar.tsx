import { memberSolidStyle } from "@/lib/mock/colors";
import type { FamilyMember } from "@/lib/mock/types";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}

export function MemberAvatar({
  member,
  size = "default",
  className,
}: {
  member: Pick<FamilyMember, "name" | "color">;
  size?: "sm" | "default" | "lg";
  className?: string;
}) {
  return (
    <Avatar size={size} className={className}>
      <AvatarFallback
        style={memberSolidStyle(member.color)}
        className={cn("font-heading font-medium")}
      >
        {initials(member.name)}
      </AvatarFallback>
    </Avatar>
  );
}
