# Interactive Sessions: Container Agent User Input

## Overview
Enable users to answer questions (AskUserQuestion tool) when a container agent is running inside Docker.

## Problem
Currently, when a container agent calls `AskUserQuestion`, there's no mechanism for:
1. The host to know the agent is waiting for input
2. The user to provide answers through the UI
3. The agent to receive and process responses

## Architecture Decision: File-Based Input

Using file-based communication as it:
- Works with current Docker exec setup (no stdin changes)
- Minimal infrastructure changes required
- Reliable and debuggable
- Can be upgraded to stdin-based later if needed

### Flow
```
Agent calls AskUserQuestion
    ↓
canUseTool intercepts, emits "waiting_input" event
    ↓
UI displays questions to user
    ↓
User selects answer, submits
    ↓
API writes response to /tmp/.agent-input-{taskId}.json
    ↓
Agent reads file, continues execution
```

## Implementation Plan

### Phase 1: Agent Runner Changes

#### 1.1 Event Emitter (`agent-runner/src/event-emitter.ts`)
Add `waitingInput` event:
```typescript
waitingInput(data: {
  toolId: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;
}): void
```

#### 1.2 Input Handler (`agent-runner/src/index.ts`)
In `canUseTool` callback:
```typescript
if (toolName === 'AskUserQuestion') {
  const questions = input.questions as Question[];

  // Emit event to notify host
  events.waitingInput({
    toolId: options.toolUseID,
    questions
  });

  // Wait for input file (with timeout and abort signal)
  const inputFile = `/tmp/.agent-input-${config.taskId}.json`;
  const response = await waitForInputFile(inputFile, {
    signal: options.signal,
    timeoutMs: 300000, // 5 minute timeout
    pollIntervalMs: 500,
  });

  // Format response for SDK
  return {
    behavior: 'allow',
    toolUseID: options.toolUseID,
    updatedInput: { answers: response.answers },
  };
}
```

### Phase 2: Backend Service Changes

#### 2.1 Durable Streams Schema (`src/services/durable-streams.service.ts`)
Add event interface:
```typescript
export interface ContainerAgentWaitingInputEvent {
  taskId: string;
  sessionId: string;
  toolId: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;
}
```

#### 2.2 Container Agent Service (`src/services/container-agent.service.ts`)
Add method:
```typescript
async sendInput(
  taskId: string,
  response: { answers: Record<string, string | string[]> }
): Promise<Result<void, SandboxError>> {
  const agent = this.runningAgents.get(taskId);
  if (!agent) return err(SandboxErrors.AGENT_NOT_RUNNING);

  const sandbox = await this.provider.getById(agent.sandboxId);
  const inputFile = `/tmp/.agent-input-${taskId}.json`;

  // Write response to container
  await sandbox.exec('bash', [
    '-c',
    `echo '${JSON.stringify(response)}' > ${inputFile}`
  ]);

  return ok(undefined);
}
```

#### 2.3 API Endpoint (`src/server/routes/sessions.ts`)
Add POST endpoint:
```typescript
app.post('/:id/input', async (c) => {
  const sessionId = c.req.param('id');
  const body = await c.req.json();

  // Find task by sessionId
  const session = await db.query.sessions.findFirst({
    where: eq(sessions.id, sessionId),
  });

  if (!session?.taskId) {
    return json({ ok: false, error: { code: 'NOT_FOUND' } }, 404);
  }

  const result = await containerAgentService.sendInput(
    session.taskId,
    body
  );

  return json({ ok: result.ok });
});
```

### Phase 3: Frontend Changes

#### 3.1 Streams Client (`src/lib/streams/client.ts`)
Add schema and callback:
```typescript
const rawContainerAgentWaitingInputSchema = z.object({
  taskId: z.string(),
  sessionId: z.string(),
  toolId: z.string(),
  questions: z.array(z.object({
    question: z.string(),
    header: z.string(),
    options: z.array(z.object({
      label: z.string(),
      description: z.string(),
    })),
    multiSelect: z.boolean(),
  })),
});

// In SessionCallbacks:
onContainerAgentWaitingInput?: (event: TypedEvent<ContainerAgentWaitingInput>) => void;
```

