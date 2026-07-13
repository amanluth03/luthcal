import { Check } from "lucide-react";
import { MEMBER_COLOR_KEYS, MEMBER_COLOR_LABELS, memberSolidStyle } from "@/lib/mock/colors";
import type { MemberColor } from "@/lib/mock/types";
import { cn } from "@/lib/utils";

export function ColorPicker({
  value,
  onChange,
}: {
  value: MemberColor;
  onChange: (color: MemberColor) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Color">
      {MEMBER_COLOR_KEYS.map((color) => {
        const selected = value === color;
        return (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={MEMBER_COLOR_LABELS[color]}
            title={MEMBER_COLOR_LABELS[color]}
            onClick={() => onChange(color)}
            style={memberSolidStyle(color)}
            className={cn(
              "flex size-7 items-center justify-center rounded-full ring-2 ring-offset-2 ring-offset-background transition-shadow",
              selected ? "ring-foreground" : "ring-transparent hover:ring-border"
            )}
          >
            {selected && <Check className="size-3.5" />}
          </button>
        );
      })}
    </div>
  );
}
