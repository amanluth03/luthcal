import type { LucideIcon } from "lucide-react";

/** Shared empty-state block for feeds/lists with nothing to show yet —
 * an icon, a short title, and an optional helper line. Used for both
 * "genuinely nothing here" (e.g. no digests sent yet) and "nothing matches
 * the current filter" states, distinguished by the caller's copy. */
export function EmptyState({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-12 text-center">
      <Icon className="size-6 text-muted-foreground/70" />
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && (
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      )}
    </div>
  );
}
