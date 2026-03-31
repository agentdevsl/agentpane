import type { KubeConfig } from '@kubernetes/client-node';
import * as k8s from '@kubernetes/client-node';
import { CRD_API, CRD_EXTENSIONS_API, CRD_PLURALS } from './constants.js';
import { loadKubeConfig } from './kubeconfig.js';
import { CustomResourceCrud } from './operations/crud.js';
import { execInSandbox, execStreamInSandbox } from './operations/exec.js';
import type { WaitForReadyOptions } from './operations/lifecycle.js';
import {
  pause as lifecyclePause,
  resume as lifecycleResume,
  waitForReady as lifecycleWaitForReady,
} from './operations/lifecycle.js';
import type { WatchCallback, WatchHandle, WatchOptions } from './operations/watch.js';
import { startWatch } from './operations/watch.js';
import type { SandboxClaim, SandboxClaimList } from './types/claim.js';
import type { ExecOptions, ExecResult, ExecStreamOptions, ExecStreamResult } from './types/exec.js';
import type { Sandbox, SandboxList } from './types/sandbox.js';
import type { SandboxTemplate, SandboxTemplateList } from './types/template.js';
import type { SandboxWarmPool, SandboxWarmPoolList } from './types/warm-pool.js';

export interface AgentSandboxClientOptions {
  /** KubeConfig instance (auto-loaded if not provided) */
  kubeConfig?: KubeConfig;
  /** Default namespace for all operations */
  namespace?: string;
  /** KubeConfig loading options (used if kubeConfig not provided) */
  kubeconfigPath?: string;
  context?: string;
  skipTLSVerify?: boolean;
}

export class AgentSandboxClient {
  readonly kubeConfig: KubeConfig;
  readonly namespace: string;

  private sandboxCrud: CustomResourceCrud<Sandbox>;
  private templateCrud: CustomResourceCrud<SandboxTemplate>;
  private claimCrud: CustomResourceCrud<SandboxClaim>;
  private warmPoolCrud: CustomResourceCrud<SandboxWarmPool>;

  constructor(options?: AgentSandboxClientOptions) {
    this.kubeConfig =
      options?.kubeConfig ??
      loadKubeConfig({
        kubeconfigPath: options?.kubeconfigPath,
        context: options?.context,
        skipTLSVerify: options?.skipTLSVerify,
      });

    this.namespace = options?.namespace ?? 'agentpane-sandboxes';

    this.sandboxCrud = new CustomResourceCrud<Sandbox>(this.kubeConfig, {
      group: CRD_API.group,
      version: CRD_API.version,
      plural: CRD_PLURALS.sandbox,
    });

    this.templateCrud = new CustomResourceCrud<SandboxTemplate>(this.kubeConfig, {
      group: CRD_EXTENSIONS_API.group,
      version: CRD_EXTENSIONS_API.version,
      plural: CRD_PLURALS.sandboxTemplate,
    });

    this.claimCrud = new CustomResourceCrud<SandboxClaim>(this.kubeConfig, {
      group: CRD_EXTENSIONS_API.group,
      version: CRD_EXTENSIONS_API.version,
      plural: CRD_PLURALS.sandboxClaim,
    });

    this.warmPoolCrud = new CustomResourceCrud<SandboxWarmPool>(this.kubeConfig, {
      group: CRD_EXTENSIONS_API.group,
      version: CRD_EXTENSIONS_API.version,
      plural: CRD_PLURALS.sandboxWarmPool,
    });
  }

  // --- Sandbox CRUD ---

  async createSandbox(sandbox: Sandbox, namespace?: string): Promise<Sandbox> {
    return this.sandboxCrud.create(namespace ?? this.namespace, sandbox);
  }

  async getSandbox(name: string, namespace?: string): Promise<Sandbox> {
    return this.sandboxCrud.get(namespace ?? this.namespace, name);
  }

