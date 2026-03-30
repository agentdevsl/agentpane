import { createFileRoute } from '@tanstack/react-router';
import { SandboxSettingsPage } from './sandbox/-sandbox-page.js';

export const Route = createFileRoute('/settings/sandbox')({
  component: SandboxSettingsPage,
});
