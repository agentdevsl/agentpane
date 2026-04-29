/**
 * Router Construction Phase
 *
 * Creates the Hono router with all service dependencies.
 */

import type { EventEmittingSandboxProvider } from '../../../lib/sandbox/providers/sandbox-provider.js';
import type { Database } from '../../../types/database.js';
import type { SandboxProviderHealth } from '../../router.js';
import { createRouter as createHonoRouter } from '../../router.js';
import type { ServiceContainer } from '../types.js';

/**
 * Create the Hono API router with all dependencies injected.
 */
export function createAppRouter(
  db: Database,
  services: ServiceContainer,
  getSandboxProvider: () => EventEmittingSandboxProvider | null,
  getK8sProvider: () => SandboxProviderHealth | null,
  getNomadProvider: () => SandboxProviderHealth | null,
  isSandboxReady?: () => boolean
) {
  return createHonoRouter({
    db,
    githubService: services.githubService,
    apiKeyService: services.apiKeyService,
    templateService: services.templateService,
    sandboxConfigService: services.sandboxConfigService,
    taskService: services.taskService,
    sessionService: services.sessionService,
    taskCreationService: services.taskCreationService,
    marketplaceService: services.marketplaceService,
    agentService: services.agentService,
    workflowService: services.workflowService,
    gitService: services.gitService,
    codespaceService: services.codespaceService,
    projectFolderService: services.projectFolderService,
    getSandboxProvider,
    getK8sProvider,
    getNomadProvider,
    isSandboxReady,
    cliMonitorService: services.cliMonitorService,
    terraformRegistryService: services.terraformRegistryService,
    terraformComposeService: services.terraformComposeService,
    settingsService: services.settingsService,
    eventSourceService: services.eventSourceService,
    eventSubscriptionService: services.eventSubscriptionService,
    eventProcessingService: services.eventProcessingService,
    schedulerService: services.schedulerService,
    memoryService: services.memoryService,
    skillTrackingService: services.skillTrackingService,
    dreamService: services.dreamService,
    durableStreamsService: services.durableStreamsService,
    // F01-04: pass through so `/api/admin/metrics/plan-mode` and `/api/metrics`
    // report real counters instead of the always-zero stub branch.
    planModeService: services.planModeService,
  });
}
