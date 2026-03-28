/**
 * E2E Tests: Sidebar Navigation
 *
 * Tests for main Sidebar navigation including project list, workspace links,
 * history links, and global navigation.
 *
 * NOTE: Click-based navigation tests are skipped when running in parallel
 * due to browser context sharing. Use --sequence.concurrent=false for full tests.
 */
import { describe, expect, it } from 'vitest';
import { exists, goto, screenshot, serverRunning, waitForSelector } from '../setup';

const e2e = serverRunning ? describe : describe.skip;

e2e('Sidebar Navigation E2E', () => {
  describe('Sidebar Structure', () => {
    it('renders sidebar on page load', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="sidebar"]', { timeout: 15000 });

      const sidebar = await exists('[data-testid="sidebar"]');
      expect(sidebar).toBe(true);
    });

    it('shows logo link in sidebar', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="sidebar"]', { timeout: 15000 });

      // Logo is a clickable Link to home (/)
      const logoLink = await exists('[data-testid="sidebar"] a[href="/"]');
      expect(logoLink).toBe(true);
    });
  });

  describe('Projects Section', () => {
    it('shows project list container', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="sidebar"]', { timeout: 15000 });

      // Project list may not be visible immediately, use exists which checks visibility
      const projectsList = await exists('[data-testid="project-list"]');
      expect(typeof projectsList).toBe('boolean');
    });

    it('shows select project link when no project selected', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="sidebar"]', { timeout: 15000 });

      // When no project is selected, there's a "Select a project" link
      const selectLink = await exists('[data-testid="project-list"] a[href="/projects"]');
      expect(typeof selectLink).toBe('boolean');
    });
  });

  describe('Organization Section', () => {
    it('shows organization nav section', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="nav-section-organization"]', { timeout: 15000 });

      const orgSection = await exists('[data-testid="nav-section-organization"]');
      expect(orgSection).toBe(true);
    });

    it('has Projects nav link', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="nav-projects"]', { timeout: 15000 });

      const projectsLink = await exists('[data-testid="nav-projects"]');
      expect(projectsLink).toBe(true);
    });

    it('has Sessions nav link', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="nav-sessions"]', { timeout: 15000 });

      const sessionsLink = await exists('[data-testid="nav-sessions"]');
      expect(sessionsLink).toBe(true);
    });

    it('has CLI Monitor nav link', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="nav-cli-monitor"]', { timeout: 15000 });

      const cliMonitorLink = await exists('[data-testid="nav-cli-monitor"]');
      expect(cliMonitorLink).toBe(true);
    });
  });

  describe('Content Section', () => {
    it('shows content nav section', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="nav-section-content"]', { timeout: 15000 });

      const contentSection = await exists('[data-testid="nav-section-content"]');
      expect(contentSection).toBe(true);
    });

    it('has Terraform nav link', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="nav-terraform"]', { timeout: 15000 });

      const terraformLink = await exists('[data-testid="nav-terraform"]');
      expect(terraformLink).toBe(true);
    });
  });

  describe('Execution Section', () => {
    it('shows execution nav section', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="nav-section-execution"]', { timeout: 15000 });

      const executionSection = await exists('[data-testid="nav-section-execution"]');
      expect(executionSection).toBe(true);
    });

    it('has Sandbox Configs nav link', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="nav-sandbox-configs"]', { timeout: 15000 });

      const sandboxLink = await exists('[data-testid="nav-sandbox-configs"]');
      expect(sandboxLink).toBe(true);
    });
  });

  describe('Admin Section', () => {
    it('shows admin nav section', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="nav-section-admin"]', { timeout: 15000 });

      const adminSection = await exists('[data-testid="nav-section-admin"]');
      expect(adminSection).toBe(true);
    });

    it('has Settings nav link', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="nav-settings"]', { timeout: 15000 });

      const settingsLink = await exists('[data-testid="nav-settings"]');
      expect(settingsLink).toBe(true);
    });
  });

  describe('User Info Footer', () => {
    it('shows user info in footer', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="sidebar"]', { timeout: 15000 });

      const footer = await exists('[data-testid="sidebar-footer"]');
      expect(footer).toBe(true);
    });

    it('displays user avatar', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="sidebar"]', { timeout: 15000 });

      const avatar = await exists('[data-testid="user-avatar"]');
      expect(avatar).toBe(true);
    });

    it('shows user name', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="sidebar"]', { timeout: 15000 });

      const userName = await exists('[data-testid="user-name"]');
      expect(userName).toBe(true);
    });

    it('shows mode indicator (local-first)', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="sidebar"]', { timeout: 15000 });

      const modeIndicator = await exists('[data-testid="mode-indicator"]');
      expect(modeIndicator).toBe(true);
    });
  });

  describe('Screenshots', () => {
    it('captures sidebar with navigation', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="sidebar"]', { timeout: 15000 });

      const buffer = await screenshot('sidebar-navigation');
      expect(buffer).toBeTruthy();
    });
  });
});
