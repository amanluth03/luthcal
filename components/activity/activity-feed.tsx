"use client";

import { useState } from "react";
import { MessagesSquare } from "lucide-react";
import type { ActivityDirection, ActivityEntry, FamilyMember } from "@/lib/mock/types";
import { ActivityItem } from "@/components/activity/activity-item";
import { EmptyState } from "@/components/empty-state";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const FILTERS: Array<{ value: ActivityDirection | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "inbound", label: "From family" },
  { value: "outbound", label: "From agent" },
];

export function ActivityFeed({
  activity,
  members,
  tz,
}: {
  activity: ActivityEntry[];
  members: FamilyMember[];
  tz: string;
}) {
  const [filter, setFilter] = useState<ActivityDirection | "all">("all");
  const filtered = filter === "all" ? activity : activity.filter((a) => a.direction === filter);

  return (
    <div className="flex flex-col gap-5">
      <Tabs value={filter} onValueChange={(v) => setFilter(v as ActivityDirection | "all")}>
        <TabsList>
          {FILTERS.map((f) => (
            <TabsTrigger key={f.value} value={f.value}>
              {f.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {filtered.length === 0 && activity.length === 0 && (
        <EmptyState
          icon={MessagesSquare}
          title="No activity yet"
          description="Texts from the family and the agent's replies will show up here as soon as the group chat is wired up."
        />
      )}

      {filtered.length === 0 && activity.length > 0 && (
        <EmptyState icon={MessagesSquare} title="No activity matches this filter" />
      )}

      <div className="flex flex-col">
        {filtered.map((entry, i) => (
          <ActivityItem
            key={entry.id}
            entry={entry}
            member={members.find((m) => m.name === entry.sender)}
            tz={tz}
            isLast={i === filtered.length - 1}
          />
        ))}
      </div>
    </div>
  );
}
