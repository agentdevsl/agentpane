import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type CanUseTool, unstable_v2_createSession } from '@anthropic-ai/claude-agent-sdk';
import { createId } from '@paralleldrive/cuid2';
import type { TerraformModule } from '../db/schema';
import { buildSdkEnv } from '../lib/agents/agent-sdk-utils.js';
import { DEFAULT_AGENT_MODEL, getFullModelId } from '../lib/constants/models.js';
import type { TerraformError } from '../lib/errors/terraform-errors.js';
import { createLogger } from '../lib/logging/logger.js';
import { buildCompositionSystemPrompt } from '../lib/terraform/compose-prompt.js';
import type {
  ClarifyingQuestion,
  ComposeMessage,
  ComposeMode,
  ComposeStage,
  GeneratedFile,
  ModuleMatch,
} from '../lib/terraform/types.js';
import type { Result } from '../lib/utils/result.js';
import { ok } from '../lib/utils/result.js';
import type { Database } from '../types/database.js';
import type { DurableStreamsService } from './durable-streams.service.js';
import { getGlobalDefaultModel, type SettingsService } from './settings.service.js';
import type { TerraformRegistryService } from './terraform-registry.service.js';

const log = createLogger('TerraformCompose');

let cachedSkillContent: string | null = null;

/** Load the Terraform Stacks SKILL.md content, caching in memory after first read. */
async function loadStacksSkillContent(): Promise<string> {
  if (cachedSkillContent) return cachedSkillContent;
  const skillPath = resolve(process.cwd(), '.claude/skills/terraform-stacks/SKILL.md');
  try {
    const content = await readFile(skillPath, 'utf-8');
    cachedSkillContent = content;
    return content;
  } catch (err) {
    log.warn('Failed to load Stacks SKILL.md, continuing without reference', {
      data: { skillPath },
      error: err,
    });
    return '';
  }
}

const MAX_SESSIONS = 100;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

export interface ComposeSession {
  id: string;
  messages: ComposeMessage[];
  matchedModules: ModuleMatch[];
  generatedCode: string | null;
  lastAccessedAt: number;
}

