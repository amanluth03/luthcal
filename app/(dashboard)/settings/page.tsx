import { dataAdapter } from "@/lib/mock";
import { SettingsForm } from "@/components/settings/settings-form";
import { SectionHeader } from "@/components/section-header";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const settings = await dataAdapter.getSettings();

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
