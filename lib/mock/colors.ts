import type { CSSProperties } from "react";
import type { MemberColor } from "./types";

// The rotation new family members are assigned from, in order. Keep in sync
// with the `--member-*` custom properties defined in `app/globals.css`.
export const MEMBER_COLOR_KEYS: MemberColor[] = [
  "blue",
  "violet",
  "rose",
  "teal",
  "amber",
  "green",
  "slate",
];

export const MEMBER_COLOR_LABELS: Record<MemberColor, string> = {
  blue: "Blue",
  violet: "Violet",
  rose: "Rose",
  teal: "Teal",
  amber: "Amber",
  green: "Green",
  slate: "Slate",
};

/** Picks the next color not already in use by an existing member, cycling
 * back to the start of the rotation once every color is taken. */
export function nextAvailableColor(usedColors: MemberColor[]): MemberColor {
  const unused = MEMBER_COLOR_KEYS.find((c) => !usedColors.includes(c));
  if (unused) return unused;
  return MEMBER_COLOR_KEYS[usedColors.length % MEMBER_COLOR_KEYS.length];
}

// ---------------------------------------------------------------------------
// Style helpers — every component that needs a member's color goes through
// these instead of touching `--member-*` CSS variables directly, so the
// palette only has to be right in one place (app/globals.css).
// ---------------------------------------------------------------------------

/** Solid fill — member avatars, legend dots, the color swatch in the family
 * table. High-chroma, same value in light/dark (brand-ish accent, not a
 * surface color). */
export function memberSolidStyle(color: MemberColor): CSSProperties {
  return {
    backgroundColor: `var(--member-${color})`,
    color: `var(--member-${color}-foreground)`,
  };
}

/** Soft tinted fill for month-view event chips — a low-opacity wash of the
 * member color mixed into the current card surface, so it reads correctly
 * in both themes without a second set of variables. Pair with a solid
 * left border in the same color for a clear identity marker even for
 * colorblind users who can't rely on hue alone. */
export function memberSoftStyle(color: MemberColor): CSSProperties {
  return {
    backgroundColor: `color-mix(in oklch, var(--member-${color}) 16%, var(--card))`,
    borderColor: `var(--member-${color})`,
    color: "var(--foreground)",
  };
}

/** Bare color dot/swatch — legends, color pickers. */
export function memberDotStyle(color: MemberColor): CSSProperties {
  return { backgroundColor: `var(--member-${color})` };
}
