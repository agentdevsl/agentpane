# Live Task View — Topology Fix

## Problem

The Live Task View's center panel showed "Loading session data..." indefinitely or "No subagent topology yet" even for tasks with active sessions that had topology visible in the Sessions view.

## Test Task: TSK-LA6

Use this task to verify the fix:

```
Task ID:          e8qzop5ytladd1vxmot3rla6
Title:            Build AWS Terraform Module with Documentation
Display ID:       #TSK-LA6
Column:           waiting_approval (Review)
Priority:         high
Agent Status:     planning (plan ready for review)
Branch:           build-aws-terraform-module-with-document-e8qzop
Session ID:       apmjqtzbb2pi35a10gd36glv
Agent ID:         agent-e8qzop5ytladd1vxmot3rla6
Codespace ID:     uazd4r8bs2adjwcrhzns1bxj (agentpane)
Codespace:        Test folder
```

### Session Details

```
Session ID:       apmjqtzbb2pi35a10gd36glv
Status:           active
Sandbox Provider: kubernetes
Container ID:     agentpane-default-la4lnj8r
Created:          2026-03-17T04:42:09.587Z
```

### Session Events (35 total)

This is a **container-agent session** (Kubernetes sandbox), NOT a direct SDK session. It emits `container-agent:*` events, not `topology:*` events.

Event breakdown:

- `container-agent:status` × 8 (initializing → validating → credentials → creating_sandbox → executing → running)
- `container-agent:message` × 16 (system messages + assistant responses)
- `container-agent:started` × 2 (agent launch confirmation with model info)
- `container-agent:tool:start` × 4 (Bash commands: ls, find, etc.)
- `container-agent:tool:result` × 4 (tool completions)
- `container-agent:plan_ready` × 1 (plan generated, awaiting approval)

Key events in order:

1. `container-agent:status` — Initializing, Validating, Authenticating
2. `container-agent:status` — Creating sandbox, Cloning repository
3. `container-agent:started` — model=claude-opus-4-6, maxTurns=50, sandboxProvider=kubernetes
4. `container-agent:tool:start` — Bash: `ls -la /workspace/`
5. `container-agent:tool:start` — Bash: `find /workspace -maxdepth 1 -type f`
6. `container-agent:message` — "Let me read the key files..."
7. `container-agent:tool:start` — ExitPlanMode (plan submission)
8. `container-agent:plan_ready` — Plan: AWS VPC Terraform Module

### Why This Task Is Relevant

TSK-LA6 represents the most common session type in AgentPane — a container-agent running in a Kubernetes sandbox. These sessions:

- Do NOT emit `topology:agent_spawned` events (only SDK direct sessions do)
- DO emit `container-agent:started`, `container-agent:tool:start`, `container-agent:plan_ready`
- Show full topology in the Sessions view (`/sessions/apmjqtzbb2pi35a10gd36glv`) because `AgentSessionView` handles streaming differently
- Previously showed nothing in the Live Task View because the topology system only listened for `topology:*` events

### How to Test