#### 3.2 Container Agent Hook (`src/app/hooks/use-container-agent.ts`)
Extend state:
```typescript
interface ContainerAgentState {
  // ... existing fields
  waitingForInput: boolean;
  pendingQuestion?: {
    toolId: string;
    questions: Question[];
  };
}

// Add handler:
const handleWaitingInput = useCallback((data: ContainerAgentWaitingInput) => {
  setState((prev) => ({
    ...prev,
    waitingForInput: true,
    pendingQuestion: {
      toolId: data.toolId,
      questions: data.questions,
    },
  }));
}, []);

// Add sendResponse method (returned from hook):
const sendResponse = useCallback(async (answers: Record<string, string | string[]>) => {
  if (!sessionId) return;
  await apiClient.sessions.sendInput(sessionId, { answers });
  setState((prev) => ({
    ...prev,
    waitingForInput: false,
    pendingQuestion: undefined,
  }));
}, [sessionId]);
```

#### 3.3 Input Component (`src/app/components/features/container-agent-panel/container-agent-input.tsx`)
New component:
```tsx
interface ContainerAgentInputProps {
  questions: Question[];
  onSubmit: (answers: Record<string, string | string[]>) => void;
  isSubmitting: boolean;
}

export function ContainerAgentInput({ questions, onSubmit, isSubmitting }: Props) {
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});

  return (
    <div className="border-t border-border bg-surface-subtle p-4">
      <div className="flex items-center gap-2 mb-3">
        <QuestionMark className="h-4 w-4 text-attention" />
        <span className="font-medium text-sm">Agent is waiting for your input</span>
      </div>

      {questions.map((q, i) => (
        <div key={i} className="mb-4">
          <label className="text-sm font-medium">{q.question}</label>
          <div className="mt-2 space-y-2">
            {q.options.map((opt) => (
              <button
                key={opt.label}
                onClick={() => handleSelect(i, opt.label, q.multiSelect)}
                className={cn(
                  'w-full text-left p-3 rounded border',
                  isSelected(i, opt.label)
                    ? 'border-accent bg-accent/10'
                    : 'border-border hover:bg-surface-muted'
                )}
              >
                <div className="font-medium">{opt.label}</div>
                <div className="text-xs text-fg-muted">{opt.description}</div>
              </button>
            ))}
          </div>
        </div>
      ))}

      <Button onClick={handleSubmit} disabled={isSubmitting}>
        {isSubmitting ? 'Sending...' : 'Submit Answer'}
      </Button>
    </div>
  );
}
```

#### 3.4 Panel Integration (`src/app/components/features/container-agent-panel/container-agent-panel.tsx`)
Add to render:
```tsx
{state.waitingForInput && state.pendingQuestion && (
  <ContainerAgentInput
    questions={state.pendingQuestion.questions}
    onSubmit={sendResponse}
    isSubmitting={isSubmitting}
  />
)}
```

## File Summary

| File | Change Type |
|------|-------------|
| `agent-runner/src/event-emitter.ts` | Modify |
| `agent-runner/src/index.ts` | Modify |
| `src/services/container-agent.service.ts` | Modify |
| `src/services/durable-streams.service.ts` | Modify |
| `src/server/routes/sessions.ts` | Modify |
| `src/lib/streams/client.ts` | Modify |
| `src/app/hooks/use-container-agent.ts` | Modify |
| `src/app/components/features/container-agent-panel/container-agent-input.tsx` | Create |
| `src/app/components/features/container-agent-panel/container-agent-panel.tsx` | Modify |
| `src/app/components/features/container-agent-panel/index.ts` | Modify |

## Testing Plan

1. **Unit Tests**
   - Agent runner input file polling
   - Event emission for waiting_input
   - Service sendInput method

2. **Integration Tests**
   - Full flow: agent asks → UI shows → user answers → agent continues
   - Timeout handling
   - Cancellation while waiting

3. **Manual Testing**
   - Start task that triggers AskUserQuestion
   - Verify questions display correctly
   - Test single and multi-select
   - Test "Other" free-text option
   - Verify agent receives and processes response

## Future Enhancements (Phase 2)

1. **Stdin-based input** - More native, better for streaming input
2. **Conversation history** - Show previous Q&A in session
3. **Input timeout UI** - Show countdown when agent is waiting
4. **Rich input types** - File uploads, code snippets
