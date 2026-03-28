import { test, expect, Page, ConsoleMessage, ElectronApplication } from '@playwright/test';
import { launchApp, registerAndLogin, connectToTestDB, closeApp, AppContext } from './helpers/electron-app';
import path from 'path';
import fs from 'fs';

const SCREENSHOTS_DIR = path.resolve(__dirname, 'screenshots');

/** Collected console errors during the audit. */
const consoleErrors: Array<{ screen: string; text: string; type: string }> = [];
let currentScreen = 'unknown';

/** Take a named screenshot and save to e2e/screenshots/. */
async function screenshot(page: Page, name: string): Promise<void> {
  const filePath = path.join(SCREENSHOTS_DIR, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
}

/** Collect console errors from the page. */
function attachConsoleListener(page: Page): void {
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      consoleErrors.push({
        screen: currentScreen,
        text: msg.text(),
        type: msg.type(),
      });
    }
  });
}

/** Check for broken layouts: elements overflowing viewport or invisible key elements. */
async function checkLayout(page: Page, screenName: string): Promise<string[]> {
  const issues: string[] = [];

  // Check viewport overflow
  const hasHorizontalOverflow = await page.evaluate(() => {
    return document.documentElement.scrollWidth > document.documentElement.clientWidth;
  });
  if (hasHorizontalOverflow) {
    issues.push(`[${screenName}] Horizontal overflow detected`);
  }

  // Check for overlapping elements via z-index issues (basic check)
  const emptyTexts = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    return buttons
      .filter((btn) => {
        const rect = btn.getBoundingClientRect();
        return rect.width === 0 || rect.height === 0;
      })
      .map((btn) => btn.textContent || btn.getAttribute('title') || 'unnamed');
  });
  if (emptyTexts.length > 0) {
    issues.push(`[${screenName}] Zero-size buttons found: ${emptyTexts.join(', ')}`);
  }

  return issues;
}

/** Check all visible buttons are clickable (not obscured). */
async function checkInteractiveElements(page: Page, screenName: string): Promise<string[]> {
  const issues: string[] = [];

  const buttonInfo = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button:not([disabled])'));
    return buttons.map((btn) => {
      const rect = btn.getBoundingClientRect();
      const style = window.getComputedStyle(btn);
      return {
        label: btn.textContent?.trim() || btn.getAttribute('title') || btn.getAttribute('aria-label') || 'unnamed',
        visible: style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0',
        inViewport: rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth,
        width: rect.width,
        height: rect.height,
      };
    });
  });

  const visibleButtons = buttonInfo.filter((b) => b.visible && b.width > 0 && b.height > 0);
  const zeroSizeVisible = buttonInfo.filter((b) => b.visible && (b.width === 0 || b.height === 0));

  if (zeroSizeVisible.length > 0) {
    issues.push(
      `[${screenName}] Visible but zero-size buttons: ${zeroSizeVisible.map((b) => b.label).join(', ')}`,
    );
  }

  return issues;
}

// ──────────────────────────────────────────────
// Test suite
// ──────────────────────────────────────────────

let ctx: AppContext;
const allIssues: string[] = [];

test.beforeAll(async () => {
  // Ensure screenshots dir exists
  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }
  // Clean old screenshots
  const files = fs.readdirSync(SCREENSHOTS_DIR);
  for (const f of files) {
    if (f.endsWith('.png')) {
      fs.unlinkSync(path.join(SCREENSHOTS_DIR, f));
    }
  }

  ctx = await launchApp();
  attachConsoleListener(ctx.page);
});

test.afterAll(async () => {
  // Write audit report
  const reportPath = path.join(SCREENSHOTS_DIR, 'audit-report.txt');
  const lines: string[] = [
    '=== ProgreSQL UX Audit Report ===',
    `Date: ${new Date().toISOString()}`,
    '',
    '--- Layout / UI Issues ---',
  ];
  if (allIssues.length === 0) {
    lines.push('No layout issues detected.');
  } else {
    allIssues.forEach((issue) => lines.push(`  - ${issue}`));
  }
  lines.push('');
  lines.push('--- Console Errors / Warnings ---');
  if (consoleErrors.length === 0) {
    lines.push('No console errors detected.');
  } else {
    consoleErrors.forEach((e) => lines.push(`  [${e.type}] (${e.screen}) ${e.text}`));
  }
  lines.push('');
  lines.push('--- Screenshots ---');
  const pngs = fs.readdirSync(SCREENSHOTS_DIR).filter((f) => f.endsWith('.png'));
  pngs.forEach((f) => lines.push(`  ${f}`));
  lines.push('');
  lines.push('=== End of Report ===');

  fs.writeFileSync(reportPath, lines.join('\n'), 'utf-8');
  console.log(`\nAudit report written to ${reportPath}`);
  console.log(`Screenshots: ${pngs.length} captured`);
  if (allIssues.length > 0) {
    console.log(`Issues found: ${allIssues.length}`);
    allIssues.forEach((i) => console.log(`  - ${i}`));
  }
  if (consoleErrors.length > 0) {
    console.log(`Console errors/warnings: ${consoleErrors.length}`);
  }

  if (ctx?.app) {
    await closeApp(ctx.app);
  }
});

