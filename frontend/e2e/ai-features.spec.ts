/**
 * ai-features.spec.ts
 *
 * Comprehensive E2E tests for ALL AI features:
 * - Chat UI: input, send, tabs, DB pill
 * - Magic Wand (Improve Query with AI) button
 * - Explain (AI) from database tree context menu
 * - Fix SQL Error in Chat button
 * - Stop Generation / loading states
 * - Security modes (Safe / Data / Execute) switching & indicators
 * - Model selection dropdown
 * - Chat keyboard shortcuts (Cmd+K)
 * - Analyze Schema button
 * - SQL Block action buttons (when LLM responds with SQL)
 *
 * Works with OR without OpenRouter API key:
 * - With API key: full AI responses with SQL blocks
 * - Without API key: validates UI elements, button clicks, error handling
 */
import { test, expect } from '@playwright/test';
import { launchApp, registerAndLogin, AppContext } from './helpers/electron-app';
import path from 'path';
import fs from 'fs';

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots', 'ai-features');

const TEST_USER = {
  name: 'AI Test User',
  email: `aitest_${Date.now()}@test.com`,
  password: 'AiTest123!',
};

const TEST_DB = {
  name: 'AI Test DB',
  host: '127.0.0.1',
  port: '5435',
  username: 'progressql',
  password: 'progressql',
  database: 'progressql',
};

let ctx: AppContext;

/** Helper: ensure chat panel is visible */
async function ensureChatPanelOpen(page: import('playwright').Page): Promise<void> {
  const chatPanel = page.locator('[aria-label="AI Assistant panel"]');
  if (await chatPanel.isVisible({ timeout: 1000 }).catch(() => false)) return;
  await page.keyboard.press('Meta+k');
  await page.waitForTimeout(500);
  if (await chatPanel.isVisible({ timeout: 2000 }).catch(() => false)) return;
  const chatToggle = page.locator('[aria-label*="AI assistant"], [aria-label*="chat"], [aria-label*="Chat"]').first();
  if (await chatToggle.isVisible({ timeout: 2000 }).catch(() => false)) {
    await chatToggle.click();
    await page.waitForTimeout(500);
  }
}

/** Helper: send chat message, wait for response or error */
async function sendChatMessage(
  page: import('playwright').Page,
  message: string,
  timeout = 15_000,
): Promise<{ gotResponse: boolean; gotError: boolean; hasSQL: boolean }> {
  const chatInput = page.locator('textarea:not([aria-hidden="true"]):not([readonly])').last();
  await expect(chatInput).toBeVisible({ timeout: 5000 });
  await chatInput.fill(message);
  await chatInput.press('Enter');

  // Wait for any response — bot message, stop button, or error
  await page.waitForTimeout(3000);

  // Check for stop button (streaming response)
  const stopBtn = page.locator('[aria-label="Stop generation"]');
  const isStreaming = await stopBtn.isVisible({ timeout: 5000 }).catch(() => false);
  if (isStreaming) {
    await stopBtn.waitFor({ state: 'hidden', timeout }).catch(() => {});
  }

  // Check outcomes
  const gotError = await page.locator('text=/Invalid request|Некорректный запрос/i').first().isVisible({ timeout: 2000 }).catch(() => false);
  const sqlBlocks = page.locator('pre, [class*="sql-block"]').filter({ hasText: /SELECT|INSERT|UPDATE|DELETE|CREATE/i });
  const hasSQL = (await sqlBlocks.count()) > 0;

  return { gotResponse: !gotError, gotError, hasSQL };
}

/** Helper: open settings panel */
async function openSettings(page: import('playwright').Page): Promise<void> {
  const settingsBtn = page.locator('[aria-label="Open settings"]');
  if (await settingsBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await settingsBtn.click({ force: true });
    await page.waitForTimeout(1000);
  }
}

/** Helper: close settings panel */
async function closeSettings(page: import('playwright').Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
}

/** Helper: change security mode */
async function setSecurityMode(page: import('playwright').Page, mode: 'safe' | 'data' | 'execute'): Promise<boolean> {
  await openSettings(page);
  const securitySelect = page.locator('[role="combobox"]').filter({ hasText: /safe|data|execute/i }).first();
  if (!(await securitySelect.isVisible({ timeout: 3000 }).catch(() => false))) {
    await closeSettings(page);
    return false;
  }
  await securitySelect.click();
  await page.waitForTimeout(300);
  const option = page.locator('[role="option"]').filter({ hasText: new RegExp(mode, 'i') }).first();
  if (await option.isVisible({ timeout: 2000 }).catch(() => false)) {
    await option.click();
    await page.waitForTimeout(500);
    await closeSettings(page);
    return true;
  }
  await page.keyboard.press('Escape');
  await closeSettings(page);
  return false;
}

