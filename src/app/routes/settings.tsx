import { createFileRoute, Outlet } from '@tanstack/react-router';
import { SettingsSidebar } from '@/app/components/features/settings-sidebar';

export const Route = createFileRoute('/settings')({
  component: SettingsLayout,
});

function SettingsLayout(): React.JSX.Element {
  return (
    <div className="flex h-screen bg-canvas text-fg">
      <SettingsSidebar />
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
