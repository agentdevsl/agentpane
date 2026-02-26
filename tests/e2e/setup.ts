/**
 * E2E Test Setup using Playwright
 *
 * Uses Playwright's API directly for browser automation.
 * Single browser instance shared across all tests (no subprocess spawning).
 *
 * Set E2E_BASE_URL env var to enable E2E tests:
 *   E2E_BASE_URL=http://localhost:3000 bun run test:e2e
 */
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Browser, Page } from 'playwright';
import { chromium } from 'playwright';
import { afterAll, beforeAll } from 'vitest';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

// Server is considered running if E2E_BASE_URL is explicitly set
// This allows tests to skip gracefully when not configured
export const serverRunning = process.env.E2E_BASE_URL !== undefined;
export let browserReady = false;

let browser: Browser | null = null;
let page: Page | null = null;

const showSkipWarning = () => {
  console.warn('\n');
  console.warn('  ══════════════════════════════════════════════════════════════');
  console.warn('  E2E TESTS SKIPPED - Server not configured');
  console.warn('  ══════════════════════════════════════════════════════════════');
  console.warn('  ');
  console.warn('  To run E2E tests, set the E2E_BASE_URL environment variable:');
  console.warn('  ');
  console.warn('    E2E_BASE_URL=http://localhost:3000 bun run test:e2e');
  console.warn('  ');
  console.warn('  Or use the E2E test runner (starts server automatically):');
  console.warn('  ');
  console.warn('    bun scripts/e2e-test.ts');
  console.warn('  ');
  console.warn('  ══════════════════════════════════════════════════════════════');
  console.warn('\n');
};

if (!serverRunning) {
  showSkipWarning();
}

const ensurePage = (): Page => {
  if (!page) {
    throw new Error('Browser not launched. Ensure E2E_BASE_URL is set and beforeAll has run.');
  }
  return page;
};

/**
 * Open browser to a URL
 */
export async function open(url: string): Promise<void> {
  const p = ensurePage();
  await p.goto(url, { waitUntil: 'domcontentloaded' });
}

/**
 * Close the browser
 */
export async function close(): Promise<void> {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
    page = null;
    browserReady = false;
  }
}

/**
 * Navigate to a path (relative to BASE_URL or absolute)
 */
export async function goto(path: string): Promise<void> {
  const target = path.startsWith('http') ? path : `${BASE_URL}${path}`;
  const p = ensurePage();
  await p.goto(target, { waitUntil: 'domcontentloaded' });
}

/**
 * Click an element by selector
 */
export async function click(selector: string): Promise<void> {
  const p = ensurePage();
  await p.click(selector, { timeout: 10000 });
}

/**
 * Fill an input field
 */
export async function fill(selector: string, text: string): Promise<void> {
  const p = ensurePage();
  await p.fill(selector, text, { timeout: 10000 });
}

/**
 * Get text content of an element
 */
export async function getText(selector: string): Promise<string> {
  const p = ensurePage();
  return (await p.textContent(selector, { timeout: 10000 })) ?? '';
}

/**
 * Wait for a selector to appear
 */
export async function waitForSelector(
  selector: string,
  options?: { timeout?: number }
): Promise<void> {
  const p = ensurePage();
  await p.waitForSelector(selector, { timeout: options?.timeout ?? 15000 });
}

/**
 * Wait for a selector to be hidden/detached
 */
export async function waitForHidden(
  selector: string,
  options?: { timeout?: number }
): Promise<void> {
  const p = ensurePage();
  await p.waitForSelector(selector, { state: 'hidden', timeout: options?.timeout ?? 15000 });
}

/**
 * Wait for network to be idle
 */
export async function waitForNetworkIdle(timeout = 5000): Promise<void> {
  const p = ensurePage();
  await p.waitForLoadState('networkidle', { timeout });
}

/**
 * Take a screenshot
 */
export async function screenshot(name: string): Promise<Buffer> {
  const p = ensurePage();
  const screenshotDir = resolve(process.cwd(), 'tests/e2e/screenshots');
  if (!existsSync(screenshotDir)) {
    mkdirSync(screenshotDir, { recursive: true });
  }
  const buffer = await p.screenshot({
    path: resolve(screenshotDir, `${name}.png`),
    fullPage: true,
  });
  return Buffer.from(buffer);
}

/**
 * Drag and drop between elements
 */
export async function drag(sourceSelector: string, targetSelector: string): Promise<void> {
  const p = ensurePage();
  await p.dragAndDrop(sourceSelector, targetSelector, { timeout: 10000 });
}

/**
 * Check if an element exists and is visible
 */
export async function exists(selector: string): Promise<boolean> {
  const p = ensurePage();
  try {
    const element = p.locator(selector).first();
    return await element.isVisible({ timeout: 2000 });
  } catch {
    return false;
  }
}

/**
 * Get count of elements matching selector
 */
export async function getAll(selector: string): Promise<string[]> {
  const p = ensurePage();
  const count = await p.locator(selector).count();
  return Array.from({ length: count }, (_, index) => `${index}`);
}

/**
 * Type text character by character
 */
export async function type(selector: string, text: string): Promise<void> {
  const p = ensurePage();
  await p.locator(selector).pressSequentially(text, { delay: 50 });
}

/**
 * Press a keyboard key
 */
export async function press(key: string): Promise<void> {
  const p = ensurePage();
  await p.keyboard.press(key);
}

/**
 * Hover over an element
 */
export async function hover(selector: string): Promise<void> {
  const p = ensurePage();
  await p.hover(selector, { timeout: 10000 });
}

/**
 * Get an attribute value from an element
 */
export async function getAttribute(selector: string, name: string): Promise<string> {
  const p = ensurePage();
  return (await p.getAttribute(selector, name, { timeout: 10000 })) ?? '';
}

/**
 * Get the current page URL
 */
export async function getUrl(): Promise<string> {
  const p = ensurePage();
  return p.url();
}

// Lifecycle hooks
beforeAll(async () => {
  if (!serverRunning) {
    return;
  }

  console.log(`E2E tests enabled - server at ${BASE_URL}`);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  page = await context.newPage();
  browserReady = true;
}, 30000);

afterAll(async () => {
  await close();
});