1. Navigate to: `http://localhost:3000/codespaces/uazd4r8bs2adjwcrhzns1bxj`
2. Click the **Live** toggle in the header
3. Select **"Build AWS Terraform Module wi..."** (#TSK-LA6) in the task list
4. The center panel should show:
   - Task title: "Build AWS Terraform Module with Documentation"
   - Status pipeline: Backlog → Queued → In Progress → **Review** → Done
   - A topology node representing the root agent (claude-opus-4-6) with:
     - Status: verifying (amber/yellow — plan ready)
     - Progress: ~80%
     - Tool turns: 4
     - Messages: 16
5. The right panel should show the audit trail:
   - Events tab: "Task created", "Moved to In Progress", "Agent assigned", "Plan ready for review"
   - Stream tab: "Connected to session apmjqtzbb2pi..."

### Sessions View Comparison

The same session renders topology correctly at:
`http://localhost:3000/sessions?codespaceId=uazd4r8bs2adjwcrhzns1bxj`

Click into session `apmjqtzbb2pi35a10gd36glv` → Topology tab shows the agent flow.

---

## Root Causes

### 1. API Response Shape Mismatch

The `apiClient.sessions.getEvents()` returns different response shapes depending on the limit:

- With small `limit` (e.g., 5): `{ ok: true, data: { data: [...], pagination: {...} } }`
- With large `limit` (e.g., 500) or default: `{ ok: true, data: [...] }` (flat array)

The component code was doing `result.data.data` which returns `undefined` when `result.data` is already the array.

**Fix** (`src/app/components/features/live-task-view/index.tsx`):

```typescript
// Handle both response shapes: {data: [...], pagination} or flat [...]
const rawData = result.data as
  | { data: Array<{ id: string; type: string; timestamp: number; data: unknown }> }
  | Array<{ id: string; type: string; timestamp: number; data: unknown }>;
const events = Array.isArray(rawData) ? rawData : rawData.data;
```

### 2. Container-Agent Sessions Have No Topology Events

Sessions running via container agents (Docker/Kubernetes sandbox) emit `container-agent:*` events, NOT `topology:agent_spawned/progress/completed` events. The topology system only listened for `topology:*` events, so container-agent sessions showed empty topologies.

**Fix — SSE live stream** (`src/app/hooks/use-topology-stream.ts`):

Added callbacks for container-agent events in the `useTopologyStream` hook:

```typescript
onContainerAgentStarted: (event) => {
  // Create a root topology node from the container-agent start event
  const node: TopologyNode = {
    id: `agent-${data.taskId}`,
    name: data.model ?? 'Agent',
    role: 'coder',
    status: 'running',
    // ...
  };
  dispatch({ type: 'ADD_NODE', node });
},
onContainerAgentComplete: (event) => {
  dispatch({ type: 'COMPLETE_NODE', nodeId, status: 'completed', completedAt: Date.now() });
},
onContainerAgentError: (event) => {
  dispatch({ type: 'COMPLETE_NODE', nodeId, status: 'failed', completedAt: Date.now() });
},
```

**Fix — historical event fetch** (`src/app/components/features/live-task-view/index.tsx`):

Added parsing for container-agent events when building `initialData`:

- `container-agent:started` → creates root topology node with model name
- `container-agent:tool:start` → increments tool count, estimates tokens (500/tool) and progress (10%/tool)
- `container-agent:message` → increments message count
- `container-agent:plan_ready` → sets status to `verifying`, progress to 80%

### 3. Fallback Root Node

If no `topology:*` or `container-agent:started` events are found, the component creates a root agent node from task metadata:

- `agentId` from task or generated from task ID
- `status` derived from task column (in_progress → running, verified → completed, etc.)
- `lastAgentStatus` mapped (planning → verifying)
- Progress estimated from tool event count

### 4. Topology Not Picking Up initialData

The `TopologyProvider` (`src/app/components/features/agent-topology/topology-context.tsx`) only uses `initialData` in the `useReducer` initial state — it's evaluated once on mount.

If the `AgentTopology` component mounts before the async event fetch completes, `initialData` is `undefined` and the topology shows empty. The `TopologyProvider` does have a `useWatchEffect` that syncs `initialData` changes via `REPLACE_GRAPH`, but only when the reference changes after mount.

**Fix**:

1. Gate rendering: only render `<AgentTopology>` when `topologyData` is defined (show "Loading session data..." while fetching)
2. Add `key={selectedTask.sessionId}` to force full remount when switching tasks — ensures `TopologyProvider` gets fresh `initialData` on its initial render

```tsx
{selectedTask.sessionId && topologyData ? (
  <div key={selectedTask.sessionId}>
    <AgentTopology sessionId={selectedTask.sessionId} initialData={topologyData} />
  </div>
) : selectedTask.sessionId && !topologyData ? (
  <div>Loading session data...</div>
) : (
  <div>No agent session for this task</div>
)}
```

## Files Changed

| File | Change |
|------|--------|
| `src/app/components/features/live-task-view/index.tsx` | Handle both API response shapes, parse container-agent events, create root node fallback, key-based remount |
| `src/app/hooks/use-topology-stream.ts` | Add `onContainerAgentStarted/Complete/Error` SSE callbacks to create root topology nodes for container-agent sessions |
| `docs/live-task-view-topology-fix.md` | This document |

## Architecture Context

### Two Types of Agent Sessions

1. **SDK Sessions** (direct Claude Agent SDK):
   - Events: `topology:agent_spawned`, `topology:agent_progress`, `topology:agent_completed`
   - Full sub-agent hierarchy with parent-child relationships
   - Used when running agents directly (not in sandbox)

2. **Container-Agent Sessions** (Docker/Kubernetes sandbox):
   - Events: `container-agent:started`, `container-agent:tool:start/result`, `container-agent:message`, `container-agent:plan_ready`, `container-agent:complete`
   - Single root agent (no sub-agent hierarchy visible — sub-agents run inside the container)
   - Used when `sandbox.enabled = true` in codespace settings
   - Most common in production (TSK-LA6 uses this)

### Data Flow

```
Session Events (SSE / API)
  │
  ├─ topology:agent_spawned ──→ useTopologyStream ──→ ADD_NODE dispatch
  ├─ topology:agent_progress ─→ useTopologyStream ──→ UPDATE_NODE dispatch
  ├─ topology:agent_completed → useTopologyStream ──→ COMPLETE_NODE dispatch
  │
  ├─ container-agent:started ─→ useTopologyStream ──→ ADD_NODE (root node)
  ├─ container-agent:complete → useTopologyStream ──→ COMPLETE_NODE
  ├─ container-agent:error ───→ useTopologyStream ──→ COMPLETE_NODE (failed)
  │
  └─ Historical events ───────→ fetchTopologyFromEvents() ──→ setTopologyData()
                                                                    │
                                                              initialData prop
                                                                    │
                                                              TopologyProvider
                                                                    │
                                                              AgentTopology (React Flow)
```

### Where the Sessions View Works Differently

The Sessions view (`/sessions/$sessionId`) renders topology via `AgentSessionView` which:

1. Subscribes to the full SSE stream with ALL event types
2. Maintains its own event state and routes events to multiple consumers
3. The `AgentTopology` inside it does NOT receive `sessionId` — it gets data from the parent context
4. This avoids duplicate SSE connections (the comment in `topology-context.tsx` line 210-213 explains this)

The Live Task View uses `AgentTopology` standalone with `sessionId` prop, which triggers its own `useTopologyStream` subscription. This is correct for standalone usage but requires the stream to emit topology-compatible events.
