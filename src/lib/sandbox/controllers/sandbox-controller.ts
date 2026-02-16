import {
  type AgentSandboxClient,
  AlreadyExistsError,
  CRD_API,
  CRD_CONDITIONS,
  CRD_LABELS,
  CRD_PLURALS,
  NotFoundError,
  SandboxBuilder,
  type Sandbox as SandboxCRD,
  type SandboxTemplate,
  type SandboxWarmPool,
  type WatchEvent,
  type WatchHandle,
} from '@agentpane/agent-sandbox-sdk';
import * as k8s from '@kubernetes/client-node';

interface SandboxControllerOptions {
  /** Interval in ms for syncing pod status back to Sandbox CRD status. Default: 10000 */
  statusSyncIntervalMs?: number;
  /** Interval in ms for reconciling warm pools. Default: 30000 */
  warmPoolSyncIntervalMs?: number;
}

const DEFAULT_STATUS_SYNC_INTERVAL_MS = 10_000;
const DEFAULT_WARM_POOL_SYNC_INTERVAL_MS = 30_000;
const DEFAULT_SANDBOX_IMAGE = 'srlynch1/agent-sandbox:latest';

/**
 * CRD controller that watches Sandbox and WarmPool custom resources
 * and creates actual Kubernetes pods to fulfill them.
 *
 * Responsibilities:
 * - Watch Sandbox CRDs and create corresponding pods
 * - Sync pod status back to Sandbox CRD status subresource
 * - Reconcile WarmPool CRDs by creating/maintaining warm Sandbox instances
 * - Clean up via ownerReferences (pod deletion is handled by K8s GC)
 */
export class SandboxController {
  private readonly client: AgentSandboxClient;
  private readonly namespace: string;
  private readonly coreApi: k8s.CoreV1Api;
  private readonly customApi: k8s.CustomObjectsApi;
  private readonly statusSyncIntervalMs: number;
  private readonly warmPoolSyncIntervalMs: number;

  private running = false;
  private sandboxWatch: WatchHandle | null = null;
  private statusSyncTimer: ReturnType<typeof setInterval> | null = null;
  private warmPoolSyncTimer: ReturnType<typeof setInterval> | null = null;

