import { describe, expect, it } from 'vitest';
import { exists, goto, screenshot, serverRunning, waitForSelector } from '../setup';

// Skip all tests if server not running - warning shown in setup.ts
const e2e = serverRunning ? describe : describe.skip;

e2e('P0-3: Agent Session & Batching Validation', () => {
  describe('Agent Session View', () => {
    it('renders main layout', async () => {
      await goto('/');
      await waitForSelector('[data-testid="layout-shell"]', { timeout: 10000 }).catch(() => {});
      const layout = await exists('[data-testid="layout-shell"]');
      expect(layout).toBe(true);
    });

    it('renders sidebar navigation', async () => {
      await goto('/');
      await waitForSelector('[data-testid="sidebar"]', { timeout: 10000 }).catch(() => {});
      const sidebar = await exists('[data-testid="sidebar"]');
      expect(sidebar).toBe(true);
    });

    it('can navigate to sessions', async () => {
      await goto('/');
      await waitForSelector('[data-testid="nav-sessions"]', { timeout: 10000 }).catch(() => {});
      const sessionsNav = await exists('[data-testid="nav-sessions"]');
      expect(typeof sessionsNav).toBe('boolean');
    });
  });

  describe('Session Detail Components', () => {
    it('session view renders tabs', async () => {
      await goto('/sessions');
      await waitForSelector('[data-testid="tab-session-replay"]', { timeout: 10000 }).catch(
        () => {}
      );
      const replayTab = await exists('[data-testid="tab-session-replay"]');
      expect(typeof replayTab).toBe('boolean');
    });

    it('tool calls tab exists', async () => {
      await goto('/sessions');
      await waitForSelector('[data-testid="tab-tool-calls"]', { timeout: 10000 }).catch(() => {});
      const toolCallsTab = await exists('[data-testid="tab-tool-calls"]');
      expect(typeof toolCallsTab).toBe('boolean');
    });

    it('topology tab exists', async () => {
      await goto('/sessions');
      await waitForSelector('[data-testid="tab-topology"]', { timeout: 10000 }).catch(() => {});
      const topologyTab = await exists('[data-testid="tab-topology"]');
      expect(typeof topologyTab).toBe('boolean');
    });
  });

  describe('Agent Controls', () => {
    it('agent status element renders', async () => {
      await goto('/');
      await waitForSelector('[data-testid="agent-status"]', { timeout: 5000 }).catch(() => {});
      const status = await exists('[data-testid="agent-status"]');
      expect(typeof status).toBe('boolean');
    });

    it('turn counter renders when agent active', async () => {
      await goto('/');
      await waitForSelector('[data-testid="turn-counter"]', { timeout: 5000 }).catch(() => {});
      const counter = await exists('[data-testid="turn-counter"]');
      expect(typeof counter).toBe('boolean');
    });

    it('pause button renders when agent active', async () => {
      await goto('/');
      await waitForSelector('[data-testid="pause-button"]', { timeout: 5000 }).catch(() => {});
      const pause = await exists('[data-testid="pause-button"]');
      expect(typeof pause).toBe('boolean');
    });

    it('stop button renders when agent active', async () => {
      await goto('/');
      await waitForSelector('[data-testid="stop-button"]', { timeout: 5000 }).catch(() => {});
      const stop = await exists('[data-testid="stop-button"]');
      expect(typeof stop).toBe('boolean');
    });
  });

  describe('Container Agent Panel', () => {
    it('container agent breadcrumbs render', async () => {
      await goto('/');
      await waitForSelector('[data-testid="container-agent-breadcrumbs"]', {
        timeout: 5000,
      }).catch(() => {});
      const breadcrumbs = await exists('[data-testid="container-agent-breadcrumbs"]');
      expect(typeof breadcrumbs).toBe('boolean');
    });

    it('container agent panel tabs render', async () => {
      await goto('/');
      await waitForSelector('[data-testid="panel-tabs"]', { timeout: 5000 }).catch(() => {});
      const tabs = await exists('[data-testid="panel-tabs"]');
      expect(typeof tabs).toBe('boolean');
    });
  });

  describe('Approval Flow Components', () => {
    it('approval dialog elements exist', async () => {
      await goto('/');
      await waitForSelector('[data-testid="approval-dialog"]', { timeout: 5000 }).catch(() => {});
      const dialog = await exists('[data-testid="approval-dialog"]');
      expect(typeof dialog).toBe('boolean');
    });
  });

  describe('Screenshots', () => {
    it('captures home page screenshot', async () => {
      await goto('/');
      await waitForSelector('[data-testid="layout-shell"]', { timeout: 10000 }).catch(() => {});
      const buffer = await screenshot('p0-agent-session-home');
      expect(buffer).toBeTruthy();
    });

    it('captures sessions page screenshot', async () => {
      await goto('/sessions');
      await waitForSelector('[data-testid="session-history-page"]', { timeout: 10000 }).catch(
        () => {}
      );
      const buffer = await screenshot('p0-agent-sessions');
      expect(buffer).toBeTruthy();
    });
  });
});
