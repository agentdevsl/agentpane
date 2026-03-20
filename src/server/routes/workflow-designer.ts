/**
 * Workflow designer routes
 */

import { createId } from '@paralleldrive/cuid2';
import { Hono } from 'hono';
import { z } from 'zod';
import { createLogger } from '../../lib/logging/logger.js';

const log = createLogger('workflow-designer-routes');

import type { CachedAgent, CachedCommand, CachedSkill } from '../../db/schema';
import { agentQuery } from '../../lib/agents/agent-sdk-utils.js';
import { DEFAULT_WORKFLOW_MODEL, getFullModelId } from '../../lib/constants/models.js';
import {
  createWorkflowAnalysisPrompt,
  resolveWorkflowAnalysisPrompt,
  resolveWorkflowGenerationSystemPrompt,
  WORKFLOW_GENERATION_SYSTEM_PROMPT,
} from '../../lib/workflow-dsl/ai-prompts.js';
import { findChainHeadAndTail, layoutWorkflow } from '../../lib/workflow-dsl/layout.js';
import type { Workflow, WorkflowEdge, WorkflowNode } from '../../lib/workflow-dsl/types.js';
import { workflowEdgeSchema, workflowNodeSchema } from '../../lib/workflow-dsl/types.js';
import type { SettingsService } from '../../services/settings.service.js';
import type { TemplateService } from '../../services/template.service.js';
import { json } from '../shared.js';

interface WorkflowDesignerDeps {
  templateService: TemplateService;
  settingsService?: SettingsService;
}

const WORKFLOW_AI_MODEL = process.env.WORKFLOW_AI_MODEL ?? getFullModelId(DEFAULT_WORKFLOW_MODEL);

// Request schema for workflow analysis
const analyzeWorkflowRequestSchema = z
  .object({
    templateId: z.string().optional(),
    skills: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          description: z.string().optional(),
          content: z.string(),
        })
      )
      .optional(),
    commands: z
      .array(
        z.object({
          name: z.string(),
          description: z.string().optional(),
          content: z.string(),
        })
      )
      .optional(),
    agents: z
      .array(
        z.object({
          name: z.string(),
          description: z.string().optional(),
          content: z.string(),
        })
      )
      .optional(),
    name: z.string().optional(),
  })
  .refine(
    (data) =>
      data.templateId ||
      (data.skills && data.skills.length > 0) ||
      (data.commands && data.commands.length > 0) ||
      (data.agents && data.agents.length > 0),
    {
      message: 'Either templateId or at least one of skills, commands, or agents must be provided',
    }
  );

// AI Response schema
const aiWorkflowResponseSchema = z.object({
  nodes: z.array(z.unknown()),
  edges: z.array(z.unknown()),
  aiGenerated: z.boolean().optional(),
  aiConfidence: z.number().min(0).max(1).optional(),
});

/**
 * Builds the template content string from skills, commands, and agents
 */
function buildTemplateContent(
  skills: CachedSkill[],
  commands: CachedCommand[],
  agents: CachedAgent[]
): string {
  const sections: string[] = [];

  if (skills.length > 0) {
    sections.push('## Skills\n');
    for (const skill of skills) {
      sections.push(`### ${skill.name}`);
      if (skill.description) {
        sections.push(skill.description);
      }
      sections.push(`\`\`\`\n${skill.content}\n\`\`\`\n`);
    }
  }

  if (commands.length > 0) {
    sections.push('## Commands\n');
    for (const command of commands) {
      sections.push(`### ${command.name}`);
      if (command.description) {
        sections.push(command.description);
      }
      sections.push(`\`\`\`\n${command.content}\n\`\`\`\n`);
    }
  }

  if (agents.length > 0) {
    sections.push('## Agents\n');
    for (const agent of agents) {
      sections.push(`### ${agent.name}`);
      if (agent.description) {
        sections.push(agent.description);
      }
      sections.push(`\`\`\`\n${agent.content}\n\`\`\`\n`);
    }
  }

  return sections.join('\n');
}

/**
 * Parses and validates the AI response into workflow nodes and edges
 */
