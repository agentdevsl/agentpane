import { stream as durableStream } from '@durable-streams/client';
import type React from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { apiClient } from '@/lib/api/client';
import type {
  ClarifyingQuestion,
  ComposeMessage,
  ComposeMode,
  ComposeStage,
  GeneratedFile,
  ModuleMatch,
  TerraformModuleView,
  TerraformRegistryView,
} from '@/lib/terraform/types';

/** Infer clickable options from a question's text based on common patterns. */
function inferOptions(question: string): string[] {
  const q = question.toLowerCase();

  // Extract inline examples: (e.g., `us-east-1`, `eu-west-1`)
  const backtickExamples = [...question.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '');
  if (backtickExamples.length >= 2) return backtickExamples.slice(0, 4);

  // Yes/no patterns: "Should I include...", "Do you want..."
  if (/\b(should i|do you want|would you like|do you need|include)\b/i.test(q)) {
    return ['Yes', 'No'];
  }

  // Region questions
  if (/\b(region|where.*(?:bucket|deploy|host|live))\b/i.test(q)) {
    return ['us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-2'];
  }

  // Domain questions
  if (/\b(domain|hostname|url|site)\b/i.test(q)) {
    return ['Use default:example.com'];
  }

  // SSL/certificate questions
  if (/\b(ssl|certificate|https|tls|acm)\b/i.test(q)) {
    return ['Yes, include ACM', 'No, skip SSL'];
  }

  // Environment questions
  if (/\b(environment|env|stage)\b/i.test(q)) {
    return ['Production', 'Staging', 'Development'];
  }

  // Instance type / size questions
  if (/\b(instance.*type|size|capacity)\b/i.test(q)) {
    return ['t3.micro', 't3.small', 't3.medium', 't3.large'];
  }

  // Fallback: no inferred options — user can type a custom answer
  return [];
}

/** Parse numbered clarifying questions from assistant text.
 *  Matches patterns like:
 *  - "1. **Domain name** – What domain will this...?"
 *  - "1. What domain will this...?"
 *  - "- **Region** - Where should the bucket...?"
 */
