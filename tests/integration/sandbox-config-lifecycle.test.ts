import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SandboxConfigService } from '../../src/services/sandbox-config.service';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('SandboxConfigService — lifecycle integration tests', () => {
  let db: ReturnType<typeof getTestDb>;
  let service: SandboxConfigService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    service = new SandboxConfigService(db as any);
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-358: Create Docker config with all fields — persisted correctly via getById', async () => {
    const result = await service.create({
      name: 'Docker Full',
      description: 'Full Docker config with all fields',
      type: 'docker',
      isDefault: false,
      baseImage: 'ubuntu:24.04',
      memoryMb: 8192,
      cpuCores: 4.0,
      maxProcesses: 512,
      timeoutMinutes: 120,
      volumeMountPath: '/home/user/projects',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const config = result.value;
    expect(config.id).toBeDefined();
    expect(config.name).toBe('Docker Full');
    expect(config.description).toBe('Full Docker config with all fields');
    expect(config.type).toBe('docker');
    expect(config.isDefault).toBe(false);
    expect(config.baseImage).toBe('ubuntu:24.04');
    expect(config.memoryMb).toBe(8192);
    expect(config.cpuCores).toBe(4.0);
    expect(config.maxProcesses).toBe(512);
    expect(config.timeoutMinutes).toBe(120);
    expect(config.volumeMountPath).toBe('/home/user/projects');

    // Verify persistence via getById
    const getResult = await service.getById(config.id);
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;

    expect(getResult.value.name).toBe('Docker Full');
    expect(getResult.value.type).toBe('docker');
    expect(getResult.value.baseImage).toBe('ubuntu:24.04');
    expect(getResult.value.memoryMb).toBe(8192);
    expect(getResult.value.cpuCores).toBe(4.0);
    expect(getResult.value.maxProcesses).toBe(512);
    expect(getResult.value.timeoutMinutes).toBe(120);
    expect(getResult.value.volumeMountPath).toBe('/home/user/projects');
  });

  it('IT-359: Create Kubernetes config with kubeContext, kubeNamespace — k8s fields stored', async () => {
    const result = await service.create({
      name: 'K8s Production',
      type: 'kubernetes',
      kubeConfigPath: '/home/user/.kube/config',
      kubeContext: 'production-cluster',
      kubeNamespace: 'agent-sandboxes',
      networkPolicyEnabled: true,
      allowedEgressHosts: ['api.github.com', 'registry.npmjs.org'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const config = result.value;
    expect(config.type).toBe('kubernetes');
    expect(config.kubeConfigPath).toBe('/home/user/.kube/config');
    expect(config.kubeContext).toBe('production-cluster');
    expect(config.kubeNamespace).toBe('agent-sandboxes');
    expect(config.networkPolicyEnabled).toBe(true);
    expect(config.allowedEgressHosts).toEqual(['api.github.com', 'registry.npmjs.org']);

    // Verify via getById
    const getResult = await service.getById(config.id);
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;

    expect(getResult.value.kubeContext).toBe('production-cluster');
    expect(getResult.value.kubeNamespace).toBe('agent-sandboxes');
  });

  it('IT-360: Create Nomad config with nomadAddress, nomadToken — token encrypted then decrypted on read', async () => {
    const nomadToken = 'secret-nomad-acl-token-abc123';

    const result = await service.create({
      name: 'Nomad Staging',
      type: 'nomad',
      nomadAddress: 'https://nomad.staging.internal:4646',
      nomadToken,
      nomadNamespace: 'staging',
      nomadDatacenter: 'dc1',
      nomadRegion: 'us-east-1',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const config = result.value;
    expect(config.type).toBe('nomad');
    expect(config.nomadAddress).toBe('https://nomad.staging.internal:4646');
    // The returned value should be decrypted (readable plaintext)
    expect(config.nomadToken).toBe(nomadToken);
    expect(config.nomadNamespace).toBe('staging');
    expect(config.nomadDatacenter).toBe('dc1');
    expect(config.nomadRegion).toBe('us-east-1');

    // Verify the raw DB value is encrypted (not plaintext)
    const rawRow = await db.query.sandboxConfigs.findFirst({
      where: (t, { eq }) => eq(t.id, config.id),
    });
    expect(rawRow).toBeTruthy();
    expect(rawRow!.nomadToken).not.toBe(nomadToken);
    expect(rawRow!.nomadToken).toBeTruthy();

    // Verify getById decrypts back to plaintext
    const getResult = await service.getById(config.id);
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;
    expect(getResult.value.nomadToken).toBe(nomadToken);
  });

  it('IT-361: Set isDefault=true on new config — previous default cleared', async () => {
    // Create first config as default
    const first = await service.create({
      name: 'First Default',
      isDefault: true,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.isDefault).toBe(true);

    // Create second config as default — should clear first
    const second = await service.create({
      name: 'Second Default',
      isDefault: true,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.isDefault).toBe(true);

    // Verify first is no longer default
    const firstRefreshed = await service.getById(first.value.id);
    expect(firstRefreshed.ok).toBe(true);
    if (!firstRefreshed.ok) return;
    expect(firstRefreshed.value.isDefault).toBe(false);

    // Verify second is default
    const secondRefreshed = await service.getById(second.value.id);
    expect(secondRefreshed.ok).toBe(true);
    if (!secondRefreshed.ok) return;
    expect(secondRefreshed.value.isDefault).toBe(true);

    // Verify getDefault returns the second config
    const defaultResult = await service.getDefault();
    expect(defaultResult.ok).toBe(true);
    if (!defaultResult.ok) return;
    expect(defaultResult.value).not.toBeNull();
    expect(defaultResult.value!.id).toBe(second.value.id);
  });

  it('IT-362: Update config fields — updated values persisted, unchanged fields preserved', async () => {
    const createResult = await service.create({
      name: 'Update Target',
      description: 'Original description',
      type: 'docker',
      baseImage: 'node:22-slim',
      memoryMb: 4096,
      cpuCores: 2.0,
      maxProcesses: 256,
      timeoutMinutes: 60,
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const configId = createResult.value.id;

    // Update only some fields
    const updateResult = await service.update(configId, {
      description: 'Updated description',
      memoryMb: 8192,
      cpuCores: 8.0,
    });
    expect(updateResult.ok).toBe(true);
    if (!updateResult.ok) return;

    const updated = updateResult.value;

    // Updated fields
    expect(updated.description).toBe('Updated description');
    expect(updated.memoryMb).toBe(8192);
    expect(updated.cpuCores).toBe(8.0);

    // Unchanged fields preserved
    expect(updated.name).toBe('Update Target');
    expect(updated.type).toBe('docker');
    expect(updated.baseImage).toBe('node:22-slim');
    expect(updated.maxProcesses).toBe(256);
    expect(updated.timeoutMinutes).toBe(60);

    // Double-check via fresh read
    const getResult = await service.getById(configId);
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;
    expect(getResult.value.description).toBe('Updated description');
    expect(getResult.value.memoryMb).toBe(8192);
    expect(getResult.value.name).toBe('Update Target');
  });

  it('IT-363: Delete config — success when unreferenced, IN_USE when codespace references it', async () => {
    // Create a config that is NOT referenced by any codespace
    const unreferencedResult = await service.create({
      name: 'Unreferenced Config',
    });
    expect(unreferencedResult.ok).toBe(true);
    if (!unreferencedResult.ok) return;

    const unreferencedId = unreferencedResult.value.id;

    // Delete should succeed
    const deleteResult = await service.delete(unreferencedId);
    expect(deleteResult.ok).toBe(true);

    // Verify it's gone
    const getResult = await service.getById(unreferencedId);
    expect(getResult.ok).toBe(false);

    // Now create a config that IS referenced by a codespace
    const referencedResult = await service.create({
      name: 'Referenced Config',
    });
    expect(referencedResult.ok).toBe(true);
    if (!referencedResult.ok) return;

    const referencedId = referencedResult.value.id;

    // Create a codespace that references this sandbox config
    const project = await createTestProject({
      name: 'Project With Sandbox',
      sandboxConfigId: referencedId,
    });
    expect(project).toBeTruthy();

    // Delete should fail with IN_USE
    const deleteInUseResult = await service.delete(referencedId);
    expect(deleteInUseResult.ok).toBe(false);
    if (!deleteInUseResult.ok) {
      expect(deleteInUseResult.error.code).toContain('IN_USE');
    }

    // Config should still exist
    const stillExists = await service.getById(referencedId);
    expect(stillExists.ok).toBe(true);
  });

  it('IT-364: Duplicate name — ALREADY_EXISTS error', async () => {
    const first = await service.create({
      name: 'Unique Name',
    });
    expect(first.ok).toBe(true);

    // Create another with the same name
    const duplicate = await service.create({
      name: 'Unique Name',
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.error.code).toContain('ALREADY_EXISTS');
    }
  });

  it('IT-365: List configs with pagination — correct totalCount and items length', async () => {
    // Create 5 configs
    for (let i = 1; i <= 5; i++) {
      const result = await service.create({
        name: `Config ${i}`,
        description: `Description ${i}`,
      });
      expect(result.ok).toBe(true);
    }

    // List all (default limit)
    const allResult = await service.list();
    expect(allResult.ok).toBe(true);
    if (!allResult.ok) return;
    expect(allResult.value.totalCount).toBe(5);
    expect(allResult.value.items).toHaveLength(5);

    // List with limit
    const paginatedResult = await service.list({ limit: 2, offset: 0 });
    expect(paginatedResult.ok).toBe(true);
    if (!paginatedResult.ok) return;
    expect(paginatedResult.value.totalCount).toBe(5);
    expect(paginatedResult.value.items).toHaveLength(2);

    // List with offset
    const offsetResult = await service.list({ limit: 3, offset: 3 });
    expect(offsetResult.ok).toBe(true);
    if (!offsetResult.ok) return;
    expect(offsetResult.value.totalCount).toBe(5);
    expect(offsetResult.value.items).toHaveLength(2); // only 2 remaining after offset 3

    // List with offset beyond total
    const emptyResult = await service.list({ limit: 10, offset: 10 });
    expect(emptyResult.ok).toBe(true);
    if (!emptyResult.ok) return;
    expect(emptyResult.value.totalCount).toBe(5);
    expect(emptyResult.value.items).toHaveLength(0);
  });
});
