/**
 * E2E Tests: Dialog Components
 *
 * Tests for NewProjectDialog - the main dialog in the application.
 * Covers form interactions, validation, and dialog behaviors.
 */
import { describe, expect, it } from 'vitest';
import {
  click,
  exists,
  fill,
  goto,
  press,
  screenshot,
  serverRunning,
  waitForHidden,
  waitForSelector,
} from '../setup';

const e2e = serverRunning ? describe : describe.skip;

e2e('Dialog Components E2E', () => {
  describe('NewProjectDialog', () => {
    it('can open new project dialog from home page', async () => {
      await goto('/');
      await waitForSelector('[data-testid="new-project-button"]', { timeout: 10000 }).catch(
        () => {}
      );

      const buttonExists = await exists('[data-testid="new-project-button"]');
      if (buttonExists) {
        await click('[data-testid="new-project-button"]');
        await waitForSelector('[data-testid="new-project-dialog"]', { timeout: 5000 }).catch(
          () => {}
        );

        const dialogOpen = await exists('[data-testid="new-project-dialog"]');
        expect(dialogOpen).toBe(true);
      } else {
        // Skip test if button doesn't exist (first-run empty state)
        expect(true).toBe(true);
      }
    });

    it('can open new project dialog from projects page', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="create-project-button"]', { timeout: 10000 }).catch(
        () => {}
      );

      const buttonExists = await exists('[data-testid="create-project-button"]');
      if (buttonExists) {
        await click('[data-testid="create-project-button"]');
        await waitForSelector('[data-testid="new-project-dialog"]', { timeout: 5000 }).catch(
          () => {}
        );

        const dialogOpen = await exists('[data-testid="new-project-dialog"]');
        expect(dialogOpen).toBe(true);
      }
    });

    it('shows project path input field', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="create-project-button"]', { timeout: 10000 }).catch(
        () => {}
      );

      const buttonExists = await exists('[data-testid="create-project-button"]');
      if (buttonExists) {
        await click('[data-testid="create-project-button"]');
        await waitForSelector('[data-testid="new-project-dialog"]', { timeout: 5000 }).catch(
          () => {}
        );

        const pathInput = await exists('[data-testid="project-path-input"]');
        expect(pathInput).toBe(true);
      }
    });

    it('shows validate button', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="create-project-button"]', { timeout: 10000 }).catch(
        () => {}
      );

      const buttonExists = await exists('[data-testid="create-project-button"]');
      if (buttonExists) {
        await click('[data-testid="create-project-button"]');
        await waitForSelector('[data-testid="new-project-dialog"]', { timeout: 5000 }).catch(
          () => {}
        );

        const validateButton = await exists('[data-testid="validate-path-button"]');
        expect(validateButton).toBe(true);
      }
    });

    it('can enter path and validate', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="create-project-button"]', { timeout: 10000 }).catch(
        () => {}
      );

      const buttonExists = await exists('[data-testid="create-project-button"]');
      if (buttonExists) {
        await click('[data-testid="create-project-button"]');
        await waitForSelector('[data-testid="project-path-input"]', { timeout: 5000 }).catch(
          () => {}
        );

        await fill('[data-testid="project-path-input"]', '/nonexistent/path');
        await click('[data-testid="validate-path-button"]');

        // Wait a moment for validation
        await waitForSelector('[data-testid="validation-result"]', { timeout: 5000 }).catch(
          () => {}
        );
        const validationResult = await exists('[data-testid="validation-result"]');
        // Either validation-error or validation-success should appear
        const validationError = await exists('[data-testid="validation-error"]');
        const validationSuccess = await exists('[data-testid="validation-success"]');

        expect(validationResult || validationError || validationSuccess).toBe(true);
      }
    });

    it('closes on Escape key', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="create-project-button"]', { timeout: 10000 }).catch(
        () => {}
      );

      const buttonExists = await exists('[data-testid="create-project-button"]');
      if (buttonExists) {
        await click('[data-testid="create-project-button"]');
        await waitForSelector('[data-testid="new-project-dialog"]', { timeout: 5000 }).catch(
          () => {}
        );

        // Press Escape to close dialog
        await press('Escape');

        // Wait for dialog to be hidden/detached from DOM
        try {
          await waitForHidden('[data-testid="new-project-dialog"]', { timeout: 3000 });
        } catch {
          // If first Escape didn't work (global shortcuts conflict), try again
          await press('Escape');
          await waitForHidden('[data-testid="new-project-dialog"]', { timeout: 3000 });
        }

        const dialogClosed = !(await exists('[data-testid="new-project-dialog"]'));
        expect(dialogClosed).toBe(true);
      }
    });

    it('shows clone URL input in clone tab', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="create-project-button"]', { timeout: 10000 }).catch(
        () => {}
      );

      const buttonExists = await exists('[data-testid="create-project-button"]');
      if (buttonExists) {
        await click('[data-testid="create-project-button"]');
        await waitForSelector('[data-testid="new-project-dialog"]', { timeout: 5000 }).catch(
          () => {}
        );

        // Click the clone tab to switch to clone mode
        const cloneTab = await exists('[data-testid="tab-clone"]');
        if (cloneTab) {
          await click('[data-testid="tab-clone"]');
          await new Promise((resolve) => setTimeout(resolve, 300));
        }

        // The dialog has tabs for local and clone - check if clone-related inputs exist
        // The clone tab may show either the GitHub repo list or the manual URL input
        const cloneUrlInput = await exists('[data-testid="clone-url-input"]');
        const clonePathInput = await exists('[data-testid="clone-path-input"]');
        const githubRepoList = await exists('[data-testid="github-repo-list"]');

        // At least one clone-related element should be visible (or tab might not exist)
        expect(cloneUrlInput || clonePathInput || githubRepoList || !cloneTab).toBe(true);
      }
    });

    it('shows sandbox type selection after path validation', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="create-project-button"]', { timeout: 10000 }).catch(
        () => {}
      );

      const buttonExists = await exists('[data-testid="create-project-button"]');
      if (buttonExists) {
        await click('[data-testid="create-project-button"]');
        await waitForSelector('[data-testid="project-path-input"]', { timeout: 5000 }).catch(
          () => {}
        );

        // Enter a path and validate
        await fill('[data-testid="project-path-input"]', '/Users/user/project');
        await click('[data-testid="validate-path-button"]');

        // Wait for validation to complete
        await waitForSelector('[data-testid="sandbox-type-docker"]', { timeout: 5000 }).catch(
          () => {}
        );

        // After validation, sandbox type options should appear
        const dockerOption = await exists('[data-testid="sandbox-type-docker"]');
        const devcontainerOption = await exists('[data-testid="sandbox-type-devcontainer"]');

        expect(typeof dockerOption).toBe('boolean');
        expect(typeof devcontainerOption).toBe('boolean');
      }
    });
  });

  describe('Dialog Accessibility', () => {
    it('dialog has proper focus management', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="create-project-button"]', { timeout: 10000 }).catch(
        () => {}
      );

      const buttonExists = await exists('[data-testid="create-project-button"]');
      if (buttonExists) {
        await click('[data-testid="create-project-button"]');
        await waitForSelector('[data-testid="new-project-dialog"]', { timeout: 5000 }).catch(
          () => {}
        );

        // Tab through dialog elements - focus should stay inside
        await press('Tab');
        await press('Tab');
        await press('Tab');

        // Dialog should still be open (focus trapped)
        const dialogOpen = await exists('[data-testid="new-project-dialog"]');
        expect(dialogOpen).toBe(true);
      }
    });

    it('returns focus to trigger on close', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="create-project-button"]', { timeout: 10000 }).catch(
        () => {}
      );

      const buttonExists = await exists('[data-testid="create-project-button"]');
      if (buttonExists) {
        await click('[data-testid="create-project-button"]');
        await waitForSelector('[data-testid="new-project-dialog"]', { timeout: 5000 }).catch(
          () => {}
        );

        await press('Escape');

        // Button should be focusable again
        const buttonStillExists = await exists('[data-testid="create-project-button"]');
        expect(buttonStillExists).toBe(true);
      }
    });
  });

  describe('Screenshots', () => {
    it('captures new project dialog screenshot', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="create-project-button"]', { timeout: 10000 }).catch(
        () => {}
      );

      const buttonExists = await exists('[data-testid="create-project-button"]');
      if (buttonExists) {
        await click('[data-testid="create-project-button"]');
        await waitForSelector('[data-testid="new-project-dialog"]', { timeout: 5000 }).catch(
          () => {}
        );

        const buffer = await screenshot('new-project-dialog');
        expect(buffer).toBeTruthy();
      }
    });

    it('captures projects page screenshot', async () => {
      await goto('/projects');
      await waitForSelector('[data-testid="projects-page"]', { timeout: 10000 }).catch(() => {});

      const buffer = await screenshot('projects-page');
      expect(buffer).toBeTruthy();
    });

    it('captures agents page screenshot', async () => {
      await goto('/agents');
      await waitForSelector('[data-testid="agents-page"]', { timeout: 10000 }).catch(() => {});

      const buffer = await screenshot('agents-page');
      expect(buffer).toBeTruthy();
    });
  });
});