function parseClarifyingQuestions(text: string): ClarifyingQuestion[] {
  // Only look for questions if there are no HCL code blocks (i.e. AI is asking, not generating)
  if (/```(?:hcl|terraform|tf)\n/i.test(text)) return [];

  const questions: ClarifyingQuestion[] = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // Match "1. ...", "- ...", "* ..." patterns ending with "?"
    const match = trimmed.match(/^(?:\d+[.)]\s*|-\s*|\*\s*)(.+\?)\s*$/);
    if (!match) continue;

    const raw = match[1] ?? '';
    // Extract category from bold markers: **Category** or **Category:**
    const categoryMatch = raw.match(/\*\*(.+?)\*\*\s*[-–:]\s*/);
    const category = categoryMatch ? (categoryMatch[1] ?? 'General') : 'General';
    // Clean question text: remove bold markers
    const question = raw.replace(/\*\*(.+?)\*\*\s*[-–:]\s*/, '').trim();

    if (question.length > 10) {
      const options = inferOptions(question);
      questions.push({ category, question, options });
    }
  }
  return questions;
}

/** Client-side fallback: extract HCL code from fenced code blocks in assistant text. */
function extractHclFromText(text: string): string | null {
  // Try ```hcl, ```terraform, ```tf first
  const hclMatches = [...text.matchAll(/```(?:hcl|terraform|tf)\n([\s\S]*?)```/g)]
    .map((m) => m[1]?.trim())
    .filter(Boolean);
  if (hclMatches.length > 0) return hclMatches.join('\n\n');

  // Fallback: plain ``` blocks that contain module/resource/variable blocks
  const plainMatches = [...text.matchAll(/```\n([\s\S]*?)```/g)]
    .map((m) => m[1]?.trim())
    .filter((block) => block && /\b(module|resource|variable|terraform)\s/.test(block));
  if (plainMatches.length > 0) return plainMatches.join('\n\n');

  return null;
}

/** Client-side fallback: extract Stacks files from assistant text. */
function extractStacksFilesFromText(text: string): GeneratedFile[] | null {
  const files: GeneratedFile[] = [];
  const blockRegex = /```(?:hcl|terraform|tf)(?:\s+title="([^"]+)")?\n([\s\S]*?)```/g;
  for (const match of text.matchAll(blockRegex)) {
    const title = match[1] ?? null;
    const code = match[2]?.trim();
    if (!code) continue;
    if (title) {
      files.push({ filename: title, code });
    } else {
      // Infer filename from content
      if (/\bdeployment\s+"/.test(code) || /\bdeployment_group\s+"/.test(code)) {
        files.push({ filename: 'deployments.tfdeploy.hcl', code });
      } else if (/\bprovider\s+"/.test(code)) {
        files.push({ filename: 'providers.tfcomponent.hcl', code });
      } else if (/\bvariable\s+"/.test(code)) {
        files.push({ filename: 'variables.tfcomponent.hcl', code });
      } else if (/\boutput\s+"/.test(code)) {
        files.push({ filename: 'outputs.tfcomponent.hcl', code });
      } else if (/\bcomponent\s+"/.test(code)) {
        files.push({ filename: 'components.tfcomponent.hcl', code });
      } else {
        files.push({ filename: 'stack.tfcomponent.hcl', code });
      }
    }
  }
  if (files.length === 0) return null;

  // Deduplicate by filename — merge code for same filename
  const merged = new Map<string, string>();
  for (const f of files) {
    const existing = merged.get(f.filename);
    merged.set(f.filename, existing ? `${existing}\n\n${f.code}` : f.code);
  }

  return Array.from(merged.entries()).map(([filename, code]) => ({ filename, code }));
}

interface TerraformContextValue {
  messages: ComposeMessage[];
  matchedModules: ModuleMatch[];
  generatedCode: string | null;
  generatedFiles: GeneratedFile[] | null;
  composeMode: ComposeMode;
  setComposeMode: (mode: ComposeMode) => void;
  registries: TerraformRegistryView[];
  modules: TerraformModuleView[];
  syncStatus: { lastSynced: string | null; moduleCount: number };
  isStreaming: boolean;
  composeStage: ComposeStage | null;
  composeComplete: boolean;
  error: string | null;
  selectedModuleId: string | null;
  sendMessage: (content: string) => Promise<void>;
  resetConversation: () => void;
  setSelectedModuleId: (id: string | null) => void;
  refreshModules: () => Promise<void>;
  syncRegistry: (id: string) => Promise<void>;
  clearError: () => void;
}

const TerraformContext = createContext<TerraformContextValue | null>(null);

export function useTerraform(): TerraformContextValue {
  const ctx = useContext(TerraformContext);
  if (!ctx) {
    throw new Error('useTerraform must be used within a TerraformProvider');
  }
  return ctx;
}

export function TerraformProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [messages, setMessages] = useState<ComposeMessage[]>([]);
  const [matchedModules, setMatchedModules] = useState<ModuleMatch[]>([]);
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [registries, setRegistries] = useState<TerraformRegistryView[]>([]);
  const [modules, setModules] = useState<TerraformModuleView[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [composeStage, setComposeStage] = useState<ComposeStage | null>(null);
  const [composeComplete, setComposeComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedModuleId, setSelectedModuleId] = useState<string | null>(null);
  const [composeMode, setComposeMode] = useState<ComposeMode>('terraform');
  const [generatedFiles, setGeneratedFiles] = useState<GeneratedFile[] | null>(null);
  const sessionIdRef = useRef<string | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const streamResponseRef = useRef<Awaited<ReturnType<typeof durableStream>> | null>(null);
  const messagesRef = useRef<ComposeMessage[]>([]);
  const isStreamingRef = useRef(false);
  const composeModeRef = useRef(composeMode);
  const isMountedRef = useRef(true);
  messagesRef.current = messages;
  composeModeRef.current = composeMode;

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const loadRegistries = useCallback(async () => {
    try {
      const result = await apiClient.terraform.listRegistries();
      if (result.ok) {
        setRegistries(result.data.items as TerraformRegistryView[]);
      } else {
        console.error('[Terraform] Failed to load registries:', result.error);
        setError('Failed to load registries. The backend may be offline.');
      }
    } catch (err) {
      console.error('[Terraform] Network error loading registries:', err);
      setError('Failed to load registries. The backend may be offline.');
    }
  }, []);

  const loadModules = useCallback(async () => {
    try {
      const result = await apiClient.terraform.listModules({ limit: 200 });
      if (result.ok) {
        setModules(result.data.items as TerraformModuleView[]);
      } else {
        console.error('[Terraform] Failed to load modules:', result.error);
        setError('Failed to load modules. The backend may be offline.');
      }
    } catch (err) {
      console.error('[Terraform] Network error loading modules:', err);
      setError('Failed to load modules. The backend may be offline.');
    }
  }, []);

  // Load registries and modules on mount
  useEffect(() => {
    void loadRegistries();
    void loadModules();
  }, [loadRegistries, loadModules]);

  const refreshModules = useCallback(async () => {
    await loadModules();
    await loadRegistries();
  }, [loadModules, loadRegistries]);

  const syncRegistry = useCallback(
    async (id: string) => {
      try {
        const result = await apiClient.terraform.syncRegistry(id);
        if (!result.ok) {
          setError(`Sync failed: ${result.error?.message ?? 'Unknown error'}`);
          return;
        }
        await refreshModules();
      } catch (err) {
        setError(`Sync failed: ${err instanceof Error ? err.message : String(err)}`);
        console.error('[Terraform] Sync error:', err);
      }
    },
    [refreshModules]
  );

  const sendMessage = useCallback(
    async (content: string) => {
      if (isStreamingRef.current) return;

      setError(null);
      setComposeComplete(false);

      const userMessage: ComposeMessage = { role: 'user', content };
      const updatedMessages = [...messagesRef.current, userMessage];
      setMessages(updatedMessages);
      setIsStreaming(true);
      isStreamingRef.current = true;
      setComposeStage(null);
      setMatchedModules([]);
      setGeneratedCode(null);
      setGeneratedFiles(null);

      // Cancel any existing stream subscription
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
      if (streamResponseRef.current) {
        streamResponseRef.current.cancel();
        streamResponseRef.current = null;
      }
      if (abortRef.current) {
        abortRef.current.abort();
      }
      abortRef.current = new AbortController();

      let receivedDone = false;
      let receivedPartialData = false;
      let assistantContent = '';
      let streamFailed = false;

      try {
        // Step 1: POST to start the compose job (returns immediately with sessionId)
        const composeUrl = apiClient.terraform.getComposeUrl();
        const startResponse = await fetch(composeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: sessionIdRef.current,
            messages: updatedMessages,
            composeMode,
          }),
          signal: abortRef.current.signal,
        });

        if (!startResponse.ok) {
          const errorBody = await startResponse.json().catch(() => null);
          throw new Error(
            errorBody?.error?.message ?? `Compose request failed: ${startResponse.status}`
          );
        }

        const startData = (await startResponse.json()) as {
          ok: boolean;
          data: { sessionId: string };
        };
        const jobSessionId = startData.data.sessionId;

        // Step 2: Subscribe to Caddy durable stream for this job
        const streamUrl = `/v1/stream/terraform/${encodeURIComponent(jobSessionId)}`;

        // Create a promise that resolves when the stream completes (done/error event)
        const streamComplete = new Promise<void>((resolve) => {
          let streamRetryCount = 0;
          const MAX_STREAM_RETRIES = 5;
          const startStream = async () => {
            try {
              const response = await durableStream({
                url: streamUrl,
                live: 'sse',
                offset: '-1',
                json: true,
                onError: (streamError) => {
                  streamRetryCount++;
                  console.error(
                    `[Terraform] Durable stream error (attempt ${streamRetryCount}/${MAX_STREAM_RETRIES}):`,
                    streamError
                  );
                  if (streamRetryCount >= MAX_STREAM_RETRIES) {
                    setError('Stream connection failed after multiple retries');
                    setIsStreaming(false);
                    resolve();
                    return; // Return void to stop stream
                  }
                  return {}; // Signal retry
                },
              });

              streamResponseRef.current = response;

              /** Route a terraform stream event to the appropriate handler */
              function processStreamItem(item: {
                type: string;
                data: Record<string, unknown>;
                timestamp?: number;
              }): void {
                try {
                  switch (item.type) {
                    case 'terraform:status':
                      setComposeStage(item.data.stage as ComposeStage);
                      receivedPartialData = true;
                      break;

                    case 'terraform:text':
                      assistantContent += (item.data.delta as string) ?? '';
                      setMessages((prev) => {
                        const newMessages = [...prev];
                        const lastMsg = newMessages[newMessages.length - 1];
                        if (lastMsg?.role === 'assistant') {
                          newMessages[newMessages.length - 1] = {
                            ...lastMsg,
                            content: assistantContent,
                          };
                        } else {
                          newMessages.push({ role: 'assistant', content: assistantContent });
                        }
                        return newMessages;
                      });
                      break;

                    case 'terraform:modules': {
                      const modules = item.data.modules as ModuleMatch[];
                      setMatchedModules(modules);
                      receivedPartialData = true;
                      setMessages((prev) => {
                        const newMessages = [...prev];
                        const lastMsg = newMessages[newMessages.length - 1];
                        if (lastMsg?.role === 'assistant') {
                          newMessages[newMessages.length - 1] = {
                            ...lastMsg,
                            modules,
                          };
                        }
                        return newMessages;
                      });
                      break;
                    }

                    case 'terraform:questions': {
                      const questions = item.data.questions as ClarifyingQuestion[];
                      setMessages((prev) => {
                        const newMessages = [...prev];
                        const lastMsg = newMessages[newMessages.length - 1];
                        if (lastMsg?.role === 'assistant') {
                          const existing = lastMsg.clarifyingQuestions ?? [];
                          newMessages[newMessages.length - 1] = {
                            ...lastMsg,
                            clarifyingQuestions: [...existing, ...questions],
                          };
                        }
                        return newMessages;
                      });
                      receivedPartialData = true;
                      break;
                    }

                    case 'terraform:code':
                      setGeneratedCode(item.data.code as string);
                      if (item.data.files) setGeneratedFiles(item.data.files as GeneratedFile[]);
                      break;

                    case 'terraform:done':
                      receivedDone = true;
                      sessionIdRef.current = jobSessionId;
                      setComposeStage('finalizing');
                      setComposeComplete(true);
                      if (item.data.matchedModules)
                        setMatchedModules(item.data.matchedModules as ModuleMatch[]);
                      if (item.data.generatedCode)
                        setGeneratedCode(item.data.generatedCode as string);
                      if (item.data.generatedFiles)
                        setGeneratedFiles(item.data.generatedFiles as GeneratedFile[]);
                      // Stream is done — clean up
                      resolve();
                      break;

                    case 'terraform:error':
                      console.error('[Terraform] Compose error:', item.data.error);
                      setComposeStage(null);
                      setComposeComplete(false);
                      setError(item.data.error as string);
                      resolve();
                      break;

                    default:
                      break;
                  }
                } catch (processingError) {
                  console.error(
                    '[Terraform] Error processing stream event:',
                    item.type,
                    processingError
                  );
                  setError('An error occurred processing the server response. Please try again.');
                }
              }

              // Subscribe to JSON batches from the durable stream
              unsubscribeRef.current = response.subscribeJson<{
                type: string;
                data: Record<string, unknown>;
                timestamp?: number;
              }>((batch) => {
                for (const item of batch.items) {
                  processStreamItem(item);
                }
              });

              // Monitor for stream closure
              response.closed
                .then(() => {
                  if (!receivedDone && !response.streamClosed) {
                    console.warn('[Terraform] Stream closed without terminal event');
                    setError('Stream connection lost. Partial results may be shown.');
                  }
                  resolve();
                })
                .catch((err) => {
                  console.error('[Terraform] Stream closed with error:', err);
                  resolve();
                });
            } catch (connectError) {
              console.error('[Terraform] Failed to connect to durable stream:', connectError);
              setError(
                'Failed to connect to the event stream. Please check your connection and try again.'
              );
              resolve();
            }
          };

          startStream();
        });

        // Wait for the stream to complete (done or error event)
        await streamComplete;
      } catch (err) {
        streamFailed = true;
        if (err instanceof Error && err.name === 'AbortError') return;
        console.error('[Terraform] Stream error:', err);

        const errorMessage = (() => {
          if (err instanceof TypeError && err.message.includes('fetch')) {
            return 'Unable to reach the server. Please check your connection and try again.';
          }
          if (err instanceof Error && err.message.includes('timeout')) {
            return 'The request timed out. The server may be under heavy load -- please try again shortly.';
          }
          return receivedPartialData
            ? 'The stream ended unexpectedly, but partial results are shown below.'
            : 'Failed to get a response. Please check your connection and try again.';
        })();

        setError(errorMessage);
      } finally {
        // Clean up stream subscription
        // Note: refs are mutated by the async stream callback; TypeScript's control
        // flow analysis doesn't track cross-async mutations, so cast is needed.
        const unsub = unsubscribeRef.current as (() => void) | null;
        if (unsub) {
          unsub();
          unsubscribeRef.current = null;
        }
        const streamResp = streamResponseRef.current as {
          cancel: (reason?: unknown) => void;
        } | null;
        if (streamResp) {
          streamResp.cancel();
          streamResponseRef.current = null;
        }

        isStreamingRef.current = false;
        if (isMountedRef.current) {
          setIsStreaming(false);
          if (!receivedDone) {
            setComposeStage(null);
            setComposeComplete(false);
          }
          // Client-side fallback: extract HCL from assistant content if server didn't send a code event
          if (!streamFailed) {
            setGeneratedCode((prev) => {
              if (prev) return prev;
              return extractHclFromText(assistantContent);
            });
          }
          // Stacks mode fallback: extract multi-file output from assistant content
          if (!streamFailed && composeModeRef.current === 'stacks') {
            setGeneratedFiles((prev) => {
              if (prev) return prev;
              return extractStacksFilesFromText(assistantContent);
            });
          }
          // Parse clarifying questions from assistant text and attach to message
          // (only if the server didn't already send questions via durable stream events)
          if (!streamFailed && assistantContent) {
            const questions = parseClarifyingQuestions(assistantContent);
            if (questions.length > 0) {
              setMessages((prev) => {
                const updated = [...prev];
                const lastMsg = updated[updated.length - 1];
                if (lastMsg?.role === 'assistant' && !lastMsg.clarifyingQuestions?.length) {
                  updated[updated.length - 1] = { ...lastMsg, clarifyingQuestions: questions };
                }
                return updated;
              });
            }
          }
        }
      }
    },
    [composeMode]
  );

  const resetConversation = useCallback(() => {
    setMessages([]);
    setMatchedModules([]);
    setGeneratedCode(null);
    setGeneratedFiles(null);
    setComposeStage(null);
    setComposeComplete(false);
    setError(null);
    sessionIdRef.current = undefined;
    isStreamingRef.current = false;
    setIsStreaming(false);
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }
    if (streamResponseRef.current) {
      streamResponseRef.current.cancel();
      streamResponseRef.current = null;
    }
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const syncStatus = useMemo(
    () => ({
      lastSynced: registries[0]?.lastSyncedAt ?? null,
      moduleCount: modules.length,
    }),
    [registries, modules.length]
  );

  const contextValue = useMemo(
    () => ({
      messages,
      matchedModules,
      generatedCode,
      generatedFiles,
      composeMode,
      setComposeMode,
      registries,
      modules,
      syncStatus,
      isStreaming,
      composeStage,
      composeComplete,
      error,
      selectedModuleId,
      sendMessage,
      resetConversation,
      setSelectedModuleId,
      refreshModules,
      syncRegistry,
      clearError: () => setError(null),
    }),
    [
      messages,
      matchedModules,
      generatedCode,
      generatedFiles,
      composeMode,
      registries,
      modules,
      syncStatus,
      isStreaming,
      composeStage,
      composeComplete,
      error,
      selectedModuleId,
      sendMessage,
      resetConversation,
      refreshModules,
      syncRegistry,
    ]
  );

  return <TerraformContext.Provider value={contextValue}>{children}</TerraformContext.Provider>;
}
