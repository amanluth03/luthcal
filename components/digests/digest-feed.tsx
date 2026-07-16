"use client";

import { useMemo, useState } from "react";
import { Megaphone } from "lucide-react";
import type { DigestEntry, DigestKind } from "@/lib/mock/types";
import { formatDayHeading, groupByDay } from "@/lib/format";
import { DigestCard } from "@/components/digests/digest-card";
import { EmptyState } from "@/components/empty-state";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const FILTERS: Array<{ value: DigestKind | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "announcement", label: "Announcements" },
];

export function DigestFeed({ digests, tz }: { digests: DigestEntry[]; tz: string }) {
  const [filter, setFilter] = useState<DigestKind | "all">("all");

  const filtered = filter === "all" ? digests : digests.filter((d) => d.kind === filter);
  const groups = useMemo(() => groupByDay(filtered, (d) => d.sentAt, tz), [filtered, tz]);

  return (
    <div className="flex flex-col gap-5">
      <Tabs value={filter} onValueChange={(v) => setFilter(v as DigestKind | "all")}>
        <TabsList>
          {FILTERS.map((f) => (
            <TabsTrigger key={f.value} value={f.value}>
              {f.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {groups.length === 0 && digests.length === 0 && (
        <EmptyState
          icon={Megaphone}
          title="No digests yet"
          description="Daily and weekly digests the agent posts to the group chat will show up here once they start going out."
        />
      )}

      {groups.length === 0 && digests.length > 0 && (
        <EmptyState icon={Megaphone} title="No digests match this filter" />
      )}

      <div className="flex flex-col gap-6">
        {groups.map((group) => (
          <div key={group.key} className="flex flex-col gap-2">
            <h3 className="px-1 text-xs font-medium text-muted-foreground">
              {formatDayHeading(group.key, tz)}
            </h3>
            <div className="flex flex-col gap-2">
              {group.items.map((digest) => (
                <DigestCard key={digest.id} digest={digest} tz={tz} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
