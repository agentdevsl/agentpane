import { createId } from '@paralleldrive/cuid2';
import type { NewSandboxInstance, SandboxInstance } from '../../src/db/schema';
import { sandboxInstances } from '../../src/db/schema';
import { getTestDb } from '../helpers/database';

export type SandboxInstanceFactoryOptions = Partial<Omit<NewSandboxInstance, 'codespaceId'>>;

export function buildSandboxInstance(
  codespaceId: string,
  options: SandboxInstanceFactoryOptions = {}
): NewSandboxInstance {
  const id = options.id ?? createId();

  return {
    id,
    codespaceId,
    containerId: options.containerId ?? `container-${id}`,
    status: options.status ?? 'running',
    image: options.image ?? 'agentpane/test:latest',
    memoryMb: options.memoryMb ?? 1024,
    cpuCores: options.cpuCores ?? 1,
    idleTimeoutMinutes: options.idleTimeoutMinutes ?? 30,
    volumeMounts: options.volumeMounts ?? [],
    env: options.env ?? {},
    errorMessage: options.errorMessage ?? null,
    createdAt: options.createdAt ?? new Date().toISOString(),
    lastActivityAt: options.lastActivityAt ?? new Date().toISOString(),
    stoppedAt: options.stoppedAt ?? null,
    updatedAt: options.updatedAt ?? new Date().toISOString(),
  };
}

export async function createTestSandboxInstance(
  codespaceId: string,
  options: SandboxInstanceFactoryOptions = {}
): Promise<SandboxInstance> {
  const db = getTestDb();
  const data = buildSandboxInstance(codespaceId, options);
  const [instance] = await db.insert(sandboxInstances).values(data).returning();

  if (!instance) {
    throw new Error('Failed to create test sandbox instance');
  }

  return instance;
}
