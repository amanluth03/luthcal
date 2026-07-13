import { memberDotStyle } from "@/lib/mock/colors";
import type { MemberColor } from "@/lib/mock/types";
import { cn } from "@/lib/utils";

export function MemberColorDot({
  color,
  className,
}: {
  color: MemberColor;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      style={memberDotStyle(color)}
      className={cn("inline-block size-2.5 shrink-0 rounded-full", className)}
    />
  );
}
