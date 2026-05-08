import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGitHubAppRoutes } from '../../src/server/routes/github-app';

/**
 * Integration tests for the GitHub App API routes.
 *
 * Covers status, manifest creation, setup-callback (success/failure paths),
 * installation list/register/delete, codespace configuration, and credential
 * deletion. The setup-callback path mocks `fetch` to simulate the GitHub
 * manifest exchange.
 */

const jsonRequest = (url: string, body: unknown, init?: RequestInit): Request =>
  new Request(url, {
    ...init,
    method: init?.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
  });

const ok = <T>(value: T) => ({ ok: true as const, value });
const err = (code: string, message: string, status = 400) => ({
  ok: false as const,
  error: { code, message, status },
});

function createMockGitHubAppService() {
  return {
    getCredentials: vi.fn(),
    saveCredentials: vi.fn(),
    deleteCredentials: vi.fn(),
    listInstallations: vi.fn(),
    handleInstallation: vi.fn(),
    removeInstallation: vi.fn(),
    autoConfigureEventsForCodespace: vi.fn(),
    getAppOctokitFromCredentials: vi.fn(),
    isConfigured: vi.fn(),
  };
}

describe('GitHubApp Routes (IT-1760)', () => {
  let app: Hono;
  let svc: ReturnType<typeof createMockGitHubAppService>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    svc = createMockGitHubAppService();
    app = createGitHubAppRoutes({ githubAppService: svc as never });
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = originalFetch;
  });

  // ─── GET /status ─────────────────────────────────────

  it('IT-1760-1: GET /status returns configured=false when no credentials', async () => {
    svc.getCredentials.mockResolvedValue(null);
    const res = await app.request('http://localhost/status');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.configured).toBe(false);
    expect(body.data.installUrl).toBeNull();
    expect(body.data.appSlug).toBeNull();
  });

  it('IT-1760-2: GET /status returns configured=true with install URL when configured', async () => {
    svc.getCredentials.mockResolvedValue({ appId: '123', appSlug: 'my-app' });
    const res = await app.request('http://localhost/status');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.configured).toBe(true);
    expect(body.data.appSlug).toBe('my-app');
    expect(body.data.installUrl).toContain('my-app');
  });

  it('IT-1760-3: GET /status returns null installUrl when appSlug missing', async () => {
    svc.getCredentials.mockResolvedValue({ appId: '123' });
    const res = await app.request('http://localhost/status');
    const body = await res.json();
    expect(body.data.installUrl).toBeNull();
  });

  // ─── POST /manifest ──────────────────────────────────

  it('IT-1760-4: POST /manifest rejects malformed body', async () => {
    const res = await app.request(jsonRequest('http://localhost/manifest', {}));
    expect(res.status).toBe(400);
  });

  it('IT-1760-5: POST /manifest rejects bad URL', async () => {
    const res = await app.request(
      jsonRequest('http://localhost/manifest', { externalUrl: 'not-a-url' })
    );
    expect(res.status).toBe(400);
  });

  it('IT-1760-6: POST /manifest returns manifest, state cookie, and GitHub URL', async () => {
    const res = await app.request(
      jsonRequest('http://localhost/manifest', {
        externalUrl: 'https://app.example.com',
        appName: 'TestApp',
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.manifest).toBeTruthy();
    expect(body.data.state).toMatch(/^[a-f0-9]{32}$/);
    expect(body.data.githubUrl).toContain(`state=${body.data.state}`);
    // Bug-fix regression guard: previously the route used `c.header()` to set
    // the github_app_state cookie, but then returned a fresh Response from
    // `json()` which silently dropped the header — breaking OAuth state
    // verification. Now the cookie is set directly on the returned Response.
    const setCookie = res.headers.get('Set-Cookie');
    expect(setCookie).toContain(`github_app_state=${body.data.state}`);
    expect(setCookie).toContain('HttpOnly');

    // Manifest contains correct URLs
    const parsedManifest = JSON.parse(body.data.manifest);
    expect(parsedManifest.name).toBe('TestApp');
    expect(parsedManifest.url).toBe('https://app.example.com');
    expect(parsedManifest.hook_attributes.url).toBe('https://app.example.com/hooks/github-app');
  });

  it('IT-1760-7: POST /manifest defaults appName to AgentPane', async () => {
    const res = await app.request(
      jsonRequest('http://localhost/manifest', { externalUrl: 'https://app.example.com' })
    );
    const body = await res.json();
    const parsedManifest = JSON.parse(body.data.manifest);
    expect(parsedManifest.name).toBe('AgentPane');
  });

  // ─── POST /setup-callback ────────────────────────────

  it('IT-1760-8: POST /setup-callback rejects malformed body', async () => {
    const res = await app.request(jsonRequest('http://localhost/setup-callback', {}));
    expect(res.status).toBe(400);
  });

  it('IT-1760-9: POST /setup-callback returns 502 when GitHub returns non-OK', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('GitHub error body', { status: 500 })) as never;
    const res = await app.request(
      jsonRequest('http://localhost/setup-callback', { code: 'abc123' })
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe('GITHUB_CONVERSION_FAILED');
  });

  it('IT-1760-10: POST /setup-callback returns 502 when fetch throws', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network down')) as never;
    const res = await app.request(
      jsonRequest('http://localhost/setup-callback', { code: 'abc123' })
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe('GITHUB_CONVERSION_ERROR');
  });

  it('IT-1760-11: POST /setup-callback saves credentials on success', async () => {
    const conversion = {
      id: 999,
      slug: 'new-app',
      pem: 'fake-pem-string',
      webhook_secret: 'wh-secret',
      client_id: 'client-id',
      client_secret: 'client-secret',
    };
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(conversion), { status: 201 })) as never;
    svc.saveCredentials.mockResolvedValue(ok(undefined));

    const res = await app.request(
      jsonRequest('http://localhost/setup-callback', { code: 'abc123' })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.appId).toBe('999');
    expect(body.data.appSlug).toBe('new-app');
    expect(svc.saveCredentials).toHaveBeenCalledWith({
      appId: '999',
      appSlug: 'new-app',
      privateKey: conversion.pem,
      webhookSecret: 'wh-secret',
      clientId: 'client-id',
      clientSecret: 'client-secret',
    });
  });

  it('IT-1760-12: POST /setup-callback surfaces save error', async () => {
    const conversion = {
      id: 999,
      slug: 'new-app',
      pem: 'pem',
      webhook_secret: 's',
      client_id: 'c',
      client_secret: 'cs',
    };
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(conversion), { status: 201 })) as never;
    svc.saveCredentials.mockResolvedValue(err('SAVE_FAILED', 'fail', 500));

    const res = await app.request(
      jsonRequest('http://localhost/setup-callback', { code: 'abc123' })
    );
    expect(res.status).toBe(500);
  });

  // ─── GET /installations ──────────────────────────────

  it('IT-1760-13: GET /installations returns mapped list (no teamId filter)', async () => {
    svc.listInstallations.mockResolvedValue(ok([{ id: 'i-1', accountLogin: 'org' }]));
    const res = await app.request('http://localhost/installations');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items).toHaveLength(1);
    expect(svc.listInstallations).toHaveBeenCalledWith(undefined);
  });

  it('IT-1760-14: GET /installations passes teamId filter', async () => {
    svc.listInstallations.mockResolvedValue(ok([]));
    await app.request('http://localhost/installations?teamId=team-1');
    expect(svc.listInstallations).toHaveBeenCalledWith('team-1');
  });

  it('IT-1760-15: GET /installations surfaces service error', async () => {
    svc.listInstallations.mockResolvedValue(err('LIST_FAILED', 'fail', 500));
    const res = await app.request('http://localhost/installations');
    expect(res.status).toBe(500);
  });

  // ─── POST /installations ─────────────────────────────

  it('IT-1760-16: POST /installations rejects malformed body', async () => {
    const res = await app.request(jsonRequest('http://localhost/installations', {}));
    expect(res.status).toBe(400);
  });

  it('IT-1760-17: POST /installations returns 503 when not configured and fetch fails', async () => {
    svc.getAppOctokitFromCredentials.mockRejectedValue(new Error('No app credentials'));
    svc.isConfigured.mockResolvedValue(false);
    const res = await app.request(
      jsonRequest('http://localhost/installations', {
        installationId: 12345,
        teamId: 'team-1',
      })
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe('GITHUB_APP_ERROR');
    expect(body.error.message).toContain('not configured');
  });

  it('IT-1760-18: POST /installations returns 502 when configured but fetch fails', async () => {
    svc.getAppOctokitFromCredentials.mockRejectedValue(new Error('GitHub down'));
    svc.isConfigured.mockResolvedValue(true);
    const res = await app.request(
      jsonRequest('http://localhost/installations', {
        installationId: 12345,
        teamId: 'team-1',
      })
    );
    expect(res.status).toBe(502);
  });

  it('IT-1760-19: POST /installations succeeds with org account', async () => {
    svc.getAppOctokitFromCredentials.mockResolvedValue({
      rest: {
        apps: {
          getInstallation: vi.fn().mockResolvedValue({
            data: {
              account: { login: 'my-org', type: 'Organization' },
            },
          }),
        },
      },
    } as never);
    svc.handleInstallation.mockResolvedValue(ok({ id: 'inst-1', accountLogin: 'my-org' }));
    const res = await app.request(
      jsonRequest('http://localhost/installations', {
        installationId: 12345,
        teamId: 'team-1',
      })
    );
    expect(res.status).toBe(201);
    expect(svc.handleInstallation).toHaveBeenCalledWith(12345, 'my-org', 'Organization', 'team-1');
  });

  it('IT-1760-20: POST /installations falls back when account has no login', async () => {
    svc.getAppOctokitFromCredentials.mockResolvedValue({
      rest: {
        apps: {
          getInstallation: vi.fn().mockResolvedValue({ data: { account: null } }),
        },
      },
    } as never);
    svc.handleInstallation.mockResolvedValue(ok({ id: 'inst-2' }));
    const res = await app.request(
      jsonRequest('http://localhost/installations', {
        installationId: 999,
        teamId: 'team-1',
      })
    );
    expect(res.status).toBe(201);
    expect(svc.handleInstallation).toHaveBeenCalledWith(999, 'installation-999', 'User', 'team-1');
  });

  it('IT-1760-21: POST /installations surfaces handleInstallation error', async () => {
    svc.getAppOctokitFromCredentials.mockResolvedValue({
      rest: {
        apps: {
          getInstallation: vi.fn().mockResolvedValue({
            data: { account: { login: 'x', type: 'User' } },
          }),
        },
      },
    } as never);
    svc.handleInstallation.mockResolvedValue(err('CONFLICT', 'dup', 409));
    const res = await app.request(
      jsonRequest('http://localhost/installations', {
        installationId: 12345,
        teamId: 'team-1',
      })
    );
    expect(res.status).toBe(409);
  });

  // ─── DELETE /installations/:id ───────────────────────

  it('IT-1760-22: DELETE /installations/:id rejects bad ID', async () => {
    const res = await app.request('http://localhost/installations/bad..id', { method: 'DELETE' });
    expect(res.status).toBe(400);
  });

  it('IT-1760-23: DELETE /installations/:id succeeds', async () => {
    svc.removeInstallation.mockResolvedValue(ok(undefined));
    const res = await app.request('http://localhost/installations/inst-1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.deleted).toBe(true);
  });

  it('IT-1760-24: DELETE /installations/:id surfaces service error', async () => {
    svc.removeInstallation.mockResolvedValue(err('NOT_FOUND', 'gone', 404));
    const res = await app.request('http://localhost/installations/inst-1', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  // ─── POST /installations/:id/configure-codespace ─────

  it('IT-1760-25: configure-codespace rejects bad ID', async () => {
    const res = await app.request(
      jsonRequest('http://localhost/installations/bad..id/configure-codespace', {
        codespaceId: 'cs-1',
      })
    );
    expect(res.status).toBe(400);
  });

  it('IT-1760-26: configure-codespace rejects malformed body', async () => {
    const res = await app.request(
      jsonRequest('http://localhost/installations/inst-1/configure-codespace', {})
    );
    expect(res.status).toBe(400);
  });

  it('IT-1760-27: configure-codespace succeeds', async () => {
    svc.autoConfigureEventsForCodespace.mockResolvedValue(ok({ configured: true }));
    const res = await app.request(
      jsonRequest('http://localhost/installations/inst-1/configure-codespace', {
        codespaceId: 'cs-1',
      })
    );
    expect(res.status).toBe(200);
    expect(svc.autoConfigureEventsForCodespace).toHaveBeenCalledWith('cs-1');
  });

  it('IT-1760-28: configure-codespace surfaces service error', async () => {
    svc.autoConfigureEventsForCodespace.mockResolvedValue(err('NO_REPO', 'no repo', 400));
    const res = await app.request(
      jsonRequest('http://localhost/installations/inst-1/configure-codespace', {
        codespaceId: 'cs-1',
      })
    );
    expect(res.status).toBe(400);
  });

  // ─── DELETE /credentials ─────────────────────────────

  it('IT-1760-29: DELETE /credentials succeeds', async () => {
    svc.deleteCredentials.mockResolvedValue(ok(undefined));
    const res = await app.request('http://localhost/credentials', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.deleted).toBe(true);
  });

  it('IT-1760-30: DELETE /credentials surfaces service error', async () => {
    svc.deleteCredentials.mockResolvedValue(err('DELETE_FAILED', 'fail', 500));
    const res = await app.request('http://localhost/credentials', { method: 'DELETE' });
    expect(res.status).toBe(500);
  });
});
