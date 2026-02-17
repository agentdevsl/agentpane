# AgentConfigDialog Component Specification

## Overview

The AgentConfigDialog allows users to configure agent execution parameters before starting a task or when creating/editing an agent. It provides controls for execution limits, model selection, allowed tools, and advanced settings.

**Related Wireframes:**

- [Agent Config Dialog](../wireframes/agent-config-dialog.html) - Complete dialog with all configuration options

---

## Interface Definition

```typescript
// app/components/dialogs/agent-config/types.ts
import type { Result } from '@/lib/utils/result';
import type { AgentConfig } from '@/lib/services/agent-service.types';

// ===== Component Props =====
export interface AgentConfigDialogProps {
  /** Whether the dialog is open */
  open: boolean;
  /** Callback when dialog closes */
  onOpenChange: (open: boolean) => void;
  /** Agent ID to edit (undefined for new agent) */
  agentId?: string;
  /** Project ID for context */
  projectId: string;
  /** Initial config values */
  initialConfig?: Partial<AgentConfig>;
  /** Callback when config is saved */
  onSave: (config: AgentConfig) => void;
  /** Callback when config is cancelled */
  onCancel?: () => void;
}

// ===== Agent Config =====
export interface AgentConfig {
  /** Display name for the agent */
  name: string;
  /** Agent type */
  type: 'task' | 'conversational' | 'background';
  /** Maximum turns before stopping */
  maxTurns: number;
  /** Model to use */
  model: 'claude-sonnet' | 'claude-opus' | 'claude-haiku';
  /** Temperature (0-1) */
  temperature: number;
  /** Allowed tools */
  allowedTools: string[];
  /** Custom system prompt */
  systemPrompt?: string;
  /** Whether to auto-start on task assignment */
  autoStart: boolean;
  /** Whether to create PR on completion */
  createPROnComplete: boolean;
}

// ===== Default Values =====
export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  name: 'New Agent',
  type: 'task',
  maxTurns: 50,
  model: 'claude-sonnet',
  temperature: 0.7,
  allowedTools: ['Read', 'Edit', 'Bash', 'Glob', 'Grep', 'Write'],
  systemPrompt: undefined,
  autoStart: true,
  createPROnComplete: false,
};

// ===== Tool Categories =====
export const TOOL_CATEGORIES = {
  'File Operations': ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
  'System': ['Bash', 'Task'],
  'Web': ['WebFetch', 'WebSearch'],
  'MCP': [], // Dynamically populated
} as const;
```

---

## Component Specifications

### AgentConfigDialog (Container)

```typescript
// app/components/dialogs/agent-config/index.tsx
export interface AgentConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId?: string;
  projectId: string;
  initialConfig?: Partial<AgentConfig>;
  onSave: (config: AgentConfig) => void;
  onCancel?: () => void;
}
```

#### Props

| Prop | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `open` | `boolean` | Yes | - | Controls dialog visibility |
| `onOpenChange` | `(open: boolean) => void` | Yes | - | Callback when visibility changes |
| `agentId` | `string` | No | - | Agent ID when editing existing agent |
| `projectId` | `string` | Yes | - | Project context for tools |
| `initialConfig` | `Partial<AgentConfig>` | No | - | Initial config values |
| `onSave` | `(config: AgentConfig) => void` | Yes | - | Called when user saves |
| `onCancel` | `() => void` | No | - | Called when user cancels |

#### State

| State | Type | Initial | Description |
|-------|------|---------|-------------|
| `config` | `AgentConfig` | `DEFAULT_AGENT_CONFIG` | Current configuration |
| `errors` | `Record<string, string>` | `{}` | Field validation errors |
| `isDirty` | `boolean` | `false` | Whether form has unsaved changes |

---

### Dialog Layout

```
┌─────────────────────────────────────────────────────────────┐
│  [Icon] Configure Agent                              [×]    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─ Execution Settings ──────────────────────────────────┐  │
│  │                                                       │  │
│  │  Max Turns         [========o============] 50         │  │
│  │                    Agent stops after 50 turns         │  │
│  │                                                       │  │
│  │  Model             [▼ Claude Sonnet 4.6         ]     │  │
│  │                    Balanced speed and capability      │  │
│  │                                                       │  │
│  │  Temperature       [======o==================] 0.7    │  │
│  │                    Controls response creativity       │  │
│  │                                                       │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─ Tool Permissions ────────────────────────────────────┐  │
│  │                                                       │  │
│  │  File Operations                                      │  │
│  │  [✓] Read  [✓] Edit  [✓] Write  [✓] Glob  [✓] Grep   │  │
│  │                                                       │  │
│  │  System                                               │  │
│  │  [✓] Bash  [ ] Task                                   │  │
│  │                                                       │  │
│  │  Web                                                  │  │
│  │  [ ] WebFetch  [ ] WebSearch                          │  │
│  │                                                       │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─ Behavior ────────────────────────────────────────────┐  │
│  │                                                       │  │
│  │  [✓] Auto-start when task is assigned                 │  │
│  │  [ ] Create PR when agent completes                   │  │
│  │                                                       │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─ System Prompt (Optional) ────────────────────────────┐  │
│  │  ┌─────────────────────────────────────────────────┐  │  │
│  │  │ Enter custom instructions for the agent...      │  │  │
│  │  │                                                 │  │  │
│  │  └─────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                          [Cancel]  [Save Configuration]     │
└─────────────────────────────────────────────────────────────┘
```