/** Shape of the raw stream event from the Agent SDK. */
interface AgentStreamEvent {
  type: string;
  delta?: { type: string; text?: string };
  message?: { model?: string; usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Shape of a raw assistant message from the Agent SDK. */
interface AgentAssistantMessage {
  message?: {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
}

export class TerraformComposeService {
  private sessions = new Map<string, ComposeSession>();

  constructor(
    private registryService: TerraformRegistryService,
    private db: Database,
    private settingsService?: SettingsService,
    private durableStreamsService?: DurableStreamsService
  ) {}

  private cleanupSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastAccessedAt > SESSION_TTL_MS) {
        this.sessions.delete(id);
      }
    }
    // Evict oldest if over max
    if (this.sessions.size > MAX_SESSIONS) {
      const sorted = [...this.sessions.entries()].sort(
        (a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt
      );
      const toRemove = sorted.slice(0, this.sessions.size - MAX_SESSIONS);
      for (const [id] of toRemove) {
        this.sessions.delete(id);
      }
    }
  }

  /**
   * Start a compose job in the background and return the session ID immediately.
   * The client subscribes to Caddy durable streams at /v1/stream/terraform/{jobId}.
   */
  async startCompose(
    sessionId: string | undefined,
    messages: ComposeMessage[],
    registryId?: string,
    composeMode: ComposeMode = 'terraform'
  ): Promise<Result<{ sessionId: string }, TerraformError>> {
    const sid = sessionId || createId();

    this.cleanupSessions();

    // Run pipeline without awaiting — the caller returns the session ID immediately.
    this.runPipeline(sid, messages, registryId, composeMode).catch(async (pipelineErr) => {
      log.error('Unhandled pipeline error', { error: pipelineErr });
      try {
        await this.publishEvent(sid, 'terraform:error', {
          jobId: sid,
          error: 'An unexpected error occurred. Please try again.',
        });
      } catch (publishErr) {
        log.error('Failed to publish pipeline error event', { error: publishErr });
      }
    });

    return ok({ sessionId: sid });
  }

  /**
   * Publish a typed event to the Caddy durable stream for a compose job.
   * Falls back to logging if no DurableStreamsService is configured.
   */
  private async publishEvent<
    T extends
      | 'terraform:status'
      | 'terraform:text'
      | 'terraform:modules'
      | 'terraform:questions'
      | 'terraform:code'
      | 'terraform:done'
      | 'terraform:error',
  >(
    jobId: string,
    type: T,
    data: T extends 'terraform:status'
      ? { jobId: string; stage: ComposeStage; message?: string }
      : T extends 'terraform:text'
        ? { jobId: string; delta: string; accumulated?: string }
        : T extends 'terraform:modules'
          ? { jobId: string; modules: ModuleMatch[] }
          : T extends 'terraform:questions'
            ? { jobId: string; questions: ClarifyingQuestion[] }
            : T extends 'terraform:code'
              ? { jobId: string; code: string; files?: GeneratedFile[] }
              : T extends 'terraform:done'
                ? {
                    jobId: string;
                    generatedCode?: string;
                    matchedModules?: ModuleMatch[];
                    validationResult?: unknown;
                    generatedFiles?: GeneratedFile[];
                    usage?: { inputTokens: number; outputTokens: number };
                  }
                : T extends 'terraform:error'
                  ? { jobId: string; error: string; code?: string }
                  : never
  ): Promise<void> {
    if (!this.durableStreamsService) {
      log.error('No DurableStreamsService configured — events will be lost', {
        data: { type, jobId },
      });
      throw new Error('[TerraformCompose] DurableStreamsService is required for event delivery');
    }
    const streamId = `terraform:${jobId}`;
    try {
      await this.durableStreamsService.publish(streamId, type, data as never);
    } catch (err) {
      log.error('Failed to publish terraform event', { data: { type, jobId }, error: err });
    }
  }

  private async runPipeline(
    sid: string,
    messages: ComposeMessage[],
    registryId: string | undefined,
    composeMode: ComposeMode
  ): Promise<void> {
    // Create the durable stream so Caddy can buffer events for subscribers
    const streamId = `terraform:${sid}`;
    if (this.durableStreamsService) {
      try {
        await this.durableStreamsService.createStream(streamId, null);
      } catch (err) {
        log.error('Failed to create durable stream for compose job', {
          data: { streamId },
          error: err,
        });
        // Abort pipeline — without a stream, the client will never receive events
        try {
          await this.durableStreamsService.publish(streamId, 'terraform:error', {
            jobId: sid,
            error: 'Failed to initialize streaming. Please try again.',
          } as never);
        } catch {
          // Best-effort error delivery
        }
        return;
      }
    }

    let session: ReturnType<typeof unstable_v2_createSession> | null = null;

    try {
      // Stage 1: Load module catalog
      await this.publishEvent(sid, 'terraform:status', { jobId: sid, stage: 'loading_catalog' });

      const contextResult = await this.registryService.getModuleContext(registryId);
      if (!contextResult.ok) {
        await this.publishEvent(sid, 'terraform:error', {
          jobId: sid,
          error: contextResult.error.message ?? 'Failed to load module catalog',
        });
        return;
      }

      // Load stacks reference content if in stacks mode (server-only file read)
      const stacksReference = composeMode === 'stacks' ? await loadStacksSkillContent() : undefined;

      const systemPrompt = await buildCompositionSystemPrompt(
        contextResult.value,
        this.settingsService,
        composeMode,
        stacksReference
      );

      const modulesResult = await this.registryService.listModules(
        registryId ? { registryId } : undefined
      );
      if (!modulesResult.ok) {
        log.error('Failed to load modules for matching', { error: modulesResult.error });
        await this.publishEvent(sid, 'terraform:text', {
          jobId: sid,
          delta:
            '\n\n> Warning: Could not load module catalog for matching. Module suggestions may be incomplete.\n\n',
        });
      }
      const allModules = modulesResult.ok ? modulesResult.value : [];

      // Stage 2: Analyzing requirements (streaming with Agent SDK)
      await this.publishEvent(sid, 'terraform:status', { jobId: sid, stage: 'analyzing' });

      const prompt = formatPrompt(systemPrompt, messages);
      // Model cascade: TERRAFORM_COMPOSE_MODEL env → global default_model setting → hardcoded default
      const globalDefault = await getGlobalDefaultModel(this.db);
      const composeModel = getFullModelId(
        process.env.TERRAFORM_COMPOSE_MODEL ?? globalDefault ?? DEFAULT_AGENT_MODEL
      );

      // Capture AskUserQuestion tool calls so we can forward questions to the client
      let capturedQuestions: Array<{
        question: string;
        header?: string;
        options: Array<{ label: string; description?: string }>;
      }> = [];

      const canUseTool: CanUseTool = async (_toolName, input, toolOptions) => {
        if (_toolName === 'AskUserQuestion') {
          const askInput = input as {
            questions?: Array<{
              question: string;
              header?: string;
              options: Array<{ label: string; description?: string }>;
            }>;
          };
          if (askInput?.questions) {
            capturedQuestions = askInput.questions.map((q) => ({
              question: q.question,
              header: q.header,
              options: q.options,
            }));
          }
        }
        return { behavior: 'allow' as const, toolUseID: toolOptions.toolUseID };
      };

      session = unstable_v2_createSession({
        model: composeModel,
        env: buildSdkEnv(),
        canUseTool,
      });

      await session.send(prompt);

      let fullResponse = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let streamedTextToClient = false;

      for await (const msg of session.stream()) {
        if (msg.type === 'stream_event') {
          const event = msg.event as AgentStreamEvent;

          // Capture usage from message_start
          if (event.type === 'message_start' && event.message?.usage) {
            inputTokens = event.message.usage.input_tokens ?? 0;
          }

          // Capture output token usage from message_delta
          if (event.type === 'message_delta' && event.usage) {
            outputTokens = event.usage.output_tokens ?? 0;
          }

          // Stream text deltas to the client as they arrive
          if (
            event.type === 'content_block_delta' &&
            event.delta?.type === 'text_delta' &&
            event.delta.text
          ) {
            fullResponse += event.delta.text;
            await this.publishEvent(sid, 'terraform:text', {
              jobId: sid,
              delta: event.delta.text,
            });
            streamedTextToClient = true;
          }
        }

        // Handle tool_use_summary — detect AskUserQuestion completions
        if (msg.type === 'tool_use_summary') {
          const toolSummary = msg as { tool_name?: string; tool_input?: Record<string, unknown> };
          if (toolSummary.tool_name === 'AskUserQuestion' && capturedQuestions.length > 0) {
            const questions = capturedQuestions.map((q) => ({
              category: q.header ?? 'General',
              question: q.question,
              options: q.options.map((o) => o.label),
            }));
            await this.publishEvent(sid, 'terraform:questions', { jobId: sid, questions });
            capturedQuestions = [];
          }
        }

        // Handle complete assistant messages (fallback when stream_event deltas aren't available)
        if (msg.type === 'assistant') {
          const { message } = msg as AgentAssistantMessage;
          if (message?.usage) {
            inputTokens = message.usage.input_tokens ?? inputTokens;
            outputTokens = message.usage.output_tokens ?? outputTokens;
          }
          if (message?.content) {
            const text = message.content
              .filter((b) => b.type === 'text' && b.text)
              .map((b) => b.text)
              .join('');
            // Only use assistant message content when stream deltas weren't available,
            // otherwise the overwrite can lose HCL code accumulated from deltas
            if (text && !streamedTextToClient) fullResponse = text;
          }
        }

        // Handle result with usage
        if (msg.type === 'result') {
          const result = msg as { usage?: { input_tokens?: number; output_tokens?: number } };
          if (result.usage) {
            inputTokens = result.usage.input_tokens ?? inputTokens;
            outputTokens = result.usage.output_tokens ?? outputTokens;
          }
        }
      }

      // If text was captured via assistant message but not streamed as deltas,
      // send the full response as a single text event so the client can render it
      if (fullResponse && !streamedTextToClient) {
        await this.publishEvent(sid, 'terraform:text', {
          jobId: sid,
          delta: fullResponse,
        });
      }

      // Stage 3: Match modules
      await this.publishEvent(sid, 'terraform:status', { jobId: sid, stage: 'matching_modules' });

      const matchedModules = matchModulesInResponse(fullResponse, allModules);

      if (matchedModules.length > 0) {
        await this.publishEvent(sid, 'terraform:modules', { jobId: sid, modules: matchedModules });
      }

      // Stage 4: Extract code
      await this.publishEvent(sid, 'terraform:status', { jobId: sid, stage: 'generating_code' });

      let generatedCode: string | null = null;
      let generatedFiles: GeneratedFile[] | undefined;

      if (composeMode === 'stacks') {
        const stacksFiles = extractStacksFiles(fullResponse);
        if (stacksFiles.length > 0) {
          generatedFiles = stacksFiles;
          generatedCode = stacksFiles.map((f) => f.code).join('\n\n');
          await this.publishEvent(sid, 'terraform:code', {
            jobId: sid,
            code: generatedCode,
            files: generatedFiles,
          });
        } else if (fullResponse) {
          log.warn('Stacks mode produced no files from non-empty response', {
            data: { responseLength: fullResponse.length },
          });
        }
      } else {
        generatedCode = extractHclCode(fullResponse);
        if (generatedCode) {
          await this.publishEvent(sid, 'terraform:code', { jobId: sid, code: generatedCode });
        }
      }

      // Fallback: parse clarifying questions from assistant text if AskUserQuestion
      // tool was not used (model wrote questions as plain text instead)
      if (!generatedCode && fullResponse) {
        const textQuestions = parseClarifyingQuestionsFromText(fullResponse);
        if (textQuestions.length > 0) {
          await this.publishEvent(sid, 'terraform:questions', {
            jobId: sid,
            questions: textQuestions,
          });
        }
      }

      // Stage 5: Validate HCL (skip for stacks — the parser only understands standard Terraform)
      if (generatedCode && composeMode !== 'stacks') {
        await this.publishEvent(sid, 'terraform:status', { jobId: sid, stage: 'validating_hcl' });
        const validation = await this.validateCode(generatedCode);
        if (!validation.valid) {
          log.warn('HCL validation warnings', {
            data: { diagnostics: validation.diagnostics.map((d) => d.summary) },
          });
          // Send validation diagnostics to the client so the UI can display warnings
          const diagnosticText = validation.diagnostics
            .map((d) => `- ${d.severity}: ${d.summary}${d.detail ? ` (${d.detail})` : ''}`)
            .join('\n');
          await this.publishEvent(sid, 'terraform:text', {
            jobId: sid,
            delta: `\n\n> HCL Validation Issues:\n${diagnosticText}\n\n`,
          });
        }
      }

      // Stage 6: Finalize
      await this.publishEvent(sid, 'terraform:status', { jobId: sid, stage: 'finalizing' });

      this.sessions.set(sid, {
        id: sid,
        messages: [...messages, { role: 'assistant', content: fullResponse }],
        matchedModules,
        generatedCode,
        lastAccessedAt: Date.now(),
      });

      await this.publishEvent(sid, 'terraform:done', {
        jobId: sid,
        matchedModules,
        generatedCode: generatedCode ?? undefined,
        generatedFiles,
        usage: {
          inputTokens,
          outputTokens,
        },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      const isAuthError =
        reason.includes('authentication_error') ||
        reason.includes('invalid x-api-key') ||
        reason.includes('invalid api key') ||
        reason.includes('credentials');
      const isRateLimit = reason.includes('rate_limit') || reason.includes('429');
      const isModelError = reason.includes('model_not_found') || reason.includes('invalid_model');
      const isContextLength =
        reason.includes('context_length') || reason.includes('too many tokens');

      if (isAuthError) {
        log.error('Authentication error', { data: { reason } });
        await this.publishEvent(sid, 'terraform:error', {
          jobId: sid,
          error:
            'Claude authentication failed. Please run "claude login" or check your credentials file.',
        });
      } else if (isRateLimit) {
        log.error('Rate limit error', { data: { reason } });
        await this.publishEvent(sid, 'terraform:error', {
          jobId: sid,
          error: 'Claude API rate limit reached. Please wait a moment and try again.',
        });
      } else if (isModelError) {
        log.error('Model error', { data: { reason } });
        await this.publishEvent(sid, 'terraform:error', {
          jobId: sid,
          error: 'Model configuration error. Check the TERRAFORM_COMPOSE_MODEL setting.',
        });
      } else if (isContextLength) {
        log.error('Context length error', { data: { reason } });
        await this.publishEvent(sid, 'terraform:error', {
          jobId: sid,
          error: 'The conversation is too long. Please start a new conversation.',
        });
      } else {
        log.error('Pipeline error', { data: { reason } });
        await this.publishEvent(sid, 'terraform:error', {
          jobId: sid,
          error: 'An error occurred during Terraform composition. Please try again.',
        });
      }
    } finally {
      if (session) {
        try {
          session.close();
        } catch (err) {
          if (!(err instanceof TypeError)) {
            log.warn('Unexpected error closing session', { error: err });
          }
        }
      }
    }
  }

  getSession(sessionId: string): ComposeSession | undefined {
    return this.sessions.get(sessionId);
  }

  resetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Validate generated HCL code (and optional tfvars) using @cdktf/hcl2json.
   * Pure JS — no terraform CLI binary required.
   */
  async validateCode(
    code: string,
    tfvars?: string
  ): Promise<{ valid: boolean; diagnostics: TerraformDiagnostic[] }> {
    let parse: (filename: string, content: string) => Promise<unknown>;
    try {
      ({ parse } = await import('@cdktf/hcl2json'));
    } catch (importError) {
      log.error('Failed to load HCL parser', { error: importError });
      return {
        valid: false,
        diagnostics: [
          {
            severity: 'error' as const,
            summary: 'HCL parser unavailable',
            detail:
              'The @cdktf/hcl2json module failed to load. This may be a platform compatibility issue.',
          },
        ],
      };
    }
    const diagnostics: TerraformDiagnostic[] = [];

    // Validate main HCL code
    try {
      await parse('main.tf', code);
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        summary: 'Invalid HCL in main.tf',
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    // Validate tfvars if provided
    if (tfvars) {
      try {
        await parse('terraform.tfvars', tfvars);
      } catch (error) {
        diagnostics.push({
          severity: 'error',
          summary: 'Invalid HCL in terraform.tfvars',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { valid: diagnostics.length === 0, diagnostics };
  }
}

function formatPrompt(systemPrompt: string, messages: ComposeMessage[]): string {
  const parts: string[] = [systemPrompt, ''];
  for (const msg of messages) {
    const role = msg.role === 'user' ? 'User' : 'Assistant';
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    parts.push(`${role}: ${content}`);
  }
  return parts.join('\n\n');
}

function extractHclCode(text: string): string | null {
  // Match ```hcl, ```terraform, and ```tf fenced code blocks
  const matches = [...text.matchAll(/```(?:hcl|terraform|tf)\n([\s\S]*?)```/g)]
    .map((m) => m[1]?.trim())
    .filter(Boolean);

  return matches.length > 0 ? matches.join('\n\n') : null;
}

/**
 * Extract multiple files from Stacks-mode response text.
 * Supports title annotations: ```hcl title="filename.tfcomponent.hcl"
 * Falls back to content-based filename inference when titles are missing.
 */
function extractStacksFiles(text: string): { filename: string; code: string }[] {
  const files: { filename: string; code: string }[] = [];

  // Match fenced code blocks with optional title annotations
  const blockRegex = /```(?:hcl|terraform|tf)(?:\s+title="([^"]+)")?\n([\s\S]*?)```/g;
  for (const match of text.matchAll(blockRegex)) {
    const title = match[1] ?? null;
    const code = match[2]?.trim();
    if (!code) continue;

    if (title) {
      files.push({ filename: title, code });
    } else {
      const filename = inferStacksFilename(code);
      files.push({ filename, code });
    }
  }

  // If no blocks found, return empty (caller should fall back)
  if (files.length === 0) return files;

  // Deduplicate by filename — merge code for same filename
  const merged = new Map<string, string>();
  for (const f of files) {
    const existing = merged.get(f.filename);
    merged.set(f.filename, existing ? `${existing}\n\n${f.code}` : f.code);
  }

  return Array.from(merged.entries()).map(([filename, code]) => ({ filename, code }));
}

/** Infer a Stacks filename from HCL content based on block types present. */
function inferStacksFilename(code: string): string {
  if (/\bdeployment\s+"/.test(code) || /\bdeployment_group\s+"/.test(code))
    return 'deployments.tfdeploy.hcl';
  if (/\bprovider\s+"/.test(code)) return 'providers.tfcomponent.hcl';
  if (/\bvariable\s+"/.test(code)) return 'variables.tfcomponent.hcl';
  if (/\boutput\s+"/.test(code)) return 'outputs.tfcomponent.hcl';
  if (/\bcomponent\s+"/.test(code)) return 'components.tfcomponent.hcl';
  return 'stack.tfcomponent.hcl';
}

/** Names too generic to match by name alone — they appear in every Terraform response. */
const GENERIC_MODULE_NAMES = new Set([
  'module',
  'test',
  'main',
  'example',
  'default',
  'resource',
  'variable',
  'output',
  'provider',
  'terraform',
  'data',
  'local',
  'locals',
]);

export interface TerraformDiagnostic {
  severity: 'error' | 'warning';
  summary: string;
  detail?: string;
}

function matchModulesInResponse(response: string, modules: TerraformModule[]): ModuleMatch[] {
  const matched: ModuleMatch[] = [];
  const seen = new Set<string>();
  const responseLower = response.toLowerCase();

  for (const mod of modules) {
    if (seen.has(mod.id)) continue;

    const nameLower = mod.name.toLowerCase();
    const isGenericName = GENERIC_MODULE_NAMES.has(nameLower) || nameLower.length < 3;

    const sourceInResponse = response.includes(mod.source);
    const namePattern = new RegExp(`\\b${nameLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    const nameInResponse = !isGenericName && namePattern.test(responseLower);

    let confidence: number | null = null;
    let matchReason = '';

    if (sourceInResponse) {
      confidence = 1.0;
      matchReason = 'Module source used in generated code';
    } else if (nameInResponse && responseLower.includes(mod.provider.toLowerCase())) {
      confidence = 0.8;
      matchReason = 'Module name and provider referenced in response';
    } else if (nameInResponse) {
      confidence = 0.5;
      matchReason = 'Module name mentioned in response';
    }

    if (confidence !== null) {
      seen.add(mod.id);
      matched.push({
        moduleId: mod.id,
        name: mod.name,
        provider: mod.provider,
        version: mod.version,
        source: mod.source,
        confidence,
        matchReason,
      });
    }
  }

  matched.sort((a, b) => b.confidence - a.confidence);
  return matched;
}

/**
 * Server-side fallback: parse numbered clarifying questions from assistant text.
 * Similar to the client-side parser in terraform-context.tsx but with
 * independently maintained option inference.
 */
function parseClarifyingQuestionsFromText(text: string): ClarifyingQuestion[] {
  // Skip if the response contains HCL code blocks (model generated code, not questions)
  if (/```(?:hcl|terraform|tf)\n/i.test(text)) return [];

  const questions: ClarifyingQuestion[] = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // Match "1. ...", "1) ...", "- ...", "* ..." patterns ending with "?"
    const match = trimmed.match(/^(?:\d+[.)]\s*|-\s*|\*\s*)(.+\?)\s*$/);
    if (!match) continue;

    const raw = match[1] ?? '';
    // Extract category from bold markers: **Category** or **Category:**
    const categoryMatch = raw.match(/\*\*(.+?)\*\*\s*[-–:]\s*/);
    const category = categoryMatch ? (categoryMatch[1] ?? 'General') : 'General';
    const question = raw.replace(/\*\*(.+?)\*\*\s*[-–:]\s*/, '').trim();

    if (question.length > 10) {
      // Extract options from backtick-wrapped examples in the question text
      const backtickOptions = [...question.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '');
      const options =
        backtickOptions.length > 0 ? backtickOptions : inferDefaultOptions(question, category);
      questions.push({ category, question, options });
    }
  }
  return questions;
}

/** Infer sensible default options based on question category/content. */
function inferDefaultOptions(question: string, category: string): string[] {
  const lower = `${question} ${category}`.toLowerCase();
  if (/region|location|zone/.test(lower)) return ['us-east-1', 'us-west-2', 'eu-west-1'];
  if (/environment|env/.test(lower)) return ['Production', 'Staging', 'Development'];
  if (/domain|dns/.test(lower)) return ['example.com', 'Use placeholder'];
  if (/ssl|tls|certificate|https/.test(lower)) return ['Yes, include ACM', 'No, skip SSL'];
  if (/instance.type|sizing|capacity/.test(lower))
    return ['t3.micro', 't3.small', 't3.medium', 't3.large'];
  if (/should|do you want|would you like/.test(lower)) return ['Yes', 'No'];
  return ['Use placeholder values'];
}