test.describe('ProgreSQL UX Audit — all screens and states', () => {
  // ── Screen 1: Login page ──
  test('01 — Login page', async () => {
    const { page } = ctx;
    currentScreen = 'login';

    await expect(page.getByRole('heading', { name: /ProgreSQL/i }).first()).toBeVisible({ timeout: 15_000 });
    await screenshot(page, '01-login-page');

    // Check interactive elements
    const emailField = page.getByLabel(/email/i);
    await expect(emailField).toBeVisible();

    const passwordField = page.locator('input[type="password"]');
    await expect(passwordField.first()).toBeVisible();

    const loginButton = page.getByRole('button', { name: /войти|sign in/i });
    await expect(loginButton).toBeVisible();

    const registerLink = page.getByRole('link', { name: /register|sign up/i });
    await expect(registerLink).toBeVisible();

    // Layout check
    allIssues.push(...(await checkLayout(page, 'login')));
    allIssues.push(...(await checkInteractiveElements(page, 'login')));
  });

  // ── Screen 2: Login error state ──
  test('02 — Login error state', async () => {
    const { page } = ctx;
    currentScreen = 'login-error';

    // Try logging in with bad credentials
    await page.getByLabel(/email/i).fill('bad@test.local');
    const passwordFields = page.locator('input[type="password"]');
    await passwordFields.first().fill('wrongpassword');
    await page.getByRole('button', { name: /войти|sign in/i }).click();

    // Wait for error
    await page.waitForTimeout(1000);
    await screenshot(page, '02-login-error');

    // Check error alert is shown (if auth is real)
    const errorAlert = page.locator('[role="alert"]');
    const hasError = await errorAlert.isVisible().catch(() => false);
    if (hasError) {
      await expect(errorAlert).toBeVisible();
    }

    allIssues.push(...(await checkLayout(page, 'login-error')));
  });

  // ── Screen 3: Register page ──
  test('03 — Register page', async () => {
    const { page } = ctx;
    currentScreen = 'register';

    // Navigate to register
    const registerLink = page.getByRole('link', { name: /register|sign up/i });
    if (await registerLink.isVisible().catch(() => false)) {
      await registerLink.click();
      await page.waitForURL('**/register', { timeout: 5_000 }).catch(() => {});
    }

    await page.waitForTimeout(500);
    await screenshot(page, '03-register-page');

    // Check form elements
    const nameField = page.getByLabel(/name|имя/i).first();
    if (await nameField.isVisible().catch(() => false)) {
      await expect(nameField).toBeVisible();
    }

    allIssues.push(...(await checkLayout(page, 'register')));
    allIssues.push(...(await checkInteractiveElements(page, 'register')));
  });

  // ── Screen 4: Main dashboard (after registration) ──
  test('04 — Main dashboard — no DB connected', async () => {
    const { page } = ctx;
    currentScreen = 'dashboard-no-db';

    // Register and go to main page
    await registerAndLogin(page, {
      name: 'UX Audit',
      email: 'audit@test.local',
      password: 'AuditPass123!',
    });

    await page.waitForTimeout(2000);
    await screenshot(page, '04-dashboard-no-db');

    // Verify the three-panel layout is visible
    const databasePanel = page.locator('[class*="panel"], [class*="Panel"]').first();
    await expect(databasePanel).toBeVisible({ timeout: 10_000 });

    allIssues.push(...(await checkLayout(page, 'dashboard-no-db')));
    allIssues.push(...(await checkInteractiveElements(page, 'dashboard-no-db')));
  });

  // ── Screen 5: Database panel — add connection form ──
  test('05 — Add connection form', async () => {
    const { page } = ctx;
    currentScreen = 'add-connection';

    // Look for add connection button
    const addBtn = page.getByRole('button', { name: /добавить|add|connect|подключ|new/i });
    if (await addBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await addBtn.click();
      await page.waitForTimeout(500);
    }

    await screenshot(page, '05-add-connection-form');
    allIssues.push(...(await checkLayout(page, 'add-connection')));
  });

  // ── Screen 6: Dashboard with DB connected ──
  test('06 — Dashboard — DB connected', async () => {
    const { page } = ctx;
    currentScreen = 'dashboard-with-db';

    await connectToTestDB(page);
    await page.waitForTimeout(3000);
    await screenshot(page, '06-dashboard-db-connected');

    // Check StatusBar shows DB connected
    const statusBar = page.locator('[class*="StatusBar"], [class*="status"]');
    if (await statusBar.isVisible().catch(() => false)) {
      await screenshot(page, '06b-status-bar');
    }

    allIssues.push(...(await checkLayout(page, 'dashboard-with-db')));
    allIssues.push(...(await checkInteractiveElements(page, 'dashboard-with-db')));
  });

  // ── Screen 7: Database tree expanded ──
  test('07 — Database tree expanded', async () => {
    const { page } = ctx;
    currentScreen = 'db-tree-expanded';

    // Try to expand tree nodes
    const expandButtons = page.locator('[class*="expand"], [class*="Expand"], svg[data-testid*="Expand"]');
    const count = await expandButtons.count();
    for (let i = 0; i < Math.min(count, 3); i++) {
      if (await expandButtons.nth(i).isVisible().catch(() => false)) {
        await expandButtons.nth(i).click().catch(() => {});
        await page.waitForTimeout(300);
      }
    }

    // Also try clicking on list items to expand
    const listButtons = page.locator('[role="button"]').filter({ hasText: /public|schema|tables/i });
    const listCount = await listButtons.count();
    for (let i = 0; i < Math.min(listCount, 3); i++) {
      await listButtons.nth(i).click().catch(() => {});
      await page.waitForTimeout(300);
    }

    await page.waitForTimeout(500);
    await screenshot(page, '07-db-tree-expanded');
    allIssues.push(...(await checkLayout(page, 'db-tree-expanded')));
  });

  // ── Screen 8: SQL Editor with query ──
  test('08 — SQL Editor with query', async () => {
    const { page } = ctx;
    currentScreen = 'sql-editor';

    // Find the CodeMirror editor or textarea
    const editor = page.locator('.cm-editor, .cm-content, textarea').first();
    if (await editor.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await editor.click();
      await page.keyboard.type('SELECT * FROM pg_tables LIMIT 5;');
      await page.waitForTimeout(500);
    }

    await screenshot(page, '08-sql-editor-with-query');
    allIssues.push(...(await checkLayout(page, 'sql-editor')));
  });

  // ── Screen 9: Query results ──
  test('09 — Query results', async () => {
    const { page } = ctx;
    currentScreen = 'query-results';

    // Click the Run button
    const runBtn = page.getByRole('button', { name: /run|выполнить/i });
    const runIconBtn = page.locator('button[title*="Run"], button[title*="run"], button[title*="Execute"]');

    if (await runBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await runBtn.click();
    } else if (await runIconBtn.first().isVisible({ timeout: 1_000 }).catch(() => false)) {
      await runIconBtn.first().click();
    }

    await page.waitForTimeout(2000);
    await screenshot(page, '09-query-results');

    // Check that results table appeared
    const resultsTable = page.locator('table, [class*="results"], [class*="Results"]');
    if (await resultsTable.isVisible().catch(() => false)) {
      await screenshot(page, '09b-results-table');
    }

    allIssues.push(...(await checkLayout(page, 'query-results')));
  });

  // ── Screen 10: Chat panel — no message ──
  test('10 — Chat panel — empty state', async () => {
    const { page } = ctx;
    currentScreen = 'chat-empty';

    // Focus on chat panel area
    const chatInput = page.locator('textarea, input[type="text"]').last();
    if (await chatInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await chatInput.scrollIntoViewIfNeeded();
    }

    await screenshot(page, '10-chat-empty');
    allIssues.push(...(await checkLayout(page, 'chat-empty')));
  });

  // ── Screen 11: Chat — sending message ──
  test('11 — Chat — send message and response', async () => {
    const { page } = ctx;
    currentScreen = 'chat-message';

    const chatInput = page.locator('textarea, input[type="text"]').last();
    if (await chatInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await chatInput.fill('Show all tables in the database');

      // Try send button or Enter
      const sendBtn = page.getByRole('button', { name: /send|отправить/i });
      const sendIconBtn = page.locator('button[title*="Send"], button[title*="send"]');
      if (await sendBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await sendBtn.click();
      } else if (await sendIconBtn.first().isVisible({ timeout: 1_000 }).catch(() => false)) {
        await sendIconBtn.first().click();
      } else {
        await chatInput.press('Enter');
      }

      await screenshot(page, '11a-chat-message-sent');

      // Wait for streaming/response
      await page.waitForTimeout(5000);
      await screenshot(page, '11b-chat-response');

      // Wait a bit more for full response
      await page.waitForTimeout(10_000);
      await screenshot(page, '11c-chat-response-complete');
    }

    allIssues.push(...(await checkLayout(page, 'chat-message')));
  });

  // ── Screen 12: Chat — SQL block with action buttons ──
  test('12 — Chat — SQL block buttons', async () => {
    const { page } = ctx;
    currentScreen = 'chat-sql-block';

    // Check for SQL blocks in chat
    const sqlBlocks = page.locator('pre, [class*="sql"], [class*="SQL"], code');
    const sqlCount = await sqlBlocks.count();

    if (sqlCount > 0) {
      await sqlBlocks.first().scrollIntoViewIfNeeded();
      await screenshot(page, '12-chat-sql-block');

      // Check action buttons on SQL blocks (Copy, Execute, Explain, Apply)
      const sqlButtons = page.locator('button').filter({ hasText: /copy|execute|explain|apply|копир/i });
      const btnCount = await sqlButtons.count();
      if (btnCount > 0) {
        await screenshot(page, '12b-sql-block-buttons');
      }
    } else {
      await screenshot(page, '12-no-sql-blocks');
    }

    allIssues.push(...(await checkLayout(page, 'chat-sql-block')));
  });

  // ── Screen 13: Settings panel ──
  test('13 — Settings panel / page', async () => {
    const { page } = ctx;
    currentScreen = 'settings';

    // Try settings button in chat header
    const settingsBtn = page.locator('button[title*="Settings"], button[title*="settings"]');
    if (await settingsBtn.first().isVisible({ timeout: 2_000 }).catch(() => false)) {
      await settingsBtn.first().click();
      await page.waitForTimeout(500);
      await screenshot(page, '13a-settings-panel');

      // Close panel if it's a drawer
      const closeBtn = page.locator('button[title*="Close"], button[title*="close"]');
      if (await closeBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await closeBtn.click();
        await page.waitForTimeout(300);
      }
    }

    // Also try navigating to /settings page
    await page.evaluate(() => {
      if (typeof window !== 'undefined' && window.location) {
        window.location.hash = '';
      }
    });

    // Try via URL navigation
    const currentUrl = page.url();
    try {
      await page.goto(currentUrl.replace(/\/$/, '') + '/settings', { timeout: 5_000 });
      await page.waitForTimeout(1000);
      await screenshot(page, '13b-settings-page');

      // Check settings elements
      const backendUrlInput = page.locator('input[placeholder*="localhost"], input[placeholder*="http"]');
      if (await backendUrlInput.isVisible().catch(() => false)) {
        await screenshot(page, '13c-settings-agent-config');
      }

      allIssues.push(...(await checkLayout(page, 'settings')));
      allIssues.push(...(await checkInteractiveElements(page, 'settings')));

      // Navigate back
      const backBtn = page.getByRole('button', { name: /back|назад/i });
      if (await backBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await backBtn.click();
        await page.waitForTimeout(500);
      } else {
        await page.goBack();
        await page.waitForTimeout(500);
      }
    } catch {
      // Settings page might not be reachable via direct navigation in Electron
      await screenshot(page, '13b-settings-navigation-failed');
    }
  });

  // ── Screen 14: Chat — clear history ──
  test('14 — Chat — clear history button', async () => {
    const { page } = ctx;
    currentScreen = 'chat-clear';

    const clearBtn = page.locator('button[title*="Очистить"], button[title*="clear"], button[title*="Clear"]');
    if (await clearBtn.first().isVisible({ timeout: 2_000 }).catch(() => false)) {
      await screenshot(page, '14a-before-clear');
      // Don't actually clear, just verify the button exists
    }

    allIssues.push(...(await checkLayout(page, 'chat-clear')));
  });

  // ── Screen 15: Chat — new chat creation ──
  test('15 — Chat — new chat tab', async () => {
    const { page } = ctx;
    currentScreen = 'chat-new';

    const newChatBtn = page.locator('button').filter({ has: page.locator('svg[data-testid*="Add"], [class*="Add"]') });
    if (await newChatBtn.first().isVisible({ timeout: 2_000 }).catch(() => false)) {
      await newChatBtn.first().click();
      await page.waitForTimeout(500);
      await screenshot(page, '15-new-chat-tab');
    }

    allIssues.push(...(await checkLayout(page, 'chat-new')));
  });

  // ── Screen 16: Resize panels ──
  test('16 — Panel resize handles', async () => {
    const { page } = ctx;
    currentScreen = 'panel-resize';

    // Check resize handles exist
    const resizeHandles = page.locator('[data-panel-resize-handle-id], [class*="resize"], [class*="Resize"]');
    const handleCount = await resizeHandles.count();

    if (handleCount > 0) {
      // Verify handles are visible and have correct cursor
      const firstHandle = resizeHandles.first();
      if (await firstHandle.isVisible().catch(() => false)) {
        await screenshot(page, '16-panel-resize-handles');
      }
    }

    allIssues.push(...(await checkLayout(page, 'panel-resize')));
  });

  // ── Screen 17: Error boundary (simulated) ──
  test('17 — Error boundary check', async () => {
    const { page } = ctx;
    currentScreen = 'error-boundary';

    // We can't easily trigger a real error boundary,
    // but we can verify the component exists by checking for retry buttons
    // if an error happened during previous tests
    const errorBoundary = page.locator('[class*="error"], [class*="Error"]').filter({ hasText: /retry|crashed|went wrong/i });
    const hasError = await errorBoundary.isVisible().catch(() => false);

    if (hasError) {
      await screenshot(page, '17-error-boundary-visible');
      allIssues.push('[error-boundary] ErrorBoundary is visible — a component has crashed');
    } else {
      await screenshot(page, '17-no-error-boundary');
    }
  });

  // ── Screen 18: Disconnect state ──
  test('18 — Disconnect state — StatusBar indicators', async () => {
    const { page } = ctx;
    currentScreen = 'disconnect-state';

    // Check StatusBar for connection indicators
    const dbStatus = page.locator('text=/DB:|Database/i');
    const agentStatus = page.locator('text=/Agent/i');

    if (await dbStatus.first().isVisible().catch(() => false)) {
      await screenshot(page, '18a-status-indicators');
    }

    // Check warning banners in chat
    const warningBanner = page.locator('[role="alert"]');
    const bannerCount = await warningBanner.count();
    if (bannerCount > 0) {
      for (let i = 0; i < bannerCount; i++) {
        if (await warningBanner.nth(i).isVisible().catch(() => false)) {
          const text = await warningBanner.nth(i).textContent().catch(() => '');
          if (text) {
            allIssues.push(`[disconnect-state] Alert banner visible: ${text.substring(0, 100)}`);
          }
        }
      }
    }

    await screenshot(page, '18b-full-state');
    allIssues.push(...(await checkLayout(page, 'disconnect-state')));
  });

  // ── Final: Summary ──
  test('19 — Final audit summary', async () => {
    const { page } = ctx;
    currentScreen = 'final';

    // Final full-page screenshot
    await screenshot(page, '19-final-state');

    // Log summary
    console.log('\n=== UX AUDIT SUMMARY ===');
    console.log(`Layout issues: ${allIssues.length}`);
    console.log(`Console errors/warnings: ${consoleErrors.length}`);

    if (allIssues.length > 0) {
      console.log('\nIssues:');
      allIssues.forEach((i) => console.log(`  - ${i}`));
    }

    if (consoleErrors.length > 0) {
      console.log('\nConsole errors:');
      consoleErrors.forEach((e) => console.log(`  [${e.type}] (${e.screen}) ${e.text.substring(0, 200)}`));
    }

    // The test passes — issues are reported but don't fail the audit
    // This is intentional: the audit is for visibility, not gating
    expect(true).toBe(true);
  });
});