---

### ExecutionSettingsSection

```typescript
// app/components/dialogs/agent-config/sections/execution-settings.tsx
export interface ExecutionSettingsSectionProps {
  maxTurns: number;
  model: AgentConfig['model'];
  temperature: number;
  onMaxTurnsChange: (value: number) => void;
  onModelChange: (value: AgentConfig['model']) => void;
  onTemperatureChange: (value: number) => void;
}
```

#### Max Turns Slider

| Property | Value |
|----------|-------|
| Min | 10 |
| Max | 500 |
| Step | 10 |
| Default | 50 |
| Track color | `bg-slate-700` |
| Fill color | `bg-blue-500` |
| Thumb | 16px circle, blue |

#### Model Select

| Model | Label | Description |
|-------|-------|-------------|
| `claude-haiku` | Claude Haiku | Fast and efficient for simple tasks |
| `claude-sonnet` | Claude Sonnet 4.6 | Balanced speed and capability |
| `claude-opus` | Claude Opus 4 | Most capable for complex tasks |

#### Temperature Slider

| Property | Value |
|----------|-------|
| Min | 0 |
| Max | 1 |
| Step | 0.1 |
| Default | 0.7 |
| Labels | "Precise" (0) to "Creative" (1) |

---

### ToolPermissionsSection

```typescript
// app/components/dialogs/agent-config/sections/tool-permissions.tsx
export interface ToolPermissionsSectionProps {
  allowedTools: string[];
  availableTools: string[];
  onToolsChange: (tools: string[]) => void;
}
```

#### Layout

| Property | Value |
|----------|-------|
| Grid | 5 columns for tool checkboxes |
| Category spacing | 16px gap |
| Checkbox size | 16px |
| Label | 14px, medium weight |

#### Tool Checkbox States

| State | Background | Border | Check |
|-------|------------|--------|-------|
| Unchecked | `bg-slate-800` | `border-slate-600` | None |
| Checked | `bg-blue-500` | `border-blue-500` | White checkmark |
| Disabled | `bg-slate-900` | `border-slate-700` | Muted |

---

### BehaviorSection

```typescript
// app/components/dialogs/agent-config/sections/behavior.tsx
export interface BehaviorSectionProps {
  autoStart: boolean;
  createPROnComplete: boolean;
  onAutoStartChange: (value: boolean) => void;
  onCreatePRChange: (value: boolean) => void;
}
```

#### Toggle Layout

| Property | Value |
|----------|-------|
| Row height | 48px |
| Toggle track | 44px × 24px |
| Toggle thumb | 20px circle |
| Off color | `bg-slate-700` |
| On color | `bg-green-500` |

---

### SystemPromptSection

```typescript
// app/components/dialogs/agent-config/sections/system-prompt.tsx
export interface SystemPromptSectionProps {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  maxLength?: number;
}
```

#### Textarea Properties

| Property | Value |
|----------|-------|
| Min height | 100px |
| Max height | 200px |
| Font | Monospace, 13px |
| Placeholder | "Enter custom instructions for the agent..." |
| Character counter | Bottom right, muted |

---

## Validation Rules

| Field | Rule | Error Message |
|-------|------|---------------|
| `name` | Required, 1-100 chars | "Agent name is required" |
| `maxTurns` | 10-500 | "Max turns must be between 10 and 500" |
| `temperature` | 0-1 | "Temperature must be between 0 and 1" |
| `allowedTools` | At least one required | "At least one tool must be enabled" |
| `systemPrompt` | Max 10,000 chars | "System prompt exceeds maximum length" |

---

## Business Rules

| Rule | Description |
|------|-------------|
| **Tool inheritance** | Project-level tool restrictions override agent config |
| **Model availability** | Models shown based on API key permissions |
| **PR creation** | Requires GitHub integration to be enabled |
| **Auto-start** | Only applies when agent is in idle state |
| **Config persistence** | Config saved to agent record in database |

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Escape` | Close dialog (with unsaved warning if dirty) |
| `Cmd/Ctrl + S` | Save configuration |
| `Tab` | Navigate between fields |

---

## Accessibility

| Feature | Implementation |
|---------|----------------|
| Focus trap | Focus contained within dialog |
| Label association | All inputs have associated labels |
| Error announcement | ARIA live region for validation errors |
| Slider accessibility | ARIA valuemin, valuemax, valuenow |

---

## Error Conditions

| Condition | Error Code | UI Behavior |
|-----------|------------|-------------|
| Validation failed | `VALIDATION_ERROR` | Show inline field errors |
| Save failed | `AGENT_CONFIG_INVALID` | Show toast, keep dialog open |
| Agent not found | `AGENT_NOT_FOUND` | Close dialog, show error toast |

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Agent Service](../services/agent-service.md) | Agent CRUD, config validation |
| [Config Management](../configuration/config-management.md) | Project config hierarchy |
| [Form Inputs](./form-inputs.md) | Input components |
| [Error Catalog](../errors/error-catalog.md) | `AGENT_*` error codes |
