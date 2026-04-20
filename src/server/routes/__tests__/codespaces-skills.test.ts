/**
 * F07-03: regression coverage for the `{ok:true, data:[]}` masking fix.
 *
 * `GET /api/codespaces/:id/skills` previously swallowed every template merge
 * failure as an empty list. After the fix, infrastructure failures bubble
 * up as `{ok:false, error}` with a meaningful code so the UI can show a
 * recovery signal instead of a silent empty state.
 */

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { err, ok } from '../../../lib/utils/result.js';
import { createCodespacesRoutes } from '../codespaces.js';

function createMockCodespaceService() {
  return {
    list: vi.fn(),
    create: vi.fn(),
    getById: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
}

function createMockTemplateService() {
  return {
    getMergedConfig: vi.fn(),
  };
}

function createTestApp() {
  const codespaceService = createMockCodespaceService();
  const templateService = createMockTemplateService();
  const routes = createCodespacesRoutes({
    codespaceService: codespaceService as never,
    templateService: templateService as never,
    db: {} as never,
  });
  const app = new Hono();
  app.route('/api/codespaces', routes);
  return { app, codespaceService, templateService };
}

describe('F07-03 — GET /api/codespaces/:id/skills does not mask upstream failures', () => {
  it('returns {ok:false, error} when templateService.getMergedConfig fails', async () => {
    const { app, templateService } = createTestApp();
    templateService.getMergedConfig.mockResolvedValue(
      err({ code: 'TEMPLATE_CONFIG_ERROR', message: 'Upstream config unreachable', status: 500 })
    );

    const res = await app.request('/api/codespaces/cs-abc/skills');

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('TEMPLATE_CONFIG_ERROR');
    expect(body.error.message).toContain('unreachable');
  });

  it('returns {ok:true, data:[]} when there are genuinely zero skills configured', async () => {
    const { app, templateService } = createTestApp();
    templateService.getMergedConfig.mockResolvedValue(
      ok({
        skills: [],
        // Minimal shape — the handler only reads `skills`.
      } as never)
    );

    const res = await app.request('/api/codespaces/cs-abc/skills');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toEqual([]);
  });

  it('maps each skill to the wire shape when present', async () => {
    const { app, templateService } = createTestApp();
    templateService.getMergedConfig.mockResolvedValue(
      ok({
        skills: [
          {
            id: 'skill-1',
            name: 'Skill 1',
            description: 'desc',
            tags: ['t1'],
            sourceType: 'template',
            sourceName: 'tpl-1',
            executionSkill: true,
          },
        ],
      } as never)
    );

    const res = await app.request('/api/codespaces/cs-abc/skills');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('skill-1');
  });
});
