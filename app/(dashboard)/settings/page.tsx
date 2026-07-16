import { getServerAdapter } from "@/lib/mock/server";
import { SettingsForm } from "@/components/settings/settings-form";
import { SectionHeader } from "@/components/section-header";

export const metadata = { title: "Settings" };

// Live data (DB + Google Calendar) must be fetched fresh per request, never
// baked in at build time — see lib/mock/server.ts.
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const settings = await getServerAdapter().getSettings();

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
      <SectionHeader
        title="Settings"
        description="Digest schedule, reminders, and the family’s timezone."
      />
      <SettingsForm initialSettings={settings} />
    </div>
  );
}
