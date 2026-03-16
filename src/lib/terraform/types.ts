import type { TerraformOutput, TerraformVariable } from '../../db/schema';

/** Compose mode — standard Terraform HCL or Terraform Stacks multi-file output */
export type ComposeMode = 'terraform' | 'stacks';

/** A single generated file in multi-file (Stacks) output */
export interface GeneratedFile {
  filename: string;
  code: string;
}

/** Provider color classes shared across UI components */
export const PROVIDER_COLORS: Record<string, string> = {
  aws: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  azure: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  azurerm: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  google: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  gcp: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
};

/** A clarifying question posed by the AI during composition */
export interface ClarifyingQuestion {
  category: string;
  question: string;
  options: string[];
}

/** Message in a compose conversation */
export interface ComposeMessage {
  role: 'user' | 'assistant';
  content: string;
  modules?: ModuleMatch[];
  clarifyingQuestions?: ClarifyingQuestion[];
  successBanner?: { moduleCount: number; variableCount: number; outputCount: number };
}

/** A saved composition entry for history */
export interface CompositionEntry {
  id: string;
  title: string;
  timestamp: number;
  moduleCount: number;
  status: 'completed' | 'in_progress' | 'failed';
  messages?: ComposeMessage[];
}

/** A matched module from AI composition */
export interface ModuleMatch {
  moduleId: string;
  name: string;
  provider: string;
  version: string;
  source: string;
  confidence: number;
  matchReason: string;
}

/** Compose pipeline stage identifiers */
export type ComposeStage =
  | 'loading_catalog'
  | 'analyzing'
  | 'matching_modules'
  | 'generating_code'
  | 'validating_hcl'
  | 'finalizing';

/** Human-readable labels for each compose stage */
export const COMPOSE_STAGE_LABELS: Record<ComposeStage, string> = {
  loading_catalog: 'Loading module catalog…',
  analyzing: 'Analyzing requirements…',
  matching_modules: 'Matching modules…',
  generating_code: 'Generating Terraform code…',
  validating_hcl: 'Validating HCL…',
  finalizing: 'Finalizing configuration…',
};

/** SSE event protocol — discriminated union for compose streaming */
export type ComposeEvent =
  | { type: 'status'; stage: ComposeStage }
  | { type: 'text'; content: string }
  | { type: 'modules'; modules: ModuleMatch[] }
  | { type: 'code'; code: string; files?: GeneratedFile[] }
  | { type: 'questions'; questions: ClarifyingQuestion[] }
  | {
      type: 'done';
      sessionId: string;
      matchedModules?: ModuleMatch[];
      generatedCode?: string;
      generatedFiles?: GeneratedFile[];
      usage: { inputTokens: number; outputTokens: number };
    }
  | { type: 'error'; error: string };

/** Frontend registry shape (omits server-only fields like tokenSettingKey) */
export interface TerraformRegistryView {
  id: string;
  name: string;
  orgName: string;
  hasToken: boolean;
  status: 'active' | 'syncing' | 'error';
  lastSyncedAt: string | null;
  syncError: string | null;
  moduleCount: number;
  syncIntervalMinutes: number | null;
  nextSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Frontend module shape */
export interface TerraformModuleView {
  id: string;
  registryId: string;
  name: string;
  namespace: string;
  provider: string;
  version: string;
  source: string;
  description: string | null;
  readme?: string | null;
  inputs: TerraformVariable[] | null;
  outputs: TerraformOutput[] | null;
  dependencies: string[] | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
