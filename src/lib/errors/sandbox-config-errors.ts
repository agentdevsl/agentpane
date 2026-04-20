import { createError } from './base.js';

export const SandboxConfigErrors = {
  NOT_FOUND: createError('SANDBOX_CONFIG_NOT_FOUND', 'Sandbox configuration not found', 404),
  ALREADY_EXISTS: createError(
    'SANDBOX_CONFIG_ALREADY_EXISTS',
    'A sandbox configuration with this name already exists',
    409
  ),
  IN_USE: (projectCount: number) =>
    createError(
      'SANDBOX_CONFIG_IN_USE',
      `Cannot delete sandbox configuration - it is used by ${projectCount} project(s)`,
      409,
      { projectCount }
    ),
  INVALID_MEMORY: (value: number) =>
    createError(
      'SANDBOX_CONFIG_INVALID_MEMORY',
      `Invalid memory value: ${value}MB. Must be between 512 and 32768`,
      400,
      {
        value,
        min: 512,
        max: 32768,
      }
    ),
  INVALID_CPU: (value: number) =>
    createError(
      'SANDBOX_CONFIG_INVALID_CPU',
      `Invalid CPU value: ${value} cores. Must be between 0.5 and 16`,
      400,
      {
        value,
        min: 0.5,
        max: 16,
      }
    ),
  INVALID_PROCESSES: (value: number) =>
    createError(
      'SANDBOX_CONFIG_INVALID_PROCESSES',
      `Invalid max processes value: ${value}. Must be between 32 and 4096`,
      400,
      {
        value,
        min: 32,
        max: 4096,
      }
    ),
  INVALID_TIMEOUT: (value: number) =>
    createError(
      'SANDBOX_CONFIG_INVALID_TIMEOUT',
      `Invalid timeout value: ${value} minutes. Must be between 1 and 1440`,
      400,
      {
        value,
        min: 1,
        max: 1440,
      }
    ),
  DEFAULT_EXISTS: createError(
    'SANDBOX_CONFIG_DEFAULT_EXISTS',
    'A default sandbox configuration already exists. Remove the default flag from the existing configuration first.',
    409
  ),
  IMAGE_NOT_DIGEST_PINNED: (image: string) =>
    createError(
      'SANDBOX_CONFIG_IMAGE_NOT_DIGEST_PINNED',
      `Sandbox image must be digest-pinned (format: '<image>@sha256:<64 hex chars>'). ` +
        `Tag-only references (e.g. ':latest') are not allowed for supply-chain safety. Received: '${image}'`,
      400,
      { image }
    ),
  QUOTA_EXCEEDED: (field: string, requested: number, ceiling: number) =>
    createError(
      'SANDBOX_QUOTA_EXCEEDED',
      `Sandbox quota exceeded: ${field} requested ${requested} exceeds tenant ceiling ${ceiling}`,
      403,
      { field, requested, ceiling }
    ),
} as const;

export type SandboxConfigError =
  | typeof SandboxConfigErrors.NOT_FOUND
  | typeof SandboxConfigErrors.ALREADY_EXISTS
  | typeof SandboxConfigErrors.DEFAULT_EXISTS
  | ReturnType<typeof SandboxConfigErrors.IN_USE>
  | ReturnType<typeof SandboxConfigErrors.INVALID_MEMORY>
  | ReturnType<typeof SandboxConfigErrors.INVALID_CPU>
  | ReturnType<typeof SandboxConfigErrors.INVALID_PROCESSES>
  | ReturnType<typeof SandboxConfigErrors.INVALID_TIMEOUT>
  | ReturnType<typeof SandboxConfigErrors.IMAGE_NOT_DIGEST_PINNED>
  | ReturnType<typeof SandboxConfigErrors.QUOTA_EXCEEDED>;
