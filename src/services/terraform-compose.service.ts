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
  ComposeEvent,
  ComposeMessage,
  ComposeMode,
  ComposeStage,
  GeneratedFile,
  ModuleMatch,
} from '../lib/terraform/types.js';
import type { Result } from '../lib/utils/result.js';
import { ok } from '../lib/utils/result.js';
import type { Database } from '../types/database.js';
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
const KEEPALIVE_MS = 15_000;
const MAX_PENDING_EVENTS = 50;

export interface ComposeSession {
  id: string;
  messages: ComposeMessage[];
  matchedModules: ModuleMatch[];
  generatedCode: string | null;
  lastAccessedAt: number;
}

/**
 * Streaming compose job.
 * The SSE controller is stored directly so `runPipeline` can push events
 * via `controller.enqueue()` — matching the pattern used by sessions,
 * task-creation, and cli-monitor SSE endpoints.
 *
 * `pendingEvents` buffers critical events (error, done, code) that arrive before
 * a subscriber connects, so late subscribers still receive them.
 */
interface ComposeJob {
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  finished: boolean;
  keepaliveInterval: ReturnType<typeof setInterval> | null;
  pendingEvents: ComposeEvent[];
}

const encoder = new TextEncoder();

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
  private jobs = new Map<string, ComposeJob>();

  constructor(
    private registryService: TerraformRegistryService,
    private db: Database,
    private settingsService?: SettingsService
  ) {}

  private cleanupSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastAccessedAt > SESSION_TTL_MS) {
        this.sessions.delete(id);
        this.jobs.delete(id);
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
        this.jobs.delete(id);
      }
    }
  }

  /**
   * Start a compose job in the background and return the session ID immediately.
   * The caller then connects to `subscribeToJob()` via a separate GET SSE endpoint.
   */
  async startCompose(
    sessionId: string | undefined,
    messages: ComposeMessage[],
    registryId?: string,
    composeMode: ComposeMode = 'terraform'
  ): Promise<Result<{ sessionId: string }, TerraformError>> {
    const sid = sessionId || createId();

    this.cleanupSessions();

    // Create the job — controller will be set when subscriber connects
    const job: ComposeJob = {
      controller: null,
      finished: false,
      keepaliveInterval: null,
      pendingEvents: [],
    };
    this.jobs.set(sid, job);

    // Run pipeline without awaiting — the caller returns the session ID immediately.
    this.runPipeline(sid, messages, registryId, job, composeMode).catch((pipelineErr) => {
      log.error('Unhandled pipeline error', { error: pipelineErr });
      this.sendEvent(job, {
        type: 'error',
        error: 'An unexpected error occurred. Please try again.',
      });
      this.finishJob(job);
    });

    return ok({ sessionId: sid });
  }

  /**
   * Subscribe to a compose job's event stream.
   * Returns a ReadableStream of SSE-formatted bytes.
   * The controller is stored on the job so runPipeline can push events directly.
   */
  subscribeToJob(sessionId: string): ReadableStream<Uint8Array> | null {
    const job = this.jobs.get(sessionId);
    if (!job) return null;

    // Prevent multiple subscribers from overwriting the controller
    if (job.controller) return null;

    return new ReadableStream<Uint8Array>({
      start(controller) {
        job.controller = controller;

        // Replay any events that were buffered before the subscriber connected
        for (const event of job.pendingEvents) {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch (err) {
            if (!(err instanceof TypeError)) {
              log.warn('Unexpected error replaying event', { error: err });
            }
            break;
          }
        }
        job.pendingEvents = [];

        // If the job already finished before subscriber connected, close immediately
        if (job.finished) {
          try {
            controller.close();
          } catch (err) {
            if (!(err instanceof TypeError)) {
              log.warn('Unexpected error closing controller', { error: err });
            }
          }
          job.controller = null;
          return;
        }

        // Keep-alive ping every 15s to prevent proxy/Bun idle timeouts
        job.keepaliveInterval = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(': keepalive\n\n'));
          } catch (err) {
            // Enqueue failed — stream is likely closed, clear interval to stop retrying
            if (!(err instanceof TypeError)) {
              log.warn('Keepalive enqueue failed, stream likely closed', { error: err });
            }
            if (job.keepaliveInterval) {
              clearInterval(job.keepaliveInterval);
              job.keepaliveInterval = null;
            }
          }
        }, KEEPALIVE_MS);
      },
      cancel() {
        if (job.keepaliveInterval) clearInterval(job.keepaliveInterval);
        job.keepaliveInterval = null;
        job.controller = null;
      },
    });
  }

  private sendEvent(job: ComposeJob, event: ComposeEvent): void {
    if (!job.controller) {
      // Buffer critical events so late subscribers can replay them
      if (event.type === 'error' || event.type === 'done' || event.type === 'code') {
        if (job.pendingEvents.length >= MAX_PENDING_EVENTS) {
          log.warn('Event buffer full, dropping oldest non-critical event', {
            data: { eventType: event.type, bufferSize: job.pendingEvents.length },
          });
          // Drop oldest non-critical event to make room
          const dropIdx = job.pendingEvents.findIndex(
            (e) => e.type !== 'error' && e.type !== 'done'
          );
          if (dropIdx >= 0) {
            job.pendingEvents.splice(dropIdx, 1);
          } else {
            job.pendingEvents.shift();
          }
        }
        job.pendingEvents.push(event);
      }
      return;
    }
    try {
      job.controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    } catch (err) {
      log.warn('SSE controller broken, falling back to event buffer', {
        data: { eventType: event.type },
        error: err,
      });
      // Controller is broken — null it out so subsequent events get buffered
      // instead of repeatedly hitting the broken controller
      job.controller = null;
      if (job.keepaliveInterval) {
        clearInterval(job.keepaliveInterval);
        job.keepaliveInterval = null;
      }
      // Buffer this event that failed to send
      if (event.type === 'error' || event.type === 'done' || event.type === 'code') {
        job.pendingEvents.push(event);
      }
    }
  }

  private sendStatus(job: ComposeJob, stage: ComposeStage): void {
    this.sendEvent(job, { type: 'status', stage });
  }

  private finishJob(job: ComposeJob): void {
    job.finished = true;
    if (job.keepaliveInterval) {
      clearInterval(job.keepaliveInterval);
      job.keepaliveInterval = null;
    }
    if (job.controller) {
      try {
        job.controller.close();
      } catch (err) {
        if (!(err instanceof TypeError)) {
          log.warn('Unexpected error closing controller in finishJob', { error: err });
        }
      }
      job.controller = null;
    }
  }

  /**
   * Wait for the subscriber to connect before pushing events.
   * The POST /compose returns the sessionId, then the client connects
   * to GET /compose/:sessionId/events which sets job.controller.
   */
  private async waitForSubscriber(job: ComposeJob, maxWaitMs = 10_000): Promise<boolean> {
    const start = Date.now();
    while (!job.controller && Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return !!job.controller;
  }

  private async runPipeline(
    sid: string,
    messages: ComposeMessage[],
    registryId: string | undefined,
    job: ComposeJob,
    composeMode: ComposeMode
  ): Promise<void> {
    // Wait for the SSE subscriber to connect before pushing events
    const subscriberReady = await this.waitForSubscriber(job);
    if (!subscriberReady) {
      log.warn('No subscriber connected within timeout, aborting pipeline');
      // Buffer an error so late subscribers get feedback instead of an empty stream
      this.sendEvent(job, {
        type: 'error',
        error: 'Compose session timed out waiting for connection. Please try again.',
      });
      this.finishJob(job);
      return;
    }

    let session: ReturnType<typeof unstable_v2_createSession> | null = null;

    try {
      // Stage 1: Load module catalog
      this.sendStatus(job, 'loading_catalog');

      const contextResult = await this.registryService.getModuleContext(registryId);
      if (!contextResult.ok) {
        this.sendEvent(job, {
          type: 'error',
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
        this.sendEvent(job, {
          type: 'text',
          content:
            '\n\n> ⚠️ Warning: Could not load module catalog for matching. Module suggestions may be incomplete.\n\n',
        });
      }
      const allModules = modulesResult.ok ? modulesResult.value : [];

      // Stage 2: Analyzing requirements (streaming with Agent SDK)
      this.sendStatus(job, 'analyzing');

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
            this.sendEvent(job, { type: 'text', content: event.delta.text });
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
            this.sendEvent(job, { type: 'questions', questions });
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
        this.sendEvent(job, { type: 'text', content: fullResponse });
      }

      // Stage 3: Match modules
      this.sendStatus(job, 'matching_modules');

      const matchedModules = matchModulesInResponse(fullResponse, allModules);

      if (matchedModules.length > 0) {
        this.sendEvent(job, { type: 'modules', modules: matchedModules });
      }

      // Stage 4: Extract code
      this.sendStatus(job, 'generating_code');

      let generatedCode: string | null = null;
      let generatedFiles: GeneratedFile[] | undefined;

      if (composeMode === 'stacks') {
        const stacksFiles = extractStacksFiles(fullResponse);
        if (stacksFiles.length > 0) {
          generatedFiles = stacksFiles;
          generatedCode = stacksFiles.map((f) => f.code).join('\n\n');
          this.sendEvent(job, { type: 'code', code: generatedCode, files: generatedFiles });
        } else if (fullResponse) {
          log.warn('Stacks mode produced no files from non-empty response', {
            data: { responseLength: fullResponse.length },
          });
        }
      } else {
        generatedCode = extractHclCode(fullResponse);
        if (generatedCode) {
          this.sendEvent(job, { type: 'code', code: generatedCode });
        }
      }

      // Fallback: parse clarifying questions from assistant text if AskUserQuestion
      // tool was not used (model wrote questions as plain text instead)
      if (!generatedCode && fullResponse) {
        const textQuestions = parseClarifyingQuestionsFromText(fullResponse);
        if (textQuestions.length > 0) {
          this.sendEvent(job, { type: 'questions', questions: textQuestions });
        }
      }

      // Stage 5: Validate HCL (skip for stacks — the parser only understands standard Terraform)
      if (generatedCode && composeMode !== 'stacks') {
        this.sendStatus(job, 'validating_hcl');
        const validation = await this.validateCode(generatedCode);
        if (!validation.valid) {
          log.warn('HCL validation warnings', {
            data: { diagnostics: validation.diagnostics.map((d) => d.summary) },
          });
          // Send validation diagnostics to the client so the UI can display warnings
          const diagnosticText = validation.diagnostics
            .map((d) => `- ${d.severity}: ${d.summary}${d.detail ? ` (${d.detail})` : ''}`)
            .join('\n');
          this.sendEvent(job, {
            type: 'text',
            content: `\n\n> ⚠️ HCL Validation Issues:\n${diagnosticText}\n\n`,
          });
        }
      }

      // Stage 6: Finalize
      this.sendStatus(job, 'finalizing');

      this.sessions.set(sid, {
        id: sid,
        messages: [...messages, { role: 'assistant', content: fullResponse }],
        matchedModules,
        generatedCode,
        lastAccessedAt: Date.now(),
      });

      this.sendEvent(job, {
        type: 'done',
        sessionId: sid,
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
        this.sendEvent(job, {
          type: 'error',
          error:
            'Claude authentication failed. Please run "claude login" or check your credentials file.',
        });
      } else if (isRateLimit) {
        log.error('Rate limit error', { data: { reason } });
        this.sendEvent(job, {
          type: 'error',
          error: 'Claude API rate limit reached. Please wait a moment and try again.',
        });
      } else if (isModelError) {
        log.error('Model error', { data: { reason } });
        this.sendEvent(job, {
          type: 'error',
          error: 'Model configuration error. Check the TERRAFORM_COMPOSE_MODEL setting.',
        });
      } else if (isContextLength) {
        log.error('Context length error', { data: { reason } });
        this.sendEvent(job, {
          type: 'error',
          error: 'The conversation is too long. Please start a new conversation.',
        });
      } else {
        log.error('Pipeline error', { data: { reason } });
        this.sendEvent(job, {
          type: 'error',
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
      this.finishJob(job);
    }
  }

  getSession(sessionId: string): ComposeSession | undefined {
    return this.sessions.get(sessionId);
  }

  resetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.jobs.delete(sessionId);
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