  async listSandboxes(options?: {
    labelSelector?: string;
    namespace?: string;
  }): Promise<SandboxList> {
    return this.sandboxCrud.list({
      namespace: options?.namespace ?? this.namespace,
      labelSelector: options?.labelSelector,
    }) as Promise<SandboxList>;
  }

  async deleteSandbox(name: string, namespace?: string): Promise<void> {
    return this.sandboxCrud.delete(namespace ?? this.namespace, name);
  }

  async sandboxExists(name: string, namespace?: string): Promise<boolean> {
    return this.sandboxCrud.exists(namespace ?? this.namespace, name);
  }

  // --- Sandbox Lifecycle ---

  async waitForReady(name: string, options?: Partial<WaitForReadyOptions>): Promise<Sandbox> {
    return lifecycleWaitForReady(this.sandboxCrud, {
      name,
      namespace: options?.namespace ?? this.namespace,
      timeoutMs: options?.timeoutMs,
      pollIntervalMs: options?.pollIntervalMs,
    });
  }

  async pause(name: string, reason?: string, namespace?: string): Promise<Sandbox> {
    return lifecyclePause(this.sandboxCrud, namespace ?? this.namespace, name, reason);
  }

  async resume(name: string, namespace?: string): Promise<Sandbox> {
    return lifecycleResume(this.sandboxCrud, namespace ?? this.namespace, name);
  }

  // --- Exec ---

  async exec(
    options: Omit<ExecOptions, 'namespace'> & { namespace?: string }
  ): Promise<ExecResult> {
    return execInSandbox(this.kubeConfig, {
      ...options,
      namespace: options.namespace ?? this.namespace,
    });
  }

  async execStream(
    options: Omit<ExecStreamOptions, 'namespace'> & { namespace?: string }
  ): Promise<ExecStreamResult> {
    return execStreamInSandbox(this.kubeConfig, {
      ...options,
      namespace: options.namespace ?? this.namespace,
    });
  }

  // --- SandboxTemplate CRUD ---

  async createTemplate(template: SandboxTemplate, namespace?: string): Promise<SandboxTemplate> {
    return this.templateCrud.create(namespace ?? this.namespace, template);
  }

  async getTemplate(name: string, namespace?: string): Promise<SandboxTemplate> {
    return this.templateCrud.get(namespace ?? this.namespace, name);
  }

  async listTemplates(namespace?: string): Promise<SandboxTemplateList> {
    return this.templateCrud.list({
      namespace: namespace ?? this.namespace,
    }) as Promise<SandboxTemplateList>;
  }

  async deleteTemplate(name: string, namespace?: string): Promise<void> {
    return this.templateCrud.delete(namespace ?? this.namespace, name);
  }

  // --- SandboxClaim CRUD ---

  async createClaim(claim: SandboxClaim, namespace?: string): Promise<SandboxClaim> {
    return this.claimCrud.create(namespace ?? this.namespace, claim);
  }

  async getClaim(name: string, namespace?: string): Promise<SandboxClaim> {
    return this.claimCrud.get(namespace ?? this.namespace, name);
  }

  async listClaims(namespace?: string): Promise<SandboxClaimList> {
    return this.claimCrud.list({
      namespace: namespace ?? this.namespace,
    }) as Promise<SandboxClaimList>;
  }

  async deleteClaim(name: string, namespace?: string): Promise<void> {
    return this.claimCrud.delete(namespace ?? this.namespace, name);
  }

  // --- SandboxWarmPool CRUD ---

  async createWarmPool(pool: SandboxWarmPool, namespace?: string): Promise<SandboxWarmPool> {
    return this.warmPoolCrud.create(namespace ?? this.namespace, pool);
  }

  async getWarmPool(name: string, namespace?: string): Promise<SandboxWarmPool> {
    return this.warmPoolCrud.get(namespace ?? this.namespace, name);
  }

