import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { settings, terraformModules, terraformRegistries } from '../../src/db/schema';
import { TERRAFORM_MIGRATION_SQL } from '../../src/lib/bootstrap/phases/schema';
import { decryptToken } from '../../src/lib/crypto/server-encryption';
import { TerraformRegistryService } from '../../src/services/terraform-registry.service';
import { clearTestDatabase, execRawSql, getTestDb, setupTestDatabase } from '../helpers/database';

describe('TerraformRegistryService', () => {
  let service: TerraformRegistryService;

  beforeEach(async () => {
    await setupTestDatabase();
    execRawSql(TERRAFORM_MIGRATION_SQL);
    service = new TerraformRegistryService(getTestDb());
  });

  afterEach(async () => {
    const db = getTestDb();
    await db.delete(terraformModules);
    await db.delete(terraformRegistries);
    await db.delete(settings);
    await clearTestDatabase();
  });

  it('creates a registry with a registry-specific encrypted token', async () => {
    const result = await service.createRegistry({
      name: 'Acme Registry',
      orgName: 'acme-org',
      apiToken: 'sk-tfe-secret-token',
      syncIntervalMinutes: 15,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const db = getTestDb();
    const storedSetting = await db.query.settings.findFirst({
      where: (table, { eq }) => eq(table.key, result.value.tokenSettingKey),
    });

    expect(result.value.tokenSettingKey).toContain(result.value.id);
    expect(storedSetting).toBeTruthy();
    expect(storedSetting?.value).not.toBe('sk-tfe-secret-token');
    expect(decryptToken(storedSetting?.value ?? '')).toBe('sk-tfe-secret-token');
  });

  it('updates the encrypted token without changing the registry-specific key', async () => {
    const createResult = await service.createRegistry({
      name: 'Acme Registry',
      orgName: 'acme-org',
      apiToken: 'sk-tfe-original',
      syncIntervalMinutes: 30,
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) {
      return;
    }

    const updateResult = await service.updateRegistry(createResult.value.id, {
      orgName: 'acme-platform',
      apiToken: 'sk-tfe-updated',
      syncIntervalMinutes: 60,
    });

    expect(updateResult.ok).toBe(true);
    if (!updateResult.ok) {
      return;
    }

    const db = getTestDb();
    const storedSetting = await db.query.settings.findFirst({
      where: (table, { eq }) => eq(table.key, createResult.value.tokenSettingKey),
    });

    expect(updateResult.value.tokenSettingKey).toBe(createResult.value.tokenSettingKey);
    expect(updateResult.value.orgName).toBe('acme-platform');
    expect(updateResult.value.syncIntervalMinutes).toBe(60);
    expect(decryptToken(storedSetting?.value ?? '')).toBe('sk-tfe-updated');
  });

  it('deletes the registry token when the registry is removed', async () => {
    const createResult = await service.createRegistry({
      name: 'Acme Registry',
      orgName: 'acme-org',
      apiToken: 'sk-tfe-secret-token',
      syncIntervalMinutes: 15,
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) {
      return;
    }

    const deleteResult = await service.deleteRegistry(createResult.value.id);
    expect(deleteResult.ok).toBe(true);

    const db = getTestDb();
    const storedSetting = await db.query.settings.findFirst({
      where: (table, { eq }) => eq(table.key, createResult.value.tokenSettingKey),
    });

    expect(storedSetting).toBeUndefined();
  });

  it('uses distinct token keys for different registries', async () => {
    const first = await service.createRegistry({
      name: 'Registry One',
      orgName: 'acme-one',
      apiToken: 'sk-tfe-one',
    });
    const second = await service.createRegistry({
      name: 'Registry Two',
      orgName: 'acme-two',
      apiToken: 'sk-tfe-two',
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }

    expect(first.value.tokenSettingKey).not.toBe(second.value.tokenSettingKey);
  });
});
