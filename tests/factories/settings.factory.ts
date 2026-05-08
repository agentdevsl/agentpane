import type { NewSetting, Setting } from '../../src/db/schema';
import { settings } from '../../src/db/schema';
import { getTestDb } from '../helpers/database';

export type SettingFactoryOptions = Partial<NewSetting> & {
  key: string;
  value: unknown;
};

export function buildSetting(options: SettingFactoryOptions): NewSetting {
  return {
    key: options.key,
    value: typeof options.value === 'string' ? options.value : JSON.stringify(options.value),
    updatedAt: options.updatedAt ?? new Date().toISOString(),
  };
}

export async function createTestSetting(options: SettingFactoryOptions): Promise<Setting> {
  const db = getTestDb();
  const data = buildSetting(options);
  const [setting] = await db.insert(settings).values(data).returning();

  if (!setting) {
    throw new Error('Failed to create test setting');
  }

  return setting;
}

export async function enableSandboxDefaults(
  value: Record<string, unknown> = { enabled: true, mode: 'shared' }
): Promise<Setting> {
  return createTestSetting({ key: 'sandbox.defaults', value });
}