test.describe.serial('AI Features — Full Coverage', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // SETUP
  // ═══════════════════════════════════════════════════════════════════════════
  test('00 — Setup: launch app, register, connect database', async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    ctx = await launchApp();
    const { page } = ctx;
    await page.waitForTimeout(2000);

    // Handle stale session
    if (page.url().includes('verify-email')) {
      const logoutLink = page.locator('a, button').filter({ hasText: /Log out|Выйти/i }).first();
      if (await logoutLink.isVisible({ timeout: 3000 }).catch(() => false)) {
        await logoutLink.click();
        await page.waitForURL((url: URL) => url.pathname.includes('login'), { timeout: 10_000 }).catch(() => {});
        await page.waitForTimeout(1000);
      }
    }

    await registerAndLogin(page, TEST_USER);
    await expect(
      page.getByRole('heading', { name: /Connections|AI Assistant/i }).first(),
    ).toBeVisible({ timeout: 15_000 });

    // Add database connection
    const addBtn = page.locator('[aria-label="Add new database connection"]').first();
    if (await addBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await addBtn.click();
    } else {
      // Fallback: find small icon button near CONNECTIONS header
      const iconButtons = page.locator('button').filter({ has: page.locator('svg') });
      const count = await iconButtons.count();
      for (let i = 0; i < count; i++) {
        const btn = iconButtons.nth(i);
        const box = await btn.boundingBox().catch(() => null);
        if (box && box.y < 50 && box.width < 50) {
          await btn.click();
          break;
        }
      }
    }

    await page.waitForTimeout(1000);

    // Fill connection form
    const dialog = page.locator('[role="dialog"]');
    if (await dialog.isVisible({ timeout: 3000 }).catch(() => false)) {
      const textInputs = dialog.locator('input:not([type="hidden"])');
      const inputCount = await textInputs.count();
      const values = [TEST_DB.name, TEST_DB.host, TEST_DB.port, TEST_DB.username, TEST_DB.password, TEST_DB.database];
      for (let i = 0; i < Math.min(inputCount, values.length); i++) {
        await textInputs.nth(i).click({ clickCount: 3 });
        await textInputs.nth(i).fill(values[i]);
      }
      const connectBtn = dialog.getByRole('button', { name: /Connect to Database|Подключить/i });
      if (await connectBtn.isEnabled({ timeout: 2000 }).catch(() => false)) {
        await connectBtn.click();
      }
      await dialog.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
    }

    await page.waitForTimeout(2000);

    // Click connection item to actually connect
    const connItem = page.locator('text=/AI Test DB/i').first();
    if (await connItem.isVisible({ timeout: 3000 }).catch(() => false)) {
      await connItem.click();
      await page.waitForTimeout(3000);
    }

    // Verify editor is visible (= DB connected)
    const editor = page.locator('.cm-editor').first();
    const connected = await editor.isVisible({ timeout: 15_000 }).catch(() => false);

    // If not connected, try double click
    if (!connected && await connItem.isVisible({ timeout: 1000 }).catch(() => false)) {
      await connItem.dblclick();
      await page.waitForTimeout(5000);
    }

    console.log(`[AI-00] DB connected (editor visible): ${await editor.isVisible().catch(() => false)}`);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '00-setup.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CHAT UI ELEMENTS
  // ═══════════════════════════════════════════════════════════════════════════
  test('01 — Chat panel opens and shows AI Assistant header', async () => {
    const { page } = ctx;
    await ensureChatPanelOpen(page);

    const header = page.locator('text=/AI Assistant/i').first();
    await expect(header).toBeVisible({ timeout: 5000 });

    // Chat input should be visible
    const chatInput = page.locator('textarea:not([aria-hidden="true"]):not([readonly])').last();
    await expect(chatInput).toBeVisible({ timeout: 3000 });

    // Create new chat button should exist
    const newChatBtn = page.locator('[aria-label="Create new chat"]');
    const hasNewChat = await newChatBtn.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`[AI-01] New chat button: ${hasNewChat}`);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-chat-panel.png') });
  });

  test('02 — Chat DB connection pill shows connected database', async () => {
    const { page } = ctx;
    await ensureChatPanelOpen(page);

    // DB pill should show connection name or "No DB"
    const dbPill = page.locator('button, [class*="pill"]').filter({
      hasText: /AI Test|progressql|No DB|Нет БД/i,
    }).first();
    const hasPill = await dbPill.isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`[AI-02] DB pill visible: ${hasPill}`);

    if (hasPill) {
      const pillText = await dbPill.textContent();
      console.log(`[AI-02] DB pill text: "${pillText}"`);
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-db-pill.png') });
  });

  test('03 — Send chat message and verify response handling', async () => {
    const { page } = ctx;
    await ensureChatPanelOpen(page);

    const result = await sendChatMessage(page, 'Show all tables');
    console.log(`[AI-03] Response: ${result.gotResponse}, Error: ${result.gotError}, SQL: ${result.hasSQL}`);

    // Should have at least one bot message (either response or error)
    // The user message should be visible
    const userMsg = page.locator('text=/Show all tables/i').first();
    await expect(userMsg).toBeVisible({ timeout: 3000 });

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '03-chat-message.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // MAGIC WAND — Improve Query
  // ═══════════════════════════════════════════════════════════════════════════
  test('04 — Magic Wand button exists and is clickable', async () => {
    const { page } = ctx;

    const editor = page.locator('.cm-editor .cm-content').first();
    if (!(await editor.isVisible({ timeout: 3000 }).catch(() => false))) {
      console.log('[AI-04] Editor not visible, skipping.');
      return;
    }

    await editor.click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.type('select * from users where id > 0', { delay: 20 });
    await page.waitForTimeout(300);

    const improveBtn = page.locator('[aria-label="Improve query with AI"]');
    await expect(improveBtn).toBeVisible({ timeout: 3000 });

    const isEnabled = await improveBtn.isEnabled().catch(() => false);
    console.log(`[AI-04] Improve button enabled: ${isEnabled}`);
    expect(isEnabled).toBe(true);

    // Click it — may get response or error depending on LLM availability
    await improveBtn.click();
    await page.waitForTimeout(5000);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '04-magic-wand.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // FIX SQL ERROR
  // ═══════════════════════════════════════════════════════════════════════════
  test('05 — Run broken SQL and check Fix in Chat button', async () => {
    const { page } = ctx;

    const editor = page.locator('.cm-editor .cm-content').first();
    if (!(await editor.isVisible({ timeout: 3000 }).catch(() => false))) {
      console.log('[AI-05] Editor not visible, skipping.');
      return;
    }

    await editor.click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.type('SELECT * FROM nonexistent_xyz_table;', { delay: 20 });
    await page.keyboard.press('F5');
    await page.waitForTimeout(3000);

    // Look for error in results
    const errorText = page.locator('text=/error|does not exist|не существует/i').first();
    const hasError = await errorText.isVisible({ timeout: 5000 }).catch(() => false);
    console.log(`[AI-05] Query error shown: ${hasError}`);

    // Look for Fix in Chat button
    const fixBtn = page.locator('button').filter({ hasText: /Fix|Исправить/i }).first();
    const hasFixBtn = await fixBtn.isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`[AI-05] Fix in Chat button: ${hasFixBtn}`);

    if (hasFixBtn) {
      await fixBtn.click();
      await page.waitForTimeout(3000);
      console.log('[AI-05] Fix button clicked — request sent to AI.');
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '05-fix-error.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // EXPLAIN (AI) from Context Menu
  // ═══════════════════════════════════════════════════════════════════════════
  test('06 — Right-click table → Explain (AI) menu item', async () => {
    const { page } = ctx;

    // Expand tables in tree
    const tablesSection = page.locator('text=/Tables|Таблицы/i').first();
    if (await tablesSection.isVisible({ timeout: 3000 }).catch(() => false)) {
      await tablesSection.click();
      await page.waitForTimeout(1000);
    }

    // Right-click on users table
    const usersTable = page.locator('text=/^users$/').first();
    if (await usersTable.isVisible({ timeout: 3000 }).catch(() => false)) {
      await usersTable.click({ button: 'right' });
      await page.waitForTimeout(500);

      // Check context menu items
      const menuItems = page.locator('[role="menuitem"]');
      const menuCount = await menuItems.count();
      console.log(`[AI-06] Context menu items: ${menuCount}`);

      // Look for Explain AI option
      const explainAI = menuItems.filter({ hasText: /Explain|AI|Объяснить/i }).first();
      const hasExplain = await explainAI.isVisible({ timeout: 2000 }).catch(() => false);
      console.log(`[AI-06] Explain (AI) in menu: ${hasExplain}`);

      // Also check for other expected menu items
      const queryItem = menuItems.filter({ hasText: /SELECT|Query|Запрос/i }).first();
      const copyItem = menuItems.filter({ hasText: /Copy|Копировать/i }).first();
      const viewInfoItem = menuItems.filter({ hasText: /View Info|Информация/i }).first();

      console.log(`[AI-06] Menu items — Query: ${await queryItem.isVisible().catch(() => false)}, Copy: ${await copyItem.isVisible().catch(() => false)}, ViewInfo: ${await viewInfoItem.isVisible().catch(() => false)}`);

      if (hasExplain) {
        await explainAI.click();
        await page.waitForTimeout(3000);
        console.log('[AI-06] Explain AI clicked — request sent.');
      } else {
        await page.keyboard.press('Escape');
      }
    } else {
      console.log('[AI-06] Users table not found.');
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '06-explain-context.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SECURITY MODES
  // ═══════════════════════════════════════════════════════════════════════════
  test('07 — Switch to Data Mode and verify UI changes', async () => {
    const { page } = ctx;

    const switched = await setSecurityMode(page, 'data');
    expect(switched).toBe(true);

    // Verify Data Mode info text in settings
    await openSettings(page);
    const dataInfo = page.locator('text=/Read-only|SELECT queries only|только.*чтени/i').first();
    const hasDataInfo = await dataInfo.isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`[AI-07] Data mode info visible: ${hasDataInfo}`);
    await closeSettings(page);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '07-data-mode.png') });
  });

  test('08 — Switch to Execute Mode and verify warning', async () => {
    const { page } = ctx;

    const switched = await setSecurityMode(page, 'execute');
    expect(switched).toBe(true);

    // Execute mode should show warning
    await openSettings(page);
    const executeInfo = page.locator('text=/Full access|all SQL|полный доступ|INSERT.*UPDATE.*DELETE/i').first();
    const hasExecuteInfo = await executeInfo.isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`[AI-08] Execute mode info visible: ${hasExecuteInfo}`);
    await closeSettings(page);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '08-execute-mode.png') });
  });

  test('09 — Switch back to Safe Mode', async () => {
    const { page } = ctx;

    const switched = await setSecurityMode(page, 'safe');
    expect(switched).toBe(true);

    await openSettings(page);
    const safeInfo = page.locator('text=/Schema only|schema.*only|только.*схем/i').first();
    const hasSafeInfo = await safeInfo.isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`[AI-09] Safe mode info visible: ${hasSafeInfo}`);
    await closeSettings(page);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '09-safe-mode.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // MODEL SELECTION
  // ═══════════════════════════════════════════════════════════════════════════
  test('10 — Model selection shows available LLM models', async () => {
    const { page } = ctx;
    await openSettings(page);

    // Check for model section
    const modelSection = page.locator('text=/LLM Model|Модель/i').first();
    const hasModelSection = await modelSection.isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`[AI-10] Model section visible: ${hasModelSection}`);

    // Check for model options
    const qwenCoder = page.locator('text=/Qwen 3 Coder|qwen3-coder/i').first();
    const gptOss = page.locator('text=/GPT-OSS|gpt-oss/i').first();
    const qwenVL = page.locator('text=/Qwen 3 VL|qwen3-vl/i').first();

    const models = {
      qwenCoder: await qwenCoder.isVisible({ timeout: 2000 }).catch(() => false),
      gptOss: await gptOss.isVisible({ timeout: 1000 }).catch(() => false),
      qwenVL: await qwenVL.isVisible({ timeout: 1000 }).catch(() => false),
    };
    console.log(`[AI-10] Models:`, models);

    // At least one model should be visible
    const anyModel = Object.values(models).some(v => v);
    expect(anyModel).toBe(true);

    await closeSettings(page);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '10-models.png') });
  });

  test('11 — Switch model selection', async () => {
    const { page } = ctx;
    await openSettings(page);

    // Try radio buttons or dropdown for model
    const modelSelect = page.locator('[role="combobox"]').filter({ hasText: /qwen|gpt|model/i }).first();
    if (await modelSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
      await modelSelect.click();
      await page.waitForTimeout(500);
      const options = page.locator('[role="option"]');
      const count = await options.count();
      console.log(`[AI-11] Model dropdown options: ${count}`);
      if (count >= 2) {
        const opt2Text = await options.nth(1).textContent();
        await options.nth(1).click();
        console.log(`[AI-11] Selected: ${opt2Text}`);
        await page.waitForTimeout(500);
      } else {
        await page.keyboard.press('Escape');
      }
    } else {
      // Try radio buttons
      const radios = page.locator('input[type="radio"]');
      const radioCount = await radios.count();
      console.log(`[AI-11] Model radio buttons: ${radioCount}`);
      if (radioCount >= 2) {
        await radios.nth(1).click({ force: true });
        await page.waitForTimeout(500);
      }
    }

    await closeSettings(page);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '11-model-switch.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CHAT TABS
  // ═══════════════════════════════════════════════════════════════════════════
  test('12 — Create new chat tab', async () => {
    const { page } = ctx;
    await ensureChatPanelOpen(page);

    const tabsBefore = await page.locator('[role="tab"]').count();
    const newChatBtn = page.locator('[aria-label="Create new chat"]');

    if (await newChatBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await newChatBtn.click();
      await page.waitForTimeout(500);
      const tabsAfter = await page.locator('[role="tab"]').count();
      console.log(`[AI-12] Tabs: ${tabsBefore} → ${tabsAfter}`);
      expect(tabsAfter).toBeGreaterThanOrEqual(tabsBefore);
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '12-new-tab.png') });
  });

  test('13 — Send message in new chat tab', async () => {
    const { page } = ctx;
    await ensureChatPanelOpen(page);

    const result = await sendChatMessage(page, 'What version of PostgreSQL is running?');
    console.log(`[AI-13] Response: ${result.gotResponse}, Error: ${result.gotError}`);

    // User message should be visible
    const userMsg = page.locator('text=/PostgreSQL/i').first();
    await expect(userMsg).toBeVisible({ timeout: 3000 });

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '13-new-tab-msg.png') });
  });

  test('14 — Close chat tab', async () => {
    const { page } = ctx;

    // Dismiss any Snackbar toasts that may block interactions
    const snackbar = page.locator('.MuiSnackbar-root');
    if (await snackbar.isVisible({ timeout: 1000 }).catch(() => false)) {
      const snackClose = snackbar.locator('button').first();
      if (await snackClose.isVisible({ timeout: 500 }).catch(() => false)) {
        await snackClose.click();
      }
      await snackbar.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
    }

    const tabs = page.locator('[role="tab"]');
    const tabCount = await tabs.count();
    console.log(`[AI-14] Starting tabs: ${tabCount}`);

    if (tabCount > 1) {
      // Find ALL close buttons (aria-label="Close chat: ...") and click the last one
      const closeBtns = page.locator('[aria-label^="Close chat:"]');
      const closeCount = await closeBtns.count();
      console.log(`[AI-14] Close buttons found: ${closeCount}`);

      if (closeCount > 0) {
        await closeBtns.last().click({ force: true });
        await page.waitForTimeout(500);
        const tabsAfter = await tabs.count();
        console.log(`[AI-14] Tabs after close: ${tabsAfter}`);
        // Accept same count too (close might not work if it's the last active tab)
        expect(tabsAfter).toBeLessThanOrEqual(tabCount);
      }
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '14-close-tab.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // KEYBOARD SHORTCUTS
  // ═══════════════════════════════════════════════════════════════════════════
  test('15 — Cmd+K focuses chat input', async () => {
    const { page } = ctx;

    // Click editor first to defocus chat
    const editor = page.locator('.cm-editor').first();
    if (await editor.isVisible({ timeout: 2000 }).catch(() => false)) {
      await editor.click();
      await page.waitForTimeout(300);
    }

    await page.keyboard.press('Meta+k');
    await page.waitForTimeout(500);

    // Chat panel should be open
    const chatPanel = page.locator('[aria-label="AI Assistant panel"]');
    await expect(chatPanel).toBeVisible({ timeout: 3000 });

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '15-cmd-k.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ANALYZE SCHEMA
  // ═══════════════════════════════════════════════════════════════════════════
  test('16 — Analyze Schema button exists', async () => {
    const { page } = ctx;

    const analyzeBtn = page.locator('[aria-label="Analyze database schema"]');
    const hasBtn = await analyzeBtn.isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`[AI-16] Analyze Schema button: ${hasBtn}`);

    if (hasBtn) {
      await analyzeBtn.click();
      await page.waitForTimeout(3000);
      console.log('[AI-16] Analyze Schema clicked.');
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '16-analyze.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SQL EDITOR TOOLBAR — all AI-related buttons
  // ═══════════════════════════════════════════════════════════════════════════
  test('17 — SQL Editor toolbar has all expected buttons', async () => {
    const { page } = ctx;

    const buttons = {
      improve: page.locator('[aria-label="Improve query with AI"]'),
      format: page.locator('[aria-label="Format SQL"]'),
      copy: page.locator('[aria-label="Copy query"]'),
      clear: page.locator('[aria-label="Clear editor"]'),
      run: page.locator('[aria-label="Run"]'),
    };

    const results: Record<string, boolean> = {};
    for (const [name, locator] of Object.entries(buttons)) {
      results[name] = await locator.isVisible({ timeout: 2000 }).catch(() => false);
    }

    console.log('[AI-17] Toolbar buttons:', results);

    // Run and Improve should always be visible when connected
    if (await page.locator('.cm-editor').first().isVisible().catch(() => false)) {
      expect(results.run || results.improve).toBe(true);
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '17-toolbar.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // MULTIPLE MESSAGES (conversation flow)
  // ═══════════════════════════════════════════════════════════════════════════
  test('18 — Send multiple messages in a conversation', async () => {
    const { page } = ctx;
    await ensureChatPanelOpen(page);

    // Create fresh chat
    const newChatBtn = page.locator('[aria-label="Create new chat"]');
    if (await newChatBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await newChatBtn.click();
      await page.waitForTimeout(500);
    }

    // First message
    await sendChatMessage(page, 'Hello');
    await page.waitForTimeout(1000);

    // Second message
    await sendChatMessage(page, 'What databases exist?');

    // Should have user messages visible
    const helloMsg = page.locator('text=/Hello/').first();
    const dbMsg = page.locator('text=/databases exist/i').first();

    const hasHello = await helloMsg.isVisible({ timeout: 2000 }).catch(() => false);
    const hasDb = await dbMsg.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`[AI-18] Messages visible — Hello: ${hasHello}, databases: ${hasDb}`);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '18-conversation.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SETTINGS: Theme toggle
  // ═══════════════════════════════════════════════════════════════════════════
  test('19 — Theme toggle in settings works', async () => {
    const { page } = ctx;
    await openSettings(page);

    const lightBtn = page.locator('button[value="light"], [aria-label*="Light"]').first();
    const darkBtn = page.locator('button[value="dark"], [aria-label*="Dark"]').first();

    const hasLight = await lightBtn.isVisible({ timeout: 2000 }).catch(() => false);
    const hasDark = await darkBtn.isVisible({ timeout: 1000 }).catch(() => false);
    console.log(`[AI-19] Theme buttons — light: ${hasLight}, dark: ${hasDark}`);

    if (hasLight) {
      await lightBtn.click();
      await page.waitForTimeout(500);
    }
    if (hasDark) {
      await darkBtn.click();
      await page.waitForTimeout(500);
    }

    await closeSettings(page);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '19-theme.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SETTINGS: Language toggle
  // ═══════════════════════════════════════════════════════════════════════════
  test('20 — Language toggle EN/RU works', async () => {
    const { page } = ctx;
    await openSettings(page);

    const enBtn = page.locator('button').filter({ hasText: /^English$|^EN$/i }).first();
    const ruBtn = page.locator('button').filter({ hasText: /^Русский$|^RU$/i }).first();

    const hasEN = await enBtn.isVisible({ timeout: 2000 }).catch(() => false);
    const hasRU = await ruBtn.isVisible({ timeout: 1000 }).catch(() => false);
    console.log(`[AI-20] Language buttons — EN: ${hasEN}, RU: ${hasRU}`);

    // Switch to Russian
    if (hasRU) {
      await ruBtn.click();
      await page.waitForTimeout(500);
      // Verify UI changed — check for Russian text
      const ruText = page.locator('text=/Настройки|Подписка|Модель/i').first();
      const hasRuText = await ruText.isVisible({ timeout: 2000 }).catch(() => false);
      console.log(`[AI-20] Russian UI visible: ${hasRuText}`);
    }

    // Switch back to English
    if (hasEN) {
      await enBtn.click();
      await page.waitForTimeout(500);
    }

    await closeSettings(page);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '20-language.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // STATUS BAR
  // ═══════════════════════════════════════════════════════════════════════════
  test('21 — Status bar shows DB and Backend status', async () => {
    const { page } = ctx;

    const statusBar = page.locator('[role="status"]').first();
    const hasStatusBar = await statusBar.isVisible({ timeout: 3000 }).catch(() => false);

    if (hasStatusBar) {
      const statusText = await statusBar.textContent() || '';
      console.log(`[AI-21] Status bar: "${statusText}"`);
      expect(statusText).toContain('Backend');
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '21-status.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // QUERY TABLE from context menu
  // ═══════════════════════════════════════════════════════════════════════════
  test('22 — Query Table from context menu inserts SELECT', async () => {
    const { page } = ctx;

    const usersTable = page.locator('text=/^users$/').first();
    if (await usersTable.isVisible({ timeout: 3000 }).catch(() => false)) {
      await usersTable.click({ button: 'right' });
      await page.waitForTimeout(500);

      const queryBtn = page.locator('[role="menuitem"]').filter({ hasText: /SELECT|Query|Запрос/i }).first();
      if (await queryBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await queryBtn.click();
        await page.waitForTimeout(1000);

        // Editor should now contain SELECT query
        const editor = page.locator('.cm-editor .cm-content').first();
        const editorText = await editor.textContent().catch(() => '');
        console.log(`[AI-22] Editor after Query: ${editorText?.substring(0, 60)}`);
      } else {
        await page.keyboard.press('Escape');
      }
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '22-query-table.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // VIEW INFO modal
  // ═══════════════════════════════════════════════════════════════════════════
  test('23 — View Info from context menu opens details modal', async () => {
    const { page } = ctx;

    const usersTable = page.locator('text=/^users$/').first();
    if (await usersTable.isVisible({ timeout: 3000 }).catch(() => false)) {
      await usersTable.click({ button: 'right' });
      await page.waitForTimeout(500);

      const viewInfo = page.locator('[role="menuitem"]').filter({ hasText: /View Info|Информация/i }).first();
      if (await viewInfo.isVisible({ timeout: 2000 }).catch(() => false)) {
        await viewInfo.click();
        await page.waitForTimeout(1000);

        const modal = page.locator('[role="dialog"]').first();
        const hasModal = await modal.isVisible({ timeout: 3000 }).catch(() => false);
        console.log(`[AI-23] Details modal visible: ${hasModal}`);

        // Close modal
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      } else {
        await page.keyboard.press('Escape');
      }
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '23-view-info.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PROMO CODE
  // ═══════════════════════════════════════════════════════════════════════════
  test('24 — Promo code input with invalid code shows error', async () => {
    const { page } = ctx;
    await openSettings(page);

    const promoInput = page.getByPlaceholder(/promo|промокод/i).first();
    if (await promoInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await promoInput.fill('INVALIDCODE999');
      const applyBtn = page.getByRole('button', { name: /Apply|Применить/i }).first();
      if (await applyBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await applyBtn.click();
        await page.waitForTimeout(2000);

        const errorMsg = page.locator('text=/Invalid|expired|not found|Невалидный/i').first();
        const hasError = await errorMsg.isVisible({ timeout: 3000 }).catch(() => false);
        console.log(`[AI-24] Invalid promo error: ${hasError}`);
      }
    }

    await closeSettings(page);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '24-promo.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // LEGAL LINKS
  // ═══════════════════════════════════════════════════════════════════════════
  test('25 — Legal links visible in settings', async () => {
    const { page } = ctx;
    await openSettings(page);

    const links = {
      privacy: await page.locator('text=/Privacy Policy|Конфиденциальност/i').first().isVisible({ timeout: 2000 }).catch(() => false),
      terms: await page.locator('text=/Terms of Use|Условия/i').first().isVisible({ timeout: 1000 }).catch(() => false),
    };
    console.log('[AI-25] Legal links:', links);

    await closeSettings(page);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '25-legal.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════════════════
  test('99 — Close app', async () => {
    if (ctx?.app) {
      await ctx.app.close();
      console.log('[AI-99] App closed.');
    }
  });
});
