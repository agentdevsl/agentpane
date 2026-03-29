import { createLogger } from '../logging/logger.js';
import type { NewTerraformModule, TerraformOutput, TerraformVariable } from '../../db/schema';

const log = createLogger('TerraformRegistryClient');

export interface RegistryConfig {
  baseUrl: string;
  orgName: string;
  token: string;
}

/** Raw module shape from the HCP Terraform Registry API v2 (JSONAPI) */
interface RawModule {
  id: string;
  type: string;
  attributes: {
    name: string;
    namespace: string;
    provider: string;
    'registry-name'?: string;
    status: string;
    'version-statuses'?: Array<{ version: string; status: string }>;
  };
}

/** Response shape from the Registry v1 API (/api/registry/v1/modules/...) */
interface RegistryV1ModuleDetail {
  id: string;
  description?: string;
  source?: string;
  published_at?: string;
  root?: {
    inputs?: Array<{
      name: string;
      type: string;
      description?: string;
      default?: string;
      required: boolean;
    }>;
    outputs?: Array<{
      name: string;
      description?: string;
    }>;
    provider_dependencies?: Array<{
      name: string;
      namespace: string;
      source: string;
      version: string;
    }>;
    resources?: Array<{
      name: string;
      type: string;
    }>;
    readme?: string;
  };
}

/** JSONAPI response envelope (used by v2 API) */
interface JsonApiResponse<T> {
  data: T;
  links?: {
    self?: string;
    next?: string;
    prev?: string;
    first?: string;
    last?: string;
  };
  meta?: {
    pagination?: {
      'current-page': number;
      'total-pages': number;
      'total-count': number;
    };
  };
}

const MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Make an authenticated request to the HCP Terraform API.
 * Retries on 429 (rate limit) using the Retry-After header with exponential backoff.
 */
async function apiRequest<T>(
  config: RegistryConfig,
  path: string,
  contentType = 'application/vnd.api+json'
): Promise<T> {
  const url = `${config.baseUrl}${path}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': contentType,
      },
    });

    if (response.status === 429) {
      if (attempt === MAX_RETRIES) {
        throw new Error(`HCP Terraform API rate limit exceeded after ${MAX_RETRIES} retries`);
      }
      const retryAfter = response.headers.get('retry-after');
      const waitMs = retryAfter ? Number(retryAfter) * 1000 : 1000 * 2 ** attempt;
      await sleep(waitMs);
      continue;
    }

    if (!response.ok) {
      const body = await response.text();
      const safeBody = body.length > 200 ? `${body.slice(0, 200)}...` : body;
      throw new Error(`HCP Terraform API error (${response.status}): ${safeBody}`);
    }

    return response.json() as Promise<T>;
  }

  throw new Error('Exhausted all retry attempts');
}

/**
 * List all registry modules for an organization.
 * Handles JSONAPI pagination to retrieve all pages.
 */
export async function listRegistryModules(config: RegistryConfig): Promise<RawModule[]> {
  const allModules: RawModule[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const response = await apiRequest<JsonApiResponse<RawModule[]>>(
      config,
      `/api/v2/organizations/${encodeURIComponent(config.orgName)}/registry-modules?page[number]=${page}&page[size]=100`
    );

    allModules.push(...response.data);

    if (response.meta?.pagination) {
      totalPages = response.meta.pagination['total-pages'];
    }

    page++;
  } while (page <= totalPages);

  return allModules;
}

/**
 * Get full detail for a specific module version, including inputs and outputs.
 * Uses the Registry v1 API which works with team tokens.
 */
export async function getModuleDetail(
  config: RegistryConfig,
  namespace: string,
  name: string,
  provider: string,
  version: string
): Promise<{
  source: string;
  description: string | null;
  readme: string | null;
  inputs: TerraformVariable[];
  outputs: TerraformOutput[];
  dependencies: string[];
  publishedAt: string | null;
}> {
  const response = await apiRequest<RegistryV1ModuleDetail>(
    config,
    `/api/registry/v1/modules/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/${encodeURIComponent(provider)}/${encodeURIComponent(version)}`,
    'application/json'
  );

  const root = response.root;

  const inputs: TerraformVariable[] = (root?.inputs ?? []).map((input) => ({
    name: input.name,
    type: input.type,
    description: input.description,
    default: input.default,
    required: input.required,
  }));

  const outputs: TerraformOutput[] = (root?.outputs ?? []).map((output) => ({
    name: output.name,
    description: output.description,
  }));

  const dependencies: string[] = (root?.provider_dependencies ?? []).map((dep) => dep.source);

  return {
    source: response.source ?? '',
    description: response.description ?? null,
    readme: root?.readme ?? null,
    inputs,
    outputs,
    dependencies,
    publishedAt: response.published_at ?? null,
  };
}

/**
 * Sync all modules from a registry.
 * Lists all modules, then fetches details for each in batches of 2
 * with delays between batches to respect HCP Terraform's rate limits (~4 req/s effective throughput).
 */
export async function syncAllModules(config: RegistryConfig): Promise<NewTerraformModule[]> {
  const rawModules = await listRegistryModules(config);
  const results: NewTerraformModule[] = [];

  const batchSize = 2;
  for (let i = 0; i < rawModules.length; i += batchSize) {
    if (i > 0) await sleep(500);
    const batch = rawModules.slice(i, i + batchSize);

    const batchResults = await Promise.all(
      batch.map(async (rawModule) => {
        const { name, namespace, provider } = rawModule.attributes;

        // Determine the latest version from version-statuses
        const versionStatuses = rawModule.attributes['version-statuses'] ?? [];
        const latestVersion =
          versionStatuses.find((v) => v.status === 'ok')?.version ?? versionStatuses[0]?.version;

        if (!latestVersion) {
          return null;
        }

        let detail: {
          source: string;
          description: string | null;
          readme: string | null;
          inputs: TerraformVariable[];
          outputs: TerraformOutput[];
          dependencies: string[];
          publishedAt: string | null;
        } | null = null;

        try {
          detail = await getModuleDetail(config, namespace, name, provider, latestVersion);
        } catch (error) {
          log.debug('Failed to fetch module detail', { error });
        }

        // Private registry module source format: app.terraform.io/<org>/<name>/<provider>
        const registrySource = `app.terraform.io/${config.orgName}/${name}/${provider}`;

        const module: NewTerraformModule = {
          name,
          namespace,
          provider,
          version: latestVersion,
          source: registrySource,
          description: detail?.description ?? null,
          readme: detail?.readme ?? null,
          inputs: detail?.inputs ?? [],
          outputs: detail?.outputs ?? [],
          dependencies: detail?.dependencies ?? [],
          publishedAt: detail?.publishedAt ?? null,
          registryId: '', // Will be set by the service
        };

        return module;
      })
    );

    results.push(...batchResults.filter((r): r is NewTerraformModule => r !== null));
  }

  return results;
}
