import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export function CalendarToolbar({
  label,
  onPrev,
  onNext,
  onToday,
}: {
  label: string;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="sm" onClick={onToday}>
        Today
      </Button>
      <div className="flex items-center">
        <Button variant="ghost" size="icon-sm" onClick={onPrev} aria-label="Previous">
          <ChevronLeft />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onNext} aria-label="Next">
          <ChevronRight />
        </Button>
      </div>
      <h2 className="font-heading text-base font-medium md:text-lg">{label}</h2>
    </div>
  );
}
