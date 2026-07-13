"use client";

import { useState } from "react";
import { toast } from "sonner";
import type { Settings, WeekdayName } from "@/lib/mock/types";
import { mockDelay } from "@/lib/mock/adapter";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

const WEEKDAYS: { value: WeekdayName; label: string }[] = [
  { value: "sunday", label: "Sunday" },
  { value: "monday", label: "Monday" },
  { value: "tuesday", label: "Tuesday" },
  { value: "wednesday", label: "Wednesday" },
  { value: "thursday", label: "Thursday" },
  { value: "friday", label: "Friday" },
  { value: "saturday", label: "Saturday" },
];

const REMINDER_LEAD_OPTIONS = [1, 2, 4, 6, 12, 24, 48];

const TIMEZONES = [
  { value: "America/New_York", label: "Eastern — New York" },
  { value: "America/Chicago", label: "Central — Chicago" },
  { value: "America/Denver", label: "Mountain — Denver" },
  { value: "America/Phoenix", label: "Mountain, no DST — Phoenix" },
  { value: "America/Los_Angeles", label: "Pacific — Los Angeles" },
  { value: "America/Anchorage", label: "Alaska — Anchorage" },
  { value: "Pacific/Honolulu", label: "Hawaii — Honolulu" },
];

export function SettingsForm({ initialSettings }: { initialSettings: Settings }) {
  const [settings, setSettings] = useState(initialSettings);
  const [saving, setSaving] = useState(false);

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    setSaving(true);
    await mockDelay();
    setSaving(false);
    toast.success("Settings saved", {
      description: "This is a dashboard-only preview — nothing is persisted yet.",
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle>Daily digest</CardTitle>
          <CardDescription>A morning rundown of what’s on the calendar today.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="daily-enabled">Send daily digest</Label>
            <Switch
              id="daily-enabled"
              checked={settings.dailyDigestEnabled}
              onCheckedChange={(v) => update("dailyDigestEnabled", v)}
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="daily-time">Send time</Label>
            <input
              id="daily-time"
              type="time"
              disabled={!settings.dailyDigestEnabled}
              value={settings.dailyDigestTime}
              onChange={(e) => update("dailyDigestTime", e.target.value)}
              className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Weekly digest</CardTitle>
          <CardDescription>A look ahead at the whole week.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="weekly-enabled">Send weekly digest</Label>
            <Switch
              id="weekly-enabled"
              checked={settings.weeklyDigestEnabled}
              onCheckedChange={(v) => update("weeklyDigestEnabled", v)}
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="weekly-day">Day</Label>
            <Select
              value={settings.weeklyDigestDay}
              onValueChange={(v) => update("weeklyDigestDay", v as WeekdayName)}
              disabled={!settings.weeklyDigestEnabled}
            >
              <SelectTrigger id="weekly-day" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WEEKDAYS.map((d) => (
                  <SelectItem key={d.value} value={d.value}>
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="weekly-time">Send time</Label>
            <input
              id="weekly-time"
              type="time"
              disabled={!settings.weeklyDigestEnabled}
              value={settings.weeklyDigestTime}
              onChange={(e) => update("weeklyDigestTime", e.target.value)}
              className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reminders & timezone</CardTitle>
          <CardDescription>How far ahead to remind, and which clock the agent uses.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="lead-time">Reminder lead time</Label>
            <Select
              value={String(settings.reminderLeadHours)}
              onValueChange={(v) => update("reminderLeadHours", Number(v))}
            >
              <SelectTrigger id="lead-time" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REMINDER_LEAD_OPTIONS.map((h) => (
                  <SelectItem key={h} value={String(h)}>
                    {h} hour{h === 1 ? "" : "s"} before
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Separator />
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="timezone">Timezone</Label>
            <Select value={settings.timezone} onValueChange={(v) => v && update("timezone", v)}>
              <SelectTrigger id="timezone" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIMEZONES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </div>
  );
}