function parseAIResponse(responseText: string): {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  aiConfidence: number;
} {
  // Extract JSON from the response (handle markdown code blocks)
  let jsonStr = responseText.trim();
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch?.[1]) {
    jsonStr = jsonMatch[1].trim();
  }

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`Invalid JSON in AI response: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Validate basic structure
  const validated = aiWorkflowResponseSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`Invalid workflow structure: ${validated.error.message}`);
  }

  // Parse and validate individual nodes
  const nodes: WorkflowNode[] = [];
  for (const nodeData of validated.data.nodes) {
    const nodeResult = workflowNodeSchema.safeParse(nodeData);
    if (nodeResult.success) {
      nodes.push(nodeResult.data);
    } else {
      log.warn('Skipping invalid node', { data: { error: nodeResult.error.message, nodeData } });
    }
  }

  // Parse and validate individual edges
  const edges: WorkflowEdge[] = [];
  for (const edgeData of validated.data.edges) {
    const edgeResult = workflowEdgeSchema.safeParse(edgeData);
    if (edgeResult.success) {
      edges.push(edgeResult.data);
    } else {
      log.warn('Skipping invalid edge', { data: { error: edgeResult.error.message, edgeData } });
    }
  }

  // Remove edges referencing non-existent nodes (AI sometimes generates
  // edges to node IDs it didn't include in the nodes array)
  const validNodeIds = new Set(nodes.map((n) => n.id));
  for (let i = edges.length - 1; i >= 0; i--) {
    const e = edges[i];
    if (e && (!validNodeIds.has(e.sourceNodeId) || !validNodeIds.has(e.targetNodeId))) {
      log.warn(`Removing edge to non-existent node: ${e.sourceNodeId} -> ${e.targetNodeId}`);
      edges.splice(i, 1);
    }
  }

  // Ensure we have at least start and end nodes
  if (nodes.length === 0) {
    throw new Error('AI generated no valid nodes');
  }

  const hasStart = nodes.some((n) => n.type === 'start');
  const hasEnd = nodes.some((n) => n.type === 'end');

  // Auto-generate start/end nodes if missing
  if (!hasStart) {
    log.warn('AI did not generate start node, adding one');
    nodes.unshift({
      id: `start-${createId().slice(0, 8)}`,
      type: 'start',
      label: 'Start',
      position: { x: 0, y: 0 },
      inputs: [],
    });
  }

  if (!hasEnd) {
    log.warn('AI did not generate end node, adding one');
    nodes.push({
      id: `end-${createId().slice(0, 8)}`,
      type: 'end' as const,
      label: 'End',
      position: { x: 0, y: 0 },
      outputs: [],
    });
  }

  // Ensure start and end nodes are properly connected to the workflow chain.
  // The AI often generates start/end nodes but either omits the connecting
  // edges or connects them to the wrong nodes (e.g., start → third node
  // instead of start → first node), causing ELK layout issues.
  const startNode = nodes.find((n) => n.type === 'start');
  const endNode = nodes.find((n) => n.type === 'end');
  const nonStartEndNodes = nodes.filter((n) => n.type !== 'start' && n.type !== 'end');

  // Use edge topology to find the actual first/last nodes in the chain,
  // rather than relying on array order (AI may return nodes in any order).
  if (nonStartEndNodes.length > 0) {
    const { head: firstNode, tail: lastNode } = findChainHeadAndTail(nonStartEndNodes, edges);

    if (startNode) {
      const hasCorrectStartEdge = edges.some(
        (e) => e.sourceNodeId === startNode.id && e.targetNodeId === firstNode.id
      );
      if (!hasCorrectStartEdge) {
        const startEdgeCount = edges.filter((e) => e.sourceNodeId === startNode.id).length;
        if (startEdgeCount > 0) {
          log.warn('Replacing incorrect start edges');
          for (let i = edges.length - 1; i >= 0; i--) {
            if (edges[i]?.sourceNodeId === startNode.id) {
              edges.splice(i, 1);
            }
          }
        }
        edges.unshift({
          id: `edge-start-${createId().slice(0, 8)}`,
          type: 'sequential',
          sourceNodeId: startNode.id,
          targetNodeId: firstNode.id,
        });
      }
    }

    if (endNode) {
      const hasCorrectEndEdge = edges.some(
        (e) => e.sourceNodeId === lastNode.id && e.targetNodeId === endNode.id
      );
      if (!hasCorrectEndEdge) {
        const endEdgeCount = edges.filter((e) => e.targetNodeId === endNode.id).length;
        if (endEdgeCount > 0) {
          log.warn('Replacing incorrect end edges');
          for (let i = edges.length - 1; i >= 0; i--) {
            if (edges[i]?.targetNodeId === endNode.id) {
              edges.splice(i, 1);
            }
          }
        }
        edges.push({
          id: `edge-end-${createId().slice(0, 8)}`,
          type: 'sequential',
          sourceNodeId: lastNode.id,
          targetNodeId: endNode.id,
        });
      }
    }
  }

  // Graph connectivity check — ensure all nodes are reachable from Start.
  // BFS from Start, then connect any unreachable nodes from their
  // array-order predecessor, then fix the End edge from the true chain tail.
  if (startNode && nonStartEndNodes.length > 1) {
    const adjacency = new Map<string, Set<string>>();
    for (const edge of edges) {
      if (!adjacency.has(edge.sourceNodeId)) {
        adjacency.set(edge.sourceNodeId, new Set());
      }
      adjacency.get(edge.sourceNodeId)?.add(edge.targetNodeId);
    }

    // BFS from start
    const reachable = new Set<string>();
    const queue: string[] = [startNode.id];
    reachable.add(startNode.id);
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) break;
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!reachable.has(neighbor)) {
          reachable.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    // Connect ALL unreachable nodes from their array-order predecessor.
    // No isolated/non-isolated distinction — this avoids fork bugs where
    // an "isolated" node gets both a repair edge and an End edge.
    for (let i = 0; i < nonStartEndNodes.length; i++) {
      const node = nonStartEndNodes[i];
      if (!node || reachable.has(node.id)) continue;

      const predecessor = i === 0 ? startNode : nonStartEndNodes[i - 1];
      if (!predecessor) continue;

      const exists = edges.some(
        (e) => e.sourceNodeId === predecessor.id && e.targetNodeId === node.id
      );
      if (!exists) {
        log.warn(`Node "${node.label}" unreachable, connecting from "${predecessor.label}"`);
        edges.push({
          id: `edge-connect-${createId().slice(0, 8)}`,
          type: 'sequential',
          sourceNodeId: predecessor.id,
          targetNodeId: node.id,
        });
        if (!adjacency.has(predecessor.id)) adjacency.set(predecessor.id, new Set());
        adjacency.get(predecessor.id)?.add(node.id);
      }

      // Mark node + its downstream subtree as reachable
      reachable.add(node.id);
      const subQueue = [node.id];
      while (subQueue.length > 0) {
        const sub = subQueue.shift();
        if (!sub) break;
        for (const neighbor of adjacency.get(sub) ?? []) {
          if (!reachable.has(neighbor)) {
            reachable.add(neighbor);
            subQueue.push(neighbor);
          }
        }
      }
    }

    // After all connectivity repairs, recompute the true chain tail and
    // ensure End connects from it. This avoids forks where an intermediate
    // node has both a downstream edge and an End edge.
    if (endNode) {
      const { tail: trueTail } = findChainHeadAndTail(nonStartEndNodes, edges);
      const hasCorrectEndEdge = edges.some(
        (e) => e.sourceNodeId === trueTail.id && e.targetNodeId === endNode.id
      );
      if (!hasCorrectEndEdge) {
        // Remove all existing edges to End
        for (let i = edges.length - 1; i >= 0; i--) {
          if (edges[i]?.targetNodeId === endNode.id) {
            edges.splice(i, 1);
          }
        }
        log.warn(`Re-pointing End edge from "${trueTail.label}"`);
        edges.push({
          id: `edge-end-final-${createId().slice(0, 8)}`,
          type: 'sequential',
          sourceNodeId: trueTail.id,
          targetNodeId: endNode.id,
        });
      }
      reachable.add(endNode.id);
    }
  }

  return {
    nodes,
    edges,
    aiConfidence: validated.data.aiConfidence ?? 0.5,
  };
}

export function createWorkflowDesignerRoutes({
  templateService,
  settingsService,
}: WorkflowDesignerDeps) {
  const app = new Hono();

  // POST /api/workflow-designer/analyze
  app.post('/analyze', async (c) => {
    // Parse request body
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return json(
        { ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON in request body' } },
        400
      );
    }

    // Validate request
    const parseResult = analyzeWorkflowRequestSchema.safeParse(body);
    if (!parseResult.success) {
      return json(
        {
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: parseResult.error.message },
        },
        400
      );
    }

    const { templateId, skills, commands, agents: agentsData, name } = parseResult.data;

    // Gather template data
    let templateSkills: CachedSkill[] = (skills as CachedSkill[]) ?? [];
    let templateCommands: CachedCommand[] = (commands as CachedCommand[]) ?? [];
    let templateAgents: CachedAgent[] = (agentsData as CachedAgent[]) ?? [];
    let templateName = name ?? 'Generated Workflow';
    let templateDescription: string | undefined;

    // If templateId provided, fetch template from database
    if (templateId) {
      const templateResult = await templateService.getById(templateId);
      if (!templateResult.ok) {
        return json(
          { ok: false, error: { code: 'TEMPLATE_NOT_FOUND', message: 'Template not found' } },
          404
        );
      }

      const template = templateResult.value;
      templateName = template.name;
      templateDescription = template.description ?? undefined;
      templateSkills = template.cachedSkills ?? [];
      templateCommands = template.cachedCommands ?? [];
      templateAgents = template.cachedAgents ?? [];
    }

    // Ensure we have content to analyze
    if (
      templateSkills.length === 0 &&
      templateCommands.length === 0 &&
      templateAgents.length === 0
    ) {
      return json(
        {
          ok: false,
          error: {
            code: 'WORKFLOW_NO_CONTENT',
            message:
              'No template content provided. Provide either templateId or skills/commands/agents data.',
          },
        },
        400
      );
    }

    // Build template content and prompt
    const templateContent = buildTemplateContent(templateSkills, templateCommands, templateAgents);

    const analysisInput = {
      name: templateName,
      description: templateDescription,
      content: templateContent,
      skills: templateSkills.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
      })),
      commands: templateCommands.map((c) => ({
        name: c.name,
        command: c.content,
        description: c.description,
      })),
      agents: templateAgents.map((a) => ({
        id: a.name,
        name: a.name,
        description: a.description,
        systemPrompt: a.content,
      })),
    };
    const userPrompt = settingsService
      ? await resolveWorkflowAnalysisPrompt(analysisInput, settingsService)
      : createWorkflowAnalysisPrompt(analysisInput);

    // Use Claude Agent SDK
    let aiResponse: string;
    try {
      const systemPrompt = settingsService
        ? await resolveWorkflowGenerationSystemPrompt(settingsService)
        : WORKFLOW_GENERATION_SYSTEM_PROMPT;
      const fullPrompt = `${systemPrompt}\n\n---\n\n${userPrompt}`;
      const result = await agentQuery(fullPrompt, { model: WORKFLOW_AI_MODEL });
      aiResponse = result.text;

      if (!aiResponse) {
        return json(
          {
            ok: false,
            error: { code: 'WORKFLOW_AI_GENERATION_FAILED', message: 'Empty response from AI' },
          },
          500
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Agent SDK error', { data: { message } });

      // Check for authentication errors
      if (
        message.includes('401') ||
        message.includes('authentication_error') ||
        message.includes('invalid x-api-key') ||
        message.includes('ANTHROPIC_API_KEY')
      ) {
        return json(
          {
            ok: false,
            error: {
              code: 'WORKFLOW_API_KEY_NOT_FOUND',
              message:
                'Anthropic API key not configured. Please set ANTHROPIC_API_KEY environment variable.',
            },
          },
          401
        );
      }

      return json({ ok: false, error: { code: 'WORKFLOW_AI_GENERATION_FAILED', message } }, 500);
    }

    // Parse AI response into workflow structure
    let nodes: WorkflowNode[];
    let edges: WorkflowEdge[];
    let aiConfidence: number;

    try {
      const result = parseAIResponse(aiResponse);
      nodes = result.nodes;
      edges = result.edges;
      aiConfidence = result.aiConfidence;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('AI response parsing error', { data: { message } });
      return json({ ok: false, error: { code: 'WORKFLOW_INVALID_AI_RESPONSE', message } }, 422);
    }

    // Apply ELK layout to position nodes
    try {
      nodes = await layoutWorkflow(nodes, edges, {
        algorithm: 'layered',
        direction: 'DOWN',
        nodeWidth: 200,
        nodeHeight: 60,
        nodeSpacing: 50,
        layerSpacing: 80,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Layout error', { data: { message } });
      return json({ ok: false, error: { code: 'WORKFLOW_LAYOUT_FAILED', message } }, 500);
    }

    // Build final workflow object
    // Convert aiConfidence from 0-1 float to 0-100 integer for database storage
    const aiConfidencePercent = Math.round(aiConfidence * 100);

    const workflow: Workflow = {
      id: createId(),
      name: templateName,
      description: templateDescription,
      nodes,
      edges,
      sourceTemplateId: templateId,
      sourceTemplateName: templateName,
      status: 'draft',
      aiGenerated: true,
      aiModel: WORKFLOW_AI_MODEL,
      aiConfidence: aiConfidencePercent,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    return json({ ok: true, data: { workflow } }, 200);
  });

  return app;
}
