import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sandboxConfigs } from '../../src/db/schema';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('Remaining Services: Sandbox (IT-223 to IT-224)', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-223: sandbox config CRUD — insert, read, update, delete', async () => {
    const configId = createId();

    // Insert
    await db.insert(sandboxConfigs).values({
      id: configId,
      name: 'Docker Default',
      description: 'Default Docker sandbox config',
      type: 'docker',
      isDefault: true,
      baseImage: 'node:22-slim',
      memoryMb: 4096,
      cpuCores: 2.0,
      maxProcesses: 256,
      timeoutMinutes: 60,
      volumeMountPath: '/home/user/projects',
    });

    // Read
    const config = await db.query.sandboxConfigs.findFirst({
      where: eq(sandboxConfigs.id, configId),
    });
    expect(config).toBeTruthy();
    expect(config!.name).toBe('Docker Default');
    expect(config!.type).toBe('docker');
    expect(config!.isDefault).toBe(true);
    expect(config!.baseImage).toBe('node:22-slim');
    expect(config!.memoryMb).toBe(4096);
    expect(config!.cpuCores).toBe(2.0);
    expect(config!.volumeMountPath).toBe('/home/user/projects');

    // Update
    await db
      .update(sandboxConfigs)
      .set({
        memoryMb: 8192,
        cpuCores: 4.0,
        description: 'Updated config',
      })
      .where(eq(sandboxConfigs.id, configId));

    const updated = await db.query.sandboxConfigs.findFirst({
      where: eq(sandboxConfigs.id, configId),
    });
    expect(updated!.memoryMb).toBe(8192);
    expect(updated!.cpuCores).toBe(4.0);
    expect(updated!.description).toBe('Updated config');

    // Delete
    await db.delete(sandboxConfigs).where(eq(sandboxConfigs.id, configId));
    const deleted = await db.query.sandboxConfigs.findFirst({
      where: eq(sandboxConfigs.id, configId),
    });
    expect(deleted).toBeUndefined();
  });

  it('IT-224: duplicate sandbox config — clone with new ID and name suffix', async () => {
    const originalId = createId();
    await db.insert(sandboxConfigs).values({
      id: originalId,
      name: 'Production Config',
      description: 'Production sandbox settings',
      type: 'kubernetes',
      baseImage: 'node:22-slim',
      memoryMb: 8192,
      cpuCores: 4.0,
      maxProcesses: 512,
      timeoutMinutes: 120,
      kubeConfigPath: '~/.kube/config',
      kubeContext: 'prod-cluster',
      kubeNamespace: 'agent-sandboxes',
    });

    // Read original
    const original = await db.query.sandboxConfigs.findFirst({
      where: eq(sandboxConfigs.id, originalId),
    });
    expect(original).toBeTruthy();

    // Clone with new ID and name suffix
    const cloneId = createId();
    await db.insert(sandboxConfigs).values({
      id: cloneId,
      name: `${original!.name} (Copy)`,
      description: original!.description,
      type: original!.type,
      baseImage: original!.baseImage,
      memoryMb: original!.memoryMb,
      cpuCores: original!.cpuCores,
      maxProcesses: original!.maxProcesses,
      timeoutMinutes: original!.timeoutMinutes,
      kubeConfigPath: original!.kubeConfigPath,
      kubeContext: original!.kubeContext,
      kubeNamespace: original!.kubeNamespace,
    });

    const clone = await db.query.sandboxConfigs.findFirst({
      where: eq(sandboxConfigs.id, cloneId),
    });
    expect(clone).toBeTruthy();
    expect(clone!.name).toBe('Production Config (Copy)');
    expect(clone!.memoryMb).toBe(original!.memoryMb);
    expect(clone!.type).toBe('kubernetes');
    expect(clone!.kubeContext).toBe('prod-cluster');
    expect(clone!.id).not.toBe(originalId);
  });
});