  constructor(client: AgentSandboxClient, namespace: string, options?: SandboxControllerOptions) {
    this.client = client;
    this.namespace = namespace;
    this.statusSyncIntervalMs = options?.statusSyncIntervalMs ?? DEFAULT_STATUS_SYNC_INTERVAL_MS;
    this.warmPoolSyncIntervalMs =
      options?.warmPoolSyncIntervalMs ?? DEFAULT_WARM_POOL_SYNC_INTERVAL_MS;

    this.coreApi = client.kubeConfig.makeApiClient(k8s.CoreV1Api);
    this.customApi = client.kubeConfig.makeApiClient(k8s.CustomObjectsApi);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start the controller: begin watching Sandbox CRDs, start periodic
   * status sync and warm pool reconciliation, and reconcile any existing
   * Sandbox CRDs that were created while the controller was offline.
   */
  async start(): Promise<void> {
    this.running = true;

    // Start watching sandbox CRD events
    this.sandboxWatch = this.client.watchSandboxes((event) => this.onSandboxEvent(event), {
      namespace: this.namespace,
    });

    // Periodic status sync: push pod status into Sandbox CRD status
    this.statusSyncTimer = setInterval(() => {
      this.syncPodStatus().catch((err) => {
        console.error('[SandboxController] Status sync error:', err);
      });
    }, this.statusSyncIntervalMs);

    // Periodic warm pool reconciliation
    this.warmPoolSyncTimer = setInterval(() => {
      this.reconcileWarmPools().catch((err) => {
        console.error('[SandboxController] Warm pool reconciliation error:', err);
      });
    }, this.warmPoolSyncIntervalMs);

    // Reconcile anything already in the cluster
    await this.reconcileExisting();

    console.log('[SandboxController] Started');
  }

  /**
   * Stop the controller gracefully: stop the watch and clear intervals.
   */
  stop(): void {
    if (this.sandboxWatch) {
      this.sandboxWatch.stop();
      this.sandboxWatch = null;
    }

    if (this.statusSyncTimer) {
      clearInterval(this.statusSyncTimer);
      this.statusSyncTimer = null;
    }

    if (this.warmPoolSyncTimer) {
      clearInterval(this.warmPoolSyncTimer);
      this.warmPoolSyncTimer = null;
    }

    this.running = false;
    console.log('[SandboxController] Stopped');
  }

  // ---------------------------------------------------------------------------
  // Watch event handler
  // ---------------------------------------------------------------------------

  private onSandboxEvent(event: WatchEvent<SandboxCRD>): void {
    try {
      switch (event.type) {
        case 'ADDED':
        case 'MODIFIED':
          this.reconcileSandbox(event.object).catch((err) => {
            console.error(
              `[SandboxController] Failed to reconcile sandbox ${event.object.metadata?.name}:`,
              err
            );
          });
          break;

        case 'DELETED':
          // No-op: ownerReferences on the pod ensure K8s garbage-collects
          // the pod when the Sandbox CRD is deleted.
          break;

        case 'ERROR':
          console.warn('[SandboxController] Watch ERROR event:', event.object);
          break;

        default:
          // BOOKMARK or unknown — ignore
          break;
      }
    } catch (err) {
      console.error('[SandboxController] Unexpected error handling watch event:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Sandbox reconciliation
  // ---------------------------------------------------------------------------

  /**
   * Ensure a pod exists for the given Sandbox CRD. If the pod already exists
   * this is a no-op. Otherwise, resolve the template (if referenced), build
   * a pod spec, create the pod, and update the Sandbox status to Pending.
   */
  private async reconcileSandbox(sandbox: SandboxCRD): Promise<void> {
    const sandboxName = sandbox.metadata?.name;
    if (!sandboxName) {
      console.warn('[SandboxController] Sandbox has no metadata.name, skipping');
      return;
    }

    // Check if the pod already exists
    try {
      await this.coreApi.readNamespacedPod({ name: sandboxName, namespace: this.namespace });
      // Pod already exists — nothing to do
      return;
    } catch (err) {
      // 404 is expected (pod doesn't exist yet). Any other error is unexpected.
      if (!this.isNotFoundError(err)) {
        console.error(
          `[SandboxController] Unexpected error checking pod ${sandboxName}:`,
          err instanceof Error ? err.message : String(err)
        );
        return;
      }
    }

    // Resolve template if the sandbox references one
    let template: SandboxTemplate | undefined;
    if (sandbox.spec?.sandboxTemplateRef?.name) {
      try {
        template = await this.client.getTemplate(sandbox.spec.sandboxTemplateRef.name);
      } catch (err) {
        console.error(
          `[SandboxController] Failed to resolve template ${sandbox.spec.sandboxTemplateRef.name}:`,
          err
        );
        await this.patchSandboxStatus(sandboxName, {
          phase: 'Failed',
          conditions: [
            {
              type: CRD_CONDITIONS.ready,
              status: 'False',
              reason: 'TemplateNotFound',
              message: `Template ${sandbox.spec.sandboxTemplateRef.name} not found`,
              lastTransitionTime: new Date(),
            },
          ],
        });
        return;
      }
    }

    // Build and create the pod
    const pod = this.buildPodFromSandbox(sandbox, template);

    try {
      await this.coreApi.createNamespacedPod({ namespace: this.namespace, body: pod });
    } catch (err) {
      // 409 Conflict means the pod already exists (race condition) — that's fine
      if (this.isConflictError(err)) {
        return;
      }
      console.error(`[SandboxController] Failed to create pod for sandbox ${sandboxName}:`, err);
      await this.patchSandboxStatus(sandboxName, {
        phase: 'Failed',
        conditions: [
          {
            type: CRD_CONDITIONS.ready,
            status: 'False',
            reason: 'PodCreationFailed',
            message: err instanceof Error ? err.message : String(err),
            lastTransitionTime: new Date(),
          },
        ],
      });
      return;
    }

    // Update sandbox status to reflect that we've created the pod
    await this.patchSandboxStatus(sandboxName, {
      phase: 'Pending',
      podName: sandboxName,
    });

    console.log(`[SandboxController] Created pod for sandbox ${sandboxName}`);
  }

  // ---------------------------------------------------------------------------
  // Pod builder
  // ---------------------------------------------------------------------------

  /**
   * Build a V1Pod from a Sandbox CRD, optionally merging in a SandboxTemplate.
   * Sets ownerReferences so that deleting the Sandbox CRD cascades to the pod.
   */
  private buildPodFromSandbox(sandbox: SandboxCRD, template?: SandboxTemplate): k8s.V1Pod {
    const sandboxName = sandbox.metadata?.name ?? '';

    // Determine pod template spec: prefer template if provided, fall back to inline
    const podTemplateSpec = template?.spec?.podTemplateSpec ?? sandbox.spec?.podTemplateSpec;

    // Extract containers from the template, or build a default
    let containers: k8s.V1Container[];
    let volumes: k8s.V1Volume[] | undefined;
    let serviceAccountName: string | undefined;

    if (podTemplateSpec?.spec) {
      containers = podTemplateSpec.spec.containers?.length
        ? podTemplateSpec.spec.containers.map((c) =>
            this.ensureSecurityContext({
              ...c,
              // Ensure the container has a keep-alive command if none specified
              command: c.command?.length ? c.command : ['tail', '-f', '/dev/null'],
            })
          )
        : [this.defaultContainer()];
      volumes = podTemplateSpec.spec.volumes;
      serviceAccountName = podTemplateSpec.spec.serviceAccountName;
    } else {
      containers = [this.defaultContainer()];
    }

    // Merge labels: sandbox CRD labels + controller-managed labels
    const labels: Record<string, string> = {
      ...(sandbox.metadata?.labels ?? {}),
      'app.kubernetes.io/managed-by': 'agentpane-controller',
      [CRD_LABELS.sandbox]: sandboxName,
    };

    // Owner reference for garbage collection
    const ownerReferences: k8s.V1OwnerReference[] = [
      {
        apiVersion: CRD_API.apiVersion,
        kind: 'Sandbox',
        name: sandboxName,
        uid: sandbox.metadata?.uid ?? '',
        controller: true,
        blockOwnerDeletion: true,
      },
    ];

    // Resolve runtime class name
    const runtimeClassName = this.resolveRuntimeClassName(
      sandbox.spec?.runtimeClassName,
      template?.spec?.runtimeClassName
    );

    const pod: k8s.V1Pod = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: sandboxName,
        namespace: this.namespace,
        labels,
        ownerReferences,
      },
      spec: {
        restartPolicy: 'Never',
        containers,
        volumes,
        serviceAccountName,
        ...(runtimeClassName ? { runtimeClassName } : {}),
        // Pod-level security context for restricted PSS compliance
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          runAsGroup: 1000,
          fsGroup: 1000,
          seccompProfile: { type: 'RuntimeDefault' },
        },
      },
    };

    return pod;
  }

  /**
   * Build the default sandbox container when no template is provided.
   */
  private defaultContainer(): k8s.V1Container {
    return this.ensureSecurityContext({
      name: 'sandbox',
      image: DEFAULT_SANDBOX_IMAGE,
      command: ['tail', '-f', '/dev/null'],
    });
  }

  /**
   * Ensure a container has a security context compatible with the
   * "restricted" Pod Security Standard (PSS). Required fields:
   * - allowPrivilegeEscalation: false
   * - capabilities.drop: ["ALL"]
   * - runAsNonRoot: true
   * - seccompProfile.type: "RuntimeDefault"
   */
  private ensureSecurityContext(container: k8s.V1Container): k8s.V1Container {
    return {
      ...container,
      securityContext: {
        ...container.securityContext,
        allowPrivilegeEscalation: false,
        runAsNonRoot: true,
        capabilities: {
          drop: ['ALL'],
          ...container.securityContext?.capabilities,
        },
        seccompProfile: container.securityContext?.seccompProfile ?? {
          type: 'RuntimeDefault',
        },
      },
    };
  }

  /**
   * Resolve the runtime class name. Returns undefined if the value is 'none',
   * empty, or not provided — this ensures minikube compatibility where setting
   * runtimeClassName to a non-existent class would fail pod scheduling.
   */
  private resolveRuntimeClassName(
    sandboxValue?: string,
    templateValue?: string
  ): string | undefined {
    const value = sandboxValue ?? templateValue;
    if (!value || value === 'none' || value.trim() === '') {
      return undefined;
    }
    return value;
  }

  // ---------------------------------------------------------------------------
  // Status sync
  // ---------------------------------------------------------------------------

  /**
   * List all pods managed by this controller and sync their status back
   * to the corresponding Sandbox CRD status subresource.
   */
  private async syncPodStatus(): Promise<void> {
    if (!this.running) return;

    let pods: k8s.V1Pod[];
    try {
      const response = await this.coreApi.listNamespacedPod({
        namespace: this.namespace,
        labelSelector: 'app.kubernetes.io/managed-by=agentpane-controller',
      });
      pods = response.items;
    } catch (err) {
      console.error('[SandboxController] Failed to list pods for status sync:', err);
      return;
    }

    for (const pod of pods) {
      try {
        const sandboxName = pod.metadata?.labels?.[CRD_LABELS.sandbox];
        if (!sandboxName) continue;

        const podPhase = pod.status?.phase;
        const podIP = pod.status?.podIP;
        const podName = pod.metadata?.name;

        // Determine whether all containers are ready
        const allContainersReady =
          pod.status?.containerStatuses?.every((cs) => cs.ready === true) ?? false;

        // Map pod phase to sandbox phase
        let sandboxPhase: string;
        if (podPhase === 'Running' && allContainersReady) {
          sandboxPhase = 'Running';
        } else if (podPhase === 'Pending') {
          sandboxPhase = 'Pending';
        } else if (podPhase === 'Failed' || podPhase === 'Unknown') {
          sandboxPhase = 'Failed';
        } else if (podPhase === 'Succeeded') {
          sandboxPhase = 'Succeeded';
        } else {
          // Running but not all containers ready yet
          sandboxPhase = 'Pending';
        }

        // Build ready condition
        const readyCondition: k8s.V1Condition = {
          type: CRD_CONDITIONS.ready,
          status: sandboxPhase === 'Running' ? 'True' : 'False',
          reason: sandboxPhase === 'Running' ? 'PodReady' : 'PodNotReady',
          message:
            sandboxPhase === 'Running'
              ? 'Pod is running and all containers are ready'
              : `Pod phase: ${podPhase ?? 'Unknown'}`,
          lastTransitionTime: new Date(),
        };

        const podReadyCondition: k8s.V1Condition = {
          type: CRD_CONDITIONS.podReady,
          status: allContainersReady ? 'True' : 'False',
          reason: allContainersReady ? 'ContainersReady' : 'ContainersNotReady',
          message: allContainersReady
            ? 'All containers are ready'
            : `${pod.status?.containerStatuses?.filter((cs) => !cs.ready).length ?? 0} container(s) not ready`,
          lastTransitionTime: new Date(),
        };

        const readyReplicas = sandboxPhase === 'Running' ? 1 : 0;
        const readyAt = sandboxPhase === 'Running' ? new Date().toISOString() : undefined;

        await this.patchSandboxStatus(sandboxName, {
          phase: sandboxPhase,
          podName,
          podIP,
          conditions: [readyCondition, podReadyCondition],
          readyReplicas,
          ...(readyAt ? { readyAt } : {}),
        });
      } catch (err) {
        console.error(
          `[SandboxController] Failed to sync status for pod ${pod.metadata?.name}:`,
          err
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Existing sandbox reconciliation
  // ---------------------------------------------------------------------------

  /**
   * On startup, reconcile all existing Sandbox CRDs to ensure pods exist
   * for any that were created while the controller was offline.
   */
  private async reconcileExisting(): Promise<void> {
    try {
      const sandboxList = await this.client.listSandboxes({ namespace: this.namespace });
      console.log(
        `[SandboxController] Reconciling ${sandboxList.items.length} existing sandbox(es)`
      );
      for (const sandbox of sandboxList.items) {
        await this.reconcileSandbox(sandbox);
      }
    } catch (err) {
      console.error('[SandboxController] Failed to reconcile existing sandboxes:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Warm pool reconciliation
  // ---------------------------------------------------------------------------

  /**
   * Reconcile all WarmPool CRDs: ensure the desired number of warm Sandbox
   * instances exist and are in a running state. Creates new Sandbox CRDs
   * (which the watch handler will turn into pods) to fill any deficit.
   */
  private async reconcileWarmPools(): Promise<void> {
    if (!this.running) return;

    let warmPools: SandboxWarmPool[];
    try {
      const poolList = await this.client.listWarmPools(this.namespace);
      warmPools = poolList.items;
    } catch (err) {
      console.error('[SandboxController] Failed to list warm pools:', err);
      return;
    }

    for (const pool of warmPools) {
      try {
        const poolName = pool.metadata?.name;
        if (!poolName) continue;

        const templateName = pool.spec?.templateRef?.name;
        if (!templateName) {
          console.warn(`[SandboxController] Warm pool ${poolName} has no templateRef, skipping`);
          continue;
        }

        const desiredReady = pool.spec?.desiredReady ?? 0;

        // List existing warm sandboxes for this pool
        const existingSandboxes = await this.client.listSandboxes({
          labelSelector: `${CRD_LABELS.warmPool}=${poolName}`,
          namespace: this.namespace,
        });

        // Count how many are currently in Running phase
        const currentReady = existingSandboxes.items.filter(
          (s) => s.status?.phase === 'Running'
        ).length;

        // Calculate deficit
        const deficit = desiredReady - currentReady;

        if (deficit > 0) {
          console.log(
            `[SandboxController] Warm pool ${poolName}: ${currentReady}/${desiredReady} ready, creating ${deficit} sandbox(es)`
          );

          for (let i = 0; i < deficit; i++) {
            const randomSuffix = this.randomString(8);
            const warmSandboxName = `warm-${poolName}-${randomSuffix}`;

            const builder = new SandboxBuilder(warmSandboxName)
              .namespace(this.namespace)
              .labels({
                [CRD_LABELS.warmPool]: poolName,
                [CRD_LABELS.warmPoolState]: 'warming',
              })
              .fromTemplate(templateName, pool.spec?.templateRef?.namespace);

            try {
              await this.client.createSandbox(builder.build());
              console.log(
                `[SandboxController] Created warm sandbox ${warmSandboxName} for pool ${poolName}`
              );
            } catch (err) {
              if (err instanceof AlreadyExistsError) {
                // Name collision (unlikely with random suffix) — skip
                continue;
              }
              console.error(
                `[SandboxController] Failed to create warm sandbox ${warmSandboxName}:`,
                err
              );
            }
          }
        }

        // Update warm pool status with current ready count
        await this.patchWarmPoolStatus(poolName, { readyReplicas: currentReady });
      } catch (err) {
        console.error(
          `[SandboxController] Failed to reconcile warm pool ${pool.metadata?.name}:`,
          err
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Status patching
  // ---------------------------------------------------------------------------

  /**
   * Patch the status subresource of a Sandbox CRD using merge-patch.
   *
   * @kubernetes/client-node v1.4.0 uses positional params:
   * patchNamespacedCustomObjectStatus(group, version, namespace, plural, name,
   *   body, dryRun, fieldManager, fieldValidation, force, _options)
   */
  private async patchSandboxStatus(name: string, status: object): Promise<void> {
    try {
      // Use GET + PUT (replace) instead of PATCH to avoid content-type issues.
      // The k8s client's patch method requires specific Content-Type headers
      // that are difficult to set through the typed API.
      const current = await this.customApi.getNamespacedCustomObjectStatus({
        group: CRD_API.group,
        version: CRD_API.version,
        namespace: this.namespace,
        plural: CRD_PLURALS.sandbox,
        name,
      });

      const updated = { ...(current as Record<string, unknown>), status };
      await this.customApi.replaceNamespacedCustomObjectStatus({
        group: CRD_API.group,
        version: CRD_API.version,
        namespace: this.namespace,
        plural: CRD_PLURALS.sandbox,
        name,
        body: updated,
      });
    } catch (err) {
      console.error(
        `[SandboxController] Failed to patch sandbox status for ${name}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  /**
   * Update the status subresource of a SandboxWarmPool CRD.
   */
  private async patchWarmPoolStatus(name: string, status: object): Promise<void> {
    try {
      const current = await this.customApi.getNamespacedCustomObjectStatus({
        group: CRD_API.group,
        version: CRD_API.version,
        namespace: this.namespace,
        plural: CRD_PLURALS.sandboxWarmPool,
        name,
      });

      const updated = { ...(current as Record<string, unknown>), status };
      await this.customApi.replaceNamespacedCustomObjectStatus({
        group: CRD_API.group,
        version: CRD_API.version,
        namespace: this.namespace,
        plural: CRD_PLURALS.sandboxWarmPool,
        name,
        body: updated,
      });
    } catch (err) {
      console.error(
        `[SandboxController] Failed to patch warm pool status for ${name}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Extract the HTTP status code from a k8s client-node error.
   *
   * @kubernetes/client-node v1.4.0 HttpError format:
   * - message: "HTTP-Code: 404\nMessage: Unknown API Status Code!\nBody: {...}"
   * - body: '{"kind":"Status","code":404,"reason":"NotFound",...}'
   * - statusCode: may or may not be present
   * - response.statusCode: may be present in older versions
   */
  private getHttpStatusCode(err: unknown): number | undefined {
    if (typeof err !== 'object' || err === null) return undefined;
    const obj = err as Record<string, unknown>;

    // Direct statusCode property
    if (typeof obj.statusCode === 'number') return obj.statusCode;

    // body.code (k8s Status response parsed)
    if (typeof obj.body === 'string') {
      try {
        const body = JSON.parse(obj.body) as Record<string, unknown>;
        if (typeof body.code === 'number') return body.code;
      } catch {
        // Not JSON
      }
    }
    if (typeof obj.body === 'object' && obj.body !== null) {
      const body = obj.body as Record<string, unknown>;
      if (typeof body.code === 'number') return body.code;
    }

    // message contains "HTTP-Code: NNN"
    if (err instanceof Error) {
      const match = err.message.match(/HTTP-Code:\s*(\d+)/);
      if (match?.[1]) return parseInt(match[1], 10);
    }

    // response.statusCode (older k8s client format)
    if ('response' in obj && typeof obj.response === 'object' && obj.response !== null) {
      const resp = obj.response as Record<string, unknown>;
      if (typeof resp.statusCode === 'number') return resp.statusCode;
    }

    return undefined;
  }

  /**
   * Check if a K8s API error is a 404 Not Found.
   */
  private isNotFoundError(err: unknown): boolean {
    if (err instanceof NotFoundError) return true;
    return this.getHttpStatusCode(err) === 404;
  }

  /**
   * Check if a K8s API error is a 409 Conflict (AlreadyExists).
   */
  private isConflictError(err: unknown): boolean {
    if (err instanceof AlreadyExistsError) return true;
    return this.getHttpStatusCode(err) === 409;
  }

  /**
   * Generate a random lowercase alphanumeric string of the given length.
   */
  private randomString(length: number): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }
}
