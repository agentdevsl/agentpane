/**
 * Types for the configurable system prompts registry
 */

export type PromptCategory =
  | 'agent-execution'
  | 'task-creation'
  | 'terraform-compose'
  | 'workflow-designer'
  | 'skill-improvement';

export interface PromptCategoryInfo {
  id: PromptCategory;
  label: string;
  description: string;
  color: 'claude' | 'accent' | 'success' | 'attention' | 'done';
}

export interface PromptDefinition {
  id: string;
  category: PromptCategory;
  name: string;
  description: string;
  defaultText: string;
  settingsKey: string;
  dynamicVariables: string[];
  wordCount: number;
}