  async listWarmPools(namespace?: string): Promise<SandboxWarmPoolList> {
    return this.warmPoolCrud.list({
      namespace: namespace ?? this.namespace,
    }) as Promise<SandboxWarmPoolList>;
  }

  async replaceWarmPool(
    name: string,
    pool: SandboxWarmPool,
    namespace?: string
  ): Promise<SandboxWarmPool> {
    return this.warmPoolCrud.update(namespace ?? this.namespace, name, pool);
  }

  async deleteWarmPool(name: string, namespace?: string): Promise<void> {
    return this.warmPoolCrud.delete(namespace ?? this.namespace, name);
  }

  // --- Watch ---

  watchSandboxes(callback: WatchCallback<Sandbox>, options?: Partial<WatchOptions>): WatchHandle {
    return startWatch<Sandbox>(
      this.kubeConfig,
      { group: CRD_API.group, version: CRD_API.version, plural: CRD_PLURALS.sandbox },
      { namespace: options?.namespace ?? this.namespace, ...options },
      callback
    );
  }

  watchClaims(callback: WatchCallback<SandboxClaim>, options?: Partial<WatchOptions>): WatchHandle {
    return startWatch<SandboxClaim>(
      this.kubeConfig,
      {
        group: CRD_EXTENSIONS_API.group,
        version: CRD_EXTENSIONS_API.version,
        plural: CRD_PLURALS.sandboxClaim,
      },
      { namespace: options?.namespace ?? this.namespace, ...options },
      callback
    );
  }

  // --- Health ---

  async healthCheck(): Promise<{
    healthy: boolean;
    controllerInstalled: boolean;
    controllerVersion?: string;
    crdRegistered: boolean;
    namespace: string;
    namespaceExists: boolean;
    clusterVersion?: string;
  }> {
    let controllerInstalled = false;
    let controllerVersion: string | undefined;
    let crdRegistered = false;
    let namespaceExists = false;
    let clusterVersion: string | undefined;

    // Check cluster connectivity and version
    try {
      const versionApi = this.kubeConfig.makeApiClient(k8s.VersionApi);
      const versionInfo = await versionApi.getCode();
      clusterVersion = versionInfo.gitVersion;
    } catch {
      return {
        healthy: false,
        controllerInstalled: false,
        crdRegistered: false,
        namespace: this.namespace,
        namespaceExists: false,
      };
    }

    // Check if CRDs are registered (both core and extensions)
    try {
      const apiExtApi = this.kubeConfig.makeApiClient(k8s.ApiextensionsV1Api);
      await apiExtApi.readCustomResourceDefinition({
        name: `sandboxes.${CRD_API.group}`,
      });
      await apiExtApi.readCustomResourceDefinition({
        name: `sandboxtemplates.${CRD_EXTENSIONS_API.group}`,
      });
      crdRegistered = true;
    } catch {
      // CRD not registered
    }

    // Check namespace exists
    try {
      const coreApi = this.kubeConfig.makeApiClient(k8s.CoreV1Api);
      await coreApi.readNamespace({ name: this.namespace });
      namespaceExists = true;
    } catch {
      // Namespace doesn't exist
    }

    // Check controller deployment
    if (crdRegistered) {
      try {
        const appsApi = this.kubeConfig.makeApiClient(k8s.AppsV1Api);
        const deployments = await appsApi.listNamespacedDeployment({
          namespace: 'agent-sandbox-system',
          labelSelector: 'app.kubernetes.io/name=agent-sandbox-controller',
        });
        const firstDeployment = deployments.items[0];
        if (firstDeployment) {
          controllerInstalled = true;
          controllerVersion = firstDeployment.metadata?.labels?.['app.kubernetes.io/version'];
        }
      } catch {
        // Controller check failed, but CRD exists so it might be fine
      }
    }

    return {
      healthy: crdRegistered && namespaceExists,
      controllerInstalled,
      controllerVersion,
      crdRegistered,
      namespace: this.namespace,
      namespaceExists,
      clusterVersion,
    };
  }
}
