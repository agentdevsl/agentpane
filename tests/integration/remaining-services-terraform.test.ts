import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { settings, terraformModules, terraformRegistries } from '../../src/db/schema';
import { TERRAFORM_MIGRATION_SQL } from '../../src/lib/bootstrap/phases/schema';
import { clearTestDatabase, execRawSql, getTestDb, setupTestDatabase } from '../helpers/database';

describe('Remaining Services: Terraform (IT-221 to IT-222)', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    // Run terraform migration to create tables
    try {
      execRawSql(TERRAFORM_MIGRATION_SQL);
    } catch {
      // Tables may already exist
    }
    await db.delete(settings);
    await db.delete(terraformModules);
    await db.delete(terraformRegistries);
  });

  afterEach(async () => {
    await db.delete(settings);
    await db.delete(terraformModules);
    await db.delete(terraformRegistries);
    await clearTestDatabase();
  });

  it('IT-221: terraform settings for compose configuration', async () => {
    // Store terraform-related settings
    await db.insert(settings).values({
      key: 'terraform.defaultModel',
      value: JSON.stringify('claude-sonnet-4'),
    });
    await db.insert(settings).values({
      key: 'terraform.systemPrompt',
      value: JSON.stringify('Generate production-ready HCL'),
    });

    const modelSetting = await db.query.settings.findFirst({
      where: eq(settings.key, 'terraform.defaultModel'),
    });
    expect(modelSetting).toBeTruthy();
    expect(JSON.parse(modelSetting!.value)).toBe('claude-sonnet-4');

    const promptSetting = await db.query.settings.findFirst({
      where: eq(settings.key, 'terraform.systemPrompt'),
    });
    expect(JSON.parse(promptSetting!.value)).toBe('Generate production-ready HCL');
  });

  it('IT-222: terraform registry + module CRUD', async () => {
    const registryId = createId();
    await db.insert(terraformRegistries).values({
      id: registryId,
      name: 'HashiCorp Registry',
      orgName: 'hashicorp',
      tokenSettingKey: 'terraform.registry.token',
      status: 'active',
      moduleCount: 0,
    });

    // Insert module
    const moduleId = createId();
    await db.insert(terraformModules).values({
      id: moduleId,
      registryId,
      name: 'vpc',
      namespace: 'hashicorp',
      provider: 'aws',
      version: '5.0.0',
      source: 'hashicorp/vpc/aws',
      description: 'AWS VPC module',
      inputs: [
        { name: 'cidr_block', type: 'string', required: true, description: 'CIDR block' },
        { name: 'enable_dns', type: 'bool', required: false, default: true },
      ],
      outputs: [{ name: 'vpc_id', description: 'The VPC ID' }],
    });

    // Verify
    const registry = await db.query.terraformRegistries.findFirst({
      where: eq(terraformRegistries.id, registryId),
    });
    expect(registry!.name).toBe('HashiCorp Registry');

    const module = await db.query.terraformModules.findFirst({
      where: eq(terraformModules.id, moduleId),
    });
    expect(module!.name).toBe('vpc');
    expect(module!.provider).toBe('aws');
    expect(module!.inputs).toHaveLength(2);
    expect(module!.outputs).toHaveLength(1);

    // Search by name
    const searchResults = await db.query.terraformModules.findMany({
      where: eq(terraformModules.registryId, registryId),
    });
    expect(searchResults.length).toBe(1);
    expect(searchResults[0]!.name).toBe('vpc');
  });
});
