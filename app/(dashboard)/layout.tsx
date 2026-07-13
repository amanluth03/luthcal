import { dataAdapter } from "@/lib/mock";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { AppTopbar } from "@/components/layout/app-topbar";
import { ChatLauncher } from "@/components/chat/chat-launcher";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const members = await dataAdapter.getFamilyMembers();

  return (
    <div className="flex h-dvh min-h-0 w-full">
      <AppSidebar members={members} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <AppTopbar members={members} />
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8 md:py-8">
            {children}
          </div>
        </main>
      </div>
      <ChatLauncher />
    </div>
  );
}
