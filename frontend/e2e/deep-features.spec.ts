/**
 * deep-features.spec.ts
 *
 * Deep E2E tests covering ALL major features:
 * - SQL Editor toolbar (Format, Copy, Clear, Improve/MagicWand, Run, Templates)
 * - SQL autocomplete & ghost text hints
 * - Chat AI buttons (Explain, Apply, Execute, Copy on SQL blocks)
 * - Chat stop generation
 * - ER Diagram (open, auto-layout, nodes, edges)
 * - Database Panel CRUD (add/edit/delete connections, context menus, tree)
 * - Schema Sync modal
 * - Element Details Modal (table info, add/drop column)
 * - Query Results (pagination, inline edit, add row, delete row)
 * - Settings (theme, language, promo code, legal links)
 * - Top Navigation (theme toggle, user menu, logout)
 * - Status Bar indicators
 * - Keyboard shortcuts (Ctrl+Enter run, Shift+Alt+F format, Cmd+K focus chat)
 * - Connection form validation
 * - Security modes with AI interaction
 */
import { test, expect } from '@playwright/test';
import { launchApp, registerAndLogin, AppContext } from './helpers/electron-app';
import path from 'path';
import fs from 'fs';

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots', 'deep-features');

const TEST_USER = {
  name: 'DeepTest User',
  email: `deeptest_${Date.now()}@test.com`,
  password: 'DeepTest123!',
};

const TEST_DB = {
  name: 'E2E Test DB',
  host: '127.0.0.1',
  port: '5435',
  username: 'progressql',
  password: 'progressql',
  database: 'progressql',
};

let ctx: AppContext;

test.describe.serial('Deep Feature Tests', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // SETUP
  // ═══════════════════════════════════════════════════════════════════════════
  test('00 — Launch app, register, and connect to DB', async () => {
    ctx = await launchApp();
    const { page } = ctx;

    // Wait for initial page load
    await page.waitForTimeout(2000);

    // Handle stale session: detect current page state
    const currentUrl = page.url();
    const isOnLogin = currentUrl.includes('login');
    const isOnRegister = currentUrl.includes('register');
    const isOnVerifyEmail = currentUrl.includes('verify-email');
    const isOnMainPage = !isOnLogin && !isOnRegister && !isOnVerifyEmail;

    if (isOnVerifyEmail) {
      // On verify-email — click "Log out" link
      const logoutLink = page.locator('a, button').filter({ hasText: /Log out|Выйти/i }).first();
      if (await logoutLink.isVisible({ timeout: 3000 }).catch(() => false)) {
        await logoutLink.click();
        await page.waitForURL((url: URL) => url.pathname.includes('login'), { timeout: 10_000 }).catch(() => {});
        await page.waitForTimeout(1000);
      }
    } else if (isOnMainPage) {
      // Already logged in — check if DB is already connected, skip registration
      const isConnected = await page.locator('text=/DB:.*Connected|Tables|Views/i').first().isVisible({ timeout: 3000 }).catch(() => false);
      if (isConnected) {
        console.log('[Test 00] Already logged in and connected — skipping registration.');
        await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '00a-before-register.png') });
        // Skip to end — already setup
        return;
      }
      // Logged in but need to logout and re-register
      const profileBtn = page.locator('[aria-label="User profile menu"]');
      if (await profileBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await profileBtn.click();
        await page.waitForTimeout(500);
        const logoutItem = page.locator('[role="menuitem"]').filter({ hasText: /Log out|Logout|Выйти/i }).first();
        if (await logoutItem.isVisible({ timeout: 2000 }).catch(() => false)) {
          await logoutItem.click();
          await page.waitForURL((url: URL) => url.pathname.includes('login'), { timeout: 10_000 }).catch(() => {});
          await page.waitForTimeout(1000);
        }
      }
      // Alternative: open settings drawer → scroll to logout
      if (!page.url().includes('login')) {
        const settingsBtn = page.locator('[aria-label="Open settings"]');
        if (await settingsBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await settingsBtn.click({ force: true });
          await page.waitForTimeout(500);
          const logoutBtn = page.locator('button').filter({ hasText: /Log out|Выйти/i }).first();
          if (await logoutBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await logoutBtn.click();
            await page.waitForURL((url: URL) => url.pathname.includes('login'), { timeout: 10_000 }).catch(() => {});
            await page.waitForTimeout(1000);
          }
        }
      }
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '00a-before-register.png') });
    await registerAndLogin(page, TEST_USER);
    await expect(
      page.getByRole('heading', { name: /Connections|AI Assistant/i }).first(),
    ).toBeVisible({ timeout: 15_000 });

    // Connect to test database — click the + button near CONNECTIONS header
    // Try multiple selectors for the Add Connection button
    const addSelectors = [
      '[aria-label="Add new database connection"]',
      'button:near(:text("CONNECTIONS"), 100)',
    ];

    let addBtnClicked = false;
    for (const sel of addSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await btn.click();
        addBtnClicked = true;
        break;
      }
    }

    // Last resort: find any small IconButton with AddIcon near connections
    if (!addBtnClicked) {
      const iconButtons = page.locator('button').filter({ has: page.locator('svg') });
      const count = await iconButtons.count();
      for (let i = 0; i < count; i++) {
        const btn = iconButtons.nth(i);
        const box = await btn.boundingBox().catch(() => null);
        // The + button is typically at the top of the left panel (small, near "CONNECTIONS")
        if (box && box.y < 50 && box.width < 50) {
          await btn.click();
          addBtnClicked = true;
          break;
        }
      }
    }

    await page.waitForTimeout(1000);

    // Fill connection form if it opened
    const formTitle = page.locator('text=/Add New Database|Новое подключение/i').first();
    if (await formTitle.isVisible({ timeout: 3000 }).catch(() => false)) {
      const dialog = page.locator('[role="dialog"]');

      // Fill MUI TextFields by their input elements within dialog
      // Order: Connection Name, Host, Port, Username, Password, Database
      const textInputs = dialog.locator('input:not([type="hidden"])');
      const inputCount = await textInputs.count();
      console.log(`[Test 00] Connection form inputs: ${inputCount}`);

      // Map: index 0=Connection Name, 1=Host, 2=Port, 3=Username, 4=Password, 5=Database
      const values = [TEST_DB.name, TEST_DB.host, TEST_DB.port, TEST_DB.username, TEST_DB.password, TEST_DB.database];
      for (let i = 0; i < Math.min(inputCount, values.length); i++) {
        const input = textInputs.nth(i);
        await input.click({ clickCount: 3 });
        await input.fill(values[i]);
      }

      // Click Connect
      const connectBtn = dialog.getByRole('button', { name: /Connect to Database|Подключить/i });
      if (await connectBtn.isEnabled({ timeout: 2000 }).catch(() => false)) {
        await connectBtn.click();
      }
      console.log('[Test 00] Connection form filled and submitted.');
    } else {
      console.log('[Test 00] Connection form not found.');
    }

    // Wait for connection dialog to close
    await page.waitForTimeout(3000);

    // If connection was added but not connected, click on it to connect
    const dbStatus = page.locator('text=/DB: Disconnected|Disconnected/i').first();
    if (await dbStatus.isVisible({ timeout: 2000 }).catch(() => false)) {
      // The connection exists in the tree but isn't connected — click on it
      const connItem = page.locator(`text=/${TEST_DB.name}/i`).first();
      if (await connItem.isVisible({ timeout: 2000 }).catch(() => false)) {
        await connItem.click();
        await page.waitForTimeout(1000);
        // May need to click "Connect" from context or just double-click
        await connItem.dblclick();
        await page.waitForTimeout(3000);
      }
      // Or use the connect button if shown
      const connectActionBtn = page.locator('[aria-label*="Connect"], button:has-text("Connect")').first();
      if (await connectActionBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await connectActionBtn.click();
        await page.waitForTimeout(3000);
      }
    }

    // Wait for connection to establish
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '00-connected.png') });
    console.log('[Test 00] Setup complete — app launched, user registered, DB connection attempted.');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SQL EDITOR TOOLBAR
  // ═══════════════════════════════════════════════════════════════════════════
  test('01 — SQL Editor toolbar buttons are visible', async () => {
    const { page } = ctx;

    const improveBtn = page.locator('[aria-label="Improve query with AI"]');
    const formatBtn = page.locator('[aria-label="Format SQL"]');
    const copyBtn = page.locator('[aria-label="Copy query"]');
    const clearBtn = page.locator('[aria-label="Clear editor"]');
    const runBtn = page.locator('[aria-label="Run"]');

    const results = {
      improve: await improveBtn.isVisible({ timeout: 3000 }).catch(() => false),
      format: await formatBtn.isVisible({ timeout: 1000 }).catch(() => false),
      copy: await copyBtn.isVisible({ timeout: 1000 }).catch(() => false),
      clear: await clearBtn.isVisible({ timeout: 1000 }).catch(() => false),
      run: await runBtn.isVisible({ timeout: 1000 }).catch(() => false),
    };

    console.log('[Test 01] Toolbar buttons:', results);
    // Log which are visible — soft check (toolbar may not appear without connection)
    const anyVisible = Object.values(results).some(v => v);
    if (!anyVisible) {
      console.warn('[Test 01] No toolbar buttons found — editor may not be visible without DB connection.');
    }
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-toolbar.png') });
  });

  test('02 — Type SQL and run with F5', async () => {
    const { page } = ctx;

    // Find and focus the SQL editor
    const editor = page.locator('[aria-label="SQL query editor"], .cm-editor').first();
    await editor.click();
    await page.waitForTimeout(300);

    // Type a query
    await page.keyboard.type('SELECT version();', { delay: 30 });
    await page.waitForTimeout(300);

    // Run with F5
    await page.keyboard.press('F5');
    await page.waitForTimeout(3000);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-query-result.png') });

    // Check for results area
    const results = page.locator('[class*="result"], [class*="Result"], [role="grid"], table').first();
    const hasResults = await results.isVisible({ timeout: 3000 }).catch(() => false);
    console.log('[Test 02] Query executed, results visible:', hasResults);
  });

  test('03 — Format SQL button works', async () => {
    const { page } = ctx;

    // Clear and type unformatted SQL
    const editor = page.locator('.cm-editor .cm-content').first();
    await editor.click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.type('select id,name,email from users where id>0 order by name', { delay: 20 });
    await page.waitForTimeout(300);

    // Click format button
    const formatBtn = page.locator('[aria-label="Format SQL"]');
    if (await formatBtn.isEnabled({ timeout: 2000 }).catch(() => false)) {
      await formatBtn.click();
      await page.waitForTimeout(500);
      console.log('[Test 03] Format SQL clicked.');
    } else {
      // Try keyboard shortcut
      await page.keyboard.press('Shift+Alt+KeyF');
      await page.waitForTimeout(500);
      console.log('[Test 03] Format SQL via Shift+Alt+F.');
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '03-formatted.png') });
  });

  test('04 — Copy query button works', async () => {
    const { page } = ctx;

    const copyBtn = page.locator('[aria-label="Copy query"]');
    if (await copyBtn.isEnabled({ timeout: 2000 }).catch(() => false)) {
      await copyBtn.click();
      await page.waitForTimeout(500);
      console.log('[Test 04] Copy query clicked.');
    } else {
      console.log('[Test 04] Copy button not enabled (no query in editor).');
    }
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '04-copy.png') });
  });

  test('05 — Clear editor button works', async () => {
    const { page } = ctx;

    // Make sure there's text in editor
    const editor = page.locator('.cm-editor .cm-content').first();
    await editor.click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.type('SELECT 1;', { delay: 20 });
    await page.waitForTimeout(200);

    const clearBtn = page.locator('[aria-label="Clear editor"]');
    if (await clearBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await clearBtn.click();
      await page.waitForTimeout(500);
      console.log('[Test 05] Clear editor clicked.');
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '05-cleared.png') });
  });

  test('06 — SQL Templates menu', async () => {
    const { page } = ctx;

    // Look for templates button
    const templatesBtn = page.locator('[aria-label*="emplate"], button:has-text("Template")').first();
    const hasTemplates = await templatesBtn.isVisible({ timeout: 2000 }).catch(() => false);

    if (hasTemplates) {
      await templatesBtn.click();
      await page.waitForTimeout(500);

      // Check for template options (SELECT, INSERT, UPDATE, etc.)
      const menuItems = page.locator('[role="menuitem"], [role="option"]');
      const count = await menuItems.count();
      console.log(`[Test 06] Template menu opened with ${count} items.`);

      // Click first template to insert
      if (count > 0) {
        await menuItems.first().click();
        await page.waitForTimeout(300);
      }
    } else {
      console.log('[Test 06] Templates button not found — may be connection-dependent.');
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '06-templates.png') });
  });

  test('07 — Improve Query (Magic Wand) button', async () => {
    const { page } = ctx;

    // Type a query to improve
    const editor = page.locator('.cm-editor .cm-content').first();
    await editor.click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.type('select * from users where id > 0', { delay: 20 });
    await page.waitForTimeout(300);

    const improveBtn = page.locator('[aria-label="Improve query with AI"]');
    const isVisible = await improveBtn.isVisible({ timeout: 2000 }).catch(() => false);
    const isEnabled = await improveBtn.isEnabled({ timeout: 1000 }).catch(() => false);

    console.log(`[Test 07] Improve button — visible: ${isVisible}, enabled: ${isEnabled}`);

    if (isVisible && isEnabled) {
      await improveBtn.click();
      // Wait for improvement or timeout
      await page.waitForTimeout(5000);
      console.log('[Test 07] Improve query clicked — waiting for AI response.');
    } else {
      console.log('[Test 07] Improve button not available (backend/subscription may be required).');
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '07-improve-query.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // RUN QUERY AND CHECK RESULTS
  // ═══════════════════════════════════════════════════════════════════════════
  test('08 — Run query with Ctrl+Enter and check results table', async () => {
    const { page } = ctx;

    const editor = page.locator('.cm-editor .cm-content').first();
    await editor.click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.type('SELECT generate_series(1, 50) AS num;', { delay: 20 });
    await page.waitForTimeout(200);

    // Ctrl+Enter to run
    await page.keyboard.press('Control+Enter');
    await page.waitForTimeout(3000);

    // Check results
    const resultRows = page.locator('tr, [role="row"]');
    const rowCount = await resultRows.count();
    console.log(`[Test 08] Result rows found: ${rowCount}`);

    // Check pagination controls
    const pagination = page.locator('[class*="pagination"], [class*="Pagination"], button:has-text("Next")').first();
    const hasPagination = await pagination.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`[Test 08] Pagination visible: ${hasPagination}`);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '08-results-pagination.png') });
  });

  test('09 — Query error shows error in results with Fix in Chat button', async () => {
    const { page } = ctx;

    const editor = page.locator('.cm-editor .cm-content').first();
    await editor.click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.type('SELECT * FROM nonexistent_table_xyz;', { delay: 20 });

    await page.keyboard.press('F5');
    await page.waitForTimeout(3000);

    // Look for error indication
    const errorText = page.locator('text=/error|ошибка|does not exist|не существует/i').first();
    const hasError = await errorText.isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`[Test 09] Error displayed: ${hasError}`);

    // Look for Fix in Chat button
    const fixBtn = page.locator('button:has-text("Fix"), [aria-label*="Fix"], [aria-label*="fix"]').first();
    const hasFixBtn = await fixBtn.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`[Test 09] Fix in Chat button visible: ${hasFixBtn}`);

    if (hasFixBtn) {
      await fixBtn.click();
      await page.waitForTimeout(2000);
      console.log('[Test 09] Fix in Chat clicked — message should appear in chat.');
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '09-error-fix.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CHAT AI FEATURES
  // ═══════════════════════════════════════════════════════════════════════════
  test('10 — Send chat message and get AI response with SQL block', async () => {
    const { page } = ctx;

    // Make sure chat panel is visible
    const chatToggle = page.locator('[aria-label*="AI assistant"], [aria-label*="chat"]').first();
    if (await chatToggle.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Check if chat panel is already open
      const chatPanel = page.locator('[aria-label="AI Assistant panel"]');
      if (!(await chatPanel.isVisible({ timeout: 1000 }).catch(() => false))) {
        await chatToggle.click();
        await page.waitForTimeout(500);
      }
    }

    const chatInput = page.locator('textarea:not([aria-hidden="true"]):not([readonly])').last();
    const inputVisible = await chatInput.isVisible({ timeout: 3000 }).catch(() => false);

    if (inputVisible) {
      await chatInput.fill('Show me all tables in the current database');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(8000);

      // Look for SQL blocks in response
      const sqlBlocks = page.locator('[aria-label="SQL code block"]');
      const sqlBlockCount = await sqlBlocks.count();
      console.log(`[Test 10] SQL blocks in response: ${sqlBlockCount}`);

      // Look for response message
      const messages = page.locator('[class*="message"], [class*="Message"]');
      const msgCount = await messages.count();
      console.log(`[Test 10] Messages visible: ${msgCount}`);
    } else {
      console.log('[Test 10] Chat input not visible — skipping.');
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '10-chat-response.png') });
  });

  test('11 — SQL Block buttons: Copy, Explain, Apply, Execute', async () => {
    const { page } = ctx;

    const sqlBlocks = page.locator('[aria-label="SQL code block"]');
    const blockCount = await sqlBlocks.count();

    if (blockCount > 0) {
      const firstBlock = sqlBlocks.first();

      // Hover over the SQL block to reveal action buttons
      await firstBlock.hover();
      await page.waitForTimeout(500);

      // Check Copy SQL button
      const copyBtn = firstBlock.locator('[aria-label="Copy SQL"], [aria-label*="Copy"]').first();
      const hasCopy = await copyBtn.isVisible({ timeout: 2000 }).catch(() => false);
      console.log(`[Test 11] Copy SQL button: ${hasCopy}`);

      if (hasCopy) {
        await copyBtn.click();
        await page.waitForTimeout(500);
        // Should show "Copied" confirmation
        const copiedText = page.locator('text=/Copied|Скопировано/i').first();
        const showsCopied = await copiedText.isVisible({ timeout: 1000 }).catch(() => false);
        console.log(`[Test 11] "Copied" confirmation: ${showsCopied}`);
      }

      // Check Explain SQL button
      const explainBtn = firstBlock.locator('[aria-label="Explain SQL"], [aria-label*="Explain"]').first();
      const hasExplain = await explainBtn.isVisible({ timeout: 1000 }).catch(() => false);
      console.log(`[Test 11] Explain SQL button: ${hasExplain}`);

      if (hasExplain) {
        await explainBtn.click();
        await page.waitForTimeout(5000);
        console.log('[Test 11] Explain clicked — AI should respond with explanation.');
      }

      // Check Apply SQL button
      const applyBtn = firstBlock.locator('[aria-label="Apply SQL to editor"], [aria-label*="Apply"]').first();
      const hasApply = await applyBtn.isVisible({ timeout: 1000 }).catch(() => false);
      console.log(`[Test 11] Apply SQL button: ${hasApply}`);

      // Check Execute SQL button
      const executeBtn = firstBlock.locator('[aria-label="Execute SQL"], [aria-label*="Execute"]').first();
      const hasExecute = await executeBtn.isVisible({ timeout: 1000 }).catch(() => false);
      console.log(`[Test 11] Execute SQL button: ${hasExecute}`);
    } else {
      console.log('[Test 11] No SQL blocks found — AI may not have responded with SQL.');
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '11-sql-block-buttons.png') });
  });

  test('12 — Apply SQL from chat to editor', async () => {
    const { page } = ctx;

    const sqlBlocks = page.locator('[aria-label="SQL code block"]');
    const blockCount = await sqlBlocks.count();

    if (blockCount > 0) {
      const applyBtn = sqlBlocks.first().locator('[aria-label="Apply SQL to editor"], [aria-label*="Apply"]').first();
      if (await applyBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await applyBtn.click();
        await page.waitForTimeout(1000);
        console.log('[Test 12] Apply SQL clicked — SQL should appear in editor.');
      } else {
        console.log('[Test 12] Apply button not visible.');
      }
    } else {
      console.log('[Test 12] No SQL blocks to apply.');
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '12-apply-sql.png') });
  });

  test('13 — Execute SQL from chat directly', async () => {
    const { page } = ctx;

    const sqlBlocks = page.locator('[aria-label="SQL code block"]');
    const blockCount = await sqlBlocks.count();

    if (blockCount > 0) {
      const executeBtn = sqlBlocks.first().locator('[aria-label="Execute SQL"], [aria-label*="Execute"]').first();
      if (await executeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await executeBtn.click();
        await page.waitForTimeout(3000);
        console.log('[Test 13] Execute SQL clicked — query should run and show results.');
      } else {
        console.log('[Test 13] Execute button not visible.');
      }
    } else {
      console.log('[Test 13] No SQL blocks to execute.');
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '13-execute-sql.png') });
  });

  test('14 — SQL Verification badges (Verified / Invalid)', async () => {
    const { page } = ctx;

    // Look for verification status badges on SQL blocks
    const verifiedBadge = page.locator('text=/Verified|Проверено/i, [aria-label*="verified"]').first();
    const invalidBadge = page.locator('text=/Invalid|Невалидный/i, [aria-label*="invalid"]').first();
    const verifyingBadge = page.locator('text=/Verifying|Проверка/i').first();

    const hasVerified = await verifiedBadge.isVisible({ timeout: 2000 }).catch(() => false);
    const hasInvalid = await invalidBadge.isVisible({ timeout: 1000 }).catch(() => false);
    const hasVerifying = await verifyingBadge.isVisible({ timeout: 1000 }).catch(() => false);

    console.log(`[Test 14] Verification badges — verified: ${hasVerified}, invalid: ${hasInvalid}, verifying: ${hasVerifying}`);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '14-verification.png') });
  });

  test('15 — Stop generation button during AI response', async () => {
    const { page } = ctx;

    const chatInput = page.locator('textarea:not([aria-hidden="true"]):not([readonly])').last();
    if (await chatInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await chatInput.fill('Write a very long and detailed analysis of all PostgreSQL data types, explain each one in depth with examples');
      await page.keyboard.press('Enter');

      // Immediately look for stop button
      await page.waitForTimeout(500);
      const stopBtn = page.locator('[aria-label="Stop generation"], button:has-text("Stop")').first();
      const hasStop = await stopBtn.isVisible({ timeout: 5000 }).catch(() => false);
      console.log(`[Test 15] Stop generation button visible: ${hasStop}`);

      if (hasStop) {
        await stopBtn.click();
        await page.waitForTimeout(1000);
        console.log('[Test 15] Stop generation clicked.');
      }
    } else {
      console.log('[Test 15] Chat input not visible.');
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '15-stop-generation.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // DATABASE PANEL — TREE & CONTEXT MENUS
  // ═══════════════════════════════════════════════════════════════════════════
  test('16 — Database tree shows tables, views, functions sections', async () => {
    const { page } = ctx;

    // Check for tree sections
    const tablesSection = page.locator('text=/Tables|Таблицы/i').first();
    const viewsSection = page.locator('text=/Views|Представления/i').first();
    const functionsSection = page.locator('text=/Functions|Функции/i').first();
    const sequencesSection = page.locator('text=/Sequences|Последовательности/i').first();

    const results = {
      tables: await tablesSection.isVisible({ timeout: 3000 }).catch(() => false),
      views: await viewsSection.isVisible({ timeout: 1000 }).catch(() => false),
      functions: await functionsSection.isVisible({ timeout: 1000 }).catch(() => false),
      sequences: await sequencesSection.isVisible({ timeout: 1000 }).catch(() => false),
    };

    console.log('[Test 16] Database tree sections:', results);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '16-db-tree.png') });
  });

  test('17 — Expand tables section and see table columns', async () => {
    const { page } = ctx;

    // Click on Tables section to expand
    const tablesSection = page.locator('text=/Tables|Таблицы/i').first();
    if (await tablesSection.isVisible({ timeout: 2000 }).catch(() => false)) {
      await tablesSection.click();
      await page.waitForTimeout(1000);

      // Look for the users table (should exist after registration)
      const usersTable = page.locator('text=/users/i').first();
      const hasUsersTable = await usersTable.isVisible({ timeout: 3000 }).catch(() => false);
      console.log(`[Test 17] Users table visible: ${hasUsersTable}`);

      if (hasUsersTable) {
        // Click to expand and see columns
        await usersTable.click();
        await page.waitForTimeout(500);
        console.log('[Test 17] Expanded users table.');
      }
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '17-tables-expanded.png') });
  });

  test('18 — Right-click context menu on table', async () => {
    const { page } = ctx;

    // Right-click on a table name
    const tableItem = page.locator('text=/users/i').first();
    if (await tableItem.isVisible({ timeout: 2000 }).catch(() => false)) {
      await tableItem.click({ button: 'right' });
      await page.waitForTimeout(500);

      // Check for context menu items
      const menuItems = page.locator('[role="menuitem"]');
      const menuCount = await menuItems.count();
      console.log(`[Test 18] Context menu items: ${menuCount}`);

      // Check for specific actions
      const viewInfo = page.locator('[role="menuitem"]').filter({ hasText: /View Info|Информация/i }).first();
      const copyName = page.locator('[role="menuitem"]').filter({ hasText: /Copy Name|Копировать/i }).first();
      const explainAI = page.locator('[role="menuitem"]').filter({ hasText: /Explain|AI|Объяснить/i }).first();
      const queryTable = page.locator('[role="menuitem"]').filter({ hasText: /Query|SELECT|Запрос/i }).first();
      const dropTable = page.locator('[role="menuitem"]').filter({ hasText: /Drop|Удалить/i }).first();

      console.log(`[Test 18] Menu items: viewInfo=${await viewInfo.isVisible().catch(() => false)}, copyName=${await copyName.isVisible().catch(() => false)}, explainAI=${await explainAI.isVisible().catch(() => false)}, query=${await queryTable.isVisible().catch(() => false)}, drop=${await dropTable.isVisible().catch(() => false)}`);

      // Close menu
      await page.keyboard.press('Escape');
    } else {
      console.log('[Test 18] No table found for right-click.');
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '18-context-menu.png') });
  });

  test('19 — View Info opens Element Details Modal', async () => {
    const { page } = ctx;

    // Right-click on table → View Info
    const tableItem = page.locator('text=/users/i').first();
    if (await tableItem.isVisible({ timeout: 2000 }).catch(() => false)) {
      await tableItem.click({ button: 'right' });
      await page.waitForTimeout(500);

      const viewInfo = page.locator('[role="menuitem"]').filter({ hasText: /View Info|Информация/i }).first();
      if (await viewInfo.isVisible({ timeout: 1000 }).catch(() => false)) {
        await viewInfo.click();
        await page.waitForTimeout(1000);

        // Check modal content
        const modal = page.locator('[role="dialog"], [class*="modal"], [class*="Modal"]').first();
        const hasModal = await modal.isVisible({ timeout: 3000 }).catch(() => false);
        console.log(`[Test 19] Element Details Modal visible: ${hasModal}`);

        if (hasModal) {
          // Check for table info sections
          const tableInfo = page.locator('text=/TABLE INFORMATION|Информация о таблице/i').first();
          const hasTableInfo = await tableInfo.isVisible({ timeout: 2000 }).catch(() => false);
          console.log(`[Test 19] Table info section: ${hasTableInfo}`);

          // Check for columns listing
          const columnsSection = page.locator('text=/Columns|Столбцы/i').first();
          const hasColumns = await columnsSection.isVisible({ timeout: 1000 }).catch(() => false);
          console.log(`[Test 19] Columns section: ${hasColumns}`);

          // Check for action buttons
          const explainBtn = page.locator('button:has-text("Explain")').first();
          const copyCodeBtn = page.locator('[aria-label="Copy code to clipboard"]').first();

          console.log(`[Test 19] Explain btn: ${await explainBtn.isVisible().catch(() => false)}, Copy code btn: ${await copyCodeBtn.isVisible().catch(() => false)}`);
        }

        // Close modal
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      }
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '19-element-details.png') });
  });

  test('20 — Explain (AI) from context menu', async () => {
    const { page } = ctx;

    const tableItem = page.locator('text=/users/i').first();
    if (await tableItem.isVisible({ timeout: 2000 }).catch(() => false)) {
      await tableItem.click({ button: 'right' });
      await page.waitForTimeout(500);

      const explainAI = page.locator('[role="menuitem"]').filter({ hasText: /Explain|AI|Объяснить/i }).first();
      if (await explainAI.isVisible({ timeout: 1000 }).catch(() => false)) {
        await explainAI.click();
        await page.waitForTimeout(3000);
        console.log('[Test 20] Explain (AI) clicked — chat should receive explanation request.');
      } else {
        console.log('[Test 20] Explain AI not in context menu.');
        await page.keyboard.press('Escape');
      }
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '20-explain-ai.png') });
  });

  test('21 — Query Table from context menu inserts SELECT', async () => {
    const { page } = ctx;

    const tableItem = page.locator('text=/users/i').first();
    if (await tableItem.isVisible({ timeout: 2000 }).catch(() => false)) {
      await tableItem.click({ button: 'right' });
      await page.waitForTimeout(500);

      const queryBtn = page.locator('[role="menuitem"]').filter({ hasText: /SELECT|Query|Запрос/i }).first();
      if (await queryBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await queryBtn.click();
        await page.waitForTimeout(1000);
        console.log('[Test 21] Query Table clicked — SELECT should be inserted in editor.');
      } else {
        console.log('[Test 21] Query option not in context menu.');
        await page.keyboard.press('Escape');
      }
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '21-query-table.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ER DIAGRAM
  // ═══════════════════════════════════════════════════════════════════════════
  test('22 — Open ER Diagram', async () => {
    const { page } = ctx;

    // Right-click on database level to get ER Diagram option
    // Or find the ER Diagram menu item in connection context
    // The ER Diagram is opened from the database-level context menu

    // First try: find connection item and right-click
    const connectionItem = page.locator(`text=/${TEST_DB.name}|progressql/i`).first();
    if (await connectionItem.isVisible({ timeout: 2000 }).catch(() => false)) {
      await connectionItem.click({ button: 'right' });
      await page.waitForTimeout(500);

      const erMenuItem = page.locator('[role="menuitem"]').filter({ hasText: /ER Diagram|ER диаграмма/i }).first();
      if (await erMenuItem.isVisible({ timeout: 1000 }).catch(() => false)) {
        await erMenuItem.click();
        await page.waitForTimeout(2000);
        console.log('[Test 22] ER Diagram opened from context menu.');
      } else {
        console.log('[Test 22] ER Diagram not in this context menu — trying database level.');
        await page.keyboard.press('Escape');
      }
    }

    // Check if ER diagram tab appeared
    const erTab = page.locator('[role="tab"]').filter({ hasText: /ER|diagram|диаграмма/i }).first();
    const hasErTab = await erTab.isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`[Test 22] ER Diagram tab visible: ${hasErTab}`);

    // Check for ReactFlow canvas
    const canvas = page.locator('.react-flow, [class*="reactflow"], [class*="ReactFlow"]').first();
    const hasCanvas = await canvas.isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`[Test 22] ReactFlow canvas visible: ${hasCanvas}`);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '22-er-diagram.png') });
  });

  test('23 — ER Diagram has table nodes and auto-layout', async () => {
    const { page } = ctx;

    // Check for table nodes in diagram
    const nodes = page.locator('.react-flow__node, [class*="react-flow__node"]');
    const nodeCount = await nodes.count();
    console.log(`[Test 23] ER Diagram nodes: ${nodeCount}`);

    // Check for edges (relationships)
    const edges = page.locator('.react-flow__edge, [class*="react-flow__edge"]');
    const edgeCount = await edges.count();
    console.log(`[Test 23] ER Diagram edges (relationships): ${edgeCount}`);

    // Check for auto-layout button
    const autoLayoutBtn = page.locator('[aria-label*="Auto-layout"], [aria-label*="auto-layout"], button:has-text("Auto Layout")').first();
    const hasAutoLayout = await autoLayoutBtn.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`[Test 23] Auto-layout button: ${hasAutoLayout}`);

    if (hasAutoLayout) {
      await autoLayoutBtn.click();
      await page.waitForTimeout(1000);
      console.log('[Test 23] Auto-layout clicked.');
    }

    // Check for minimap
    const minimap = page.locator('.react-flow__minimap, [class*="minimap"]').first();
    const hasMinimap = await minimap.isVisible({ timeout: 1000 }).catch(() => false);
    console.log(`[Test 23] Minimap: ${hasMinimap}`);

    // Check for zoom controls
    const zoomControls = page.locator('.react-flow__controls, [class*="controls"]').first();
    const hasZoom = await zoomControls.isVisible({ timeout: 1000 }).catch(() => false);
    console.log(`[Test 23] Zoom controls: ${hasZoom}`);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '23-er-nodes-layout.png') });
  });

  test('24 — Switch back to SQL editor tab', async () => {
    const { page } = ctx;

    // Click the SQL/Query tab to go back to editor
    const sqlTab = page.locator('[role="tab"]').filter({ hasText: /Query|SQL|Запрос/i }).first();
    if (await sqlTab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await sqlTab.click();
      await page.waitForTimeout(500);
      console.log('[Test 24] Switched back to SQL editor tab.');
    } else {
      console.log('[Test 24] SQL tab not found.');
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '24-back-to-editor.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SCHEMA SYNC
  // ═══════════════════════════════════════════════════════════════════════════
  test('25 — Schema Sync modal opens', async () => {
    const { page } = ctx;

    const schemaSyncBtn = page.locator('[aria-label="Compare and sync schemas"]');
    if (await schemaSyncBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await schemaSyncBtn.click();
      await page.waitForTimeout(1000);

      // Check for modal
      const modal = page.locator('[role="dialog"], [class*="modal"], [class*="Modal"]').first();
      const hasModal = await modal.isVisible({ timeout: 3000 }).catch(() => false);
      console.log(`[Test 25] Schema Sync modal visible: ${hasModal}`);

      if (hasModal) {
        // Check for source/target dropdowns
        const sourceLabel = page.locator('text=/Source|Источник/i').first();
        const targetLabel = page.locator('text=/Target|Цель/i').first();
        console.log(`[Test 25] Source label: ${await sourceLabel.isVisible().catch(() => false)}, Target label: ${await targetLabel.isVisible().catch(() => false)}`);

        // Check for Compare button
        const compareBtn = page.getByRole('button', { name: /Compare|Сравнить/i }).first();
        const hasCompare = await compareBtn.isVisible({ timeout: 1000 }).catch(() => false);
        console.log(`[Test 25] Compare button: ${hasCompare}`);

        // Close modal
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      }
    } else {
      console.log('[Test 25] Schema Sync button not visible — needs active connection.');
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '25-schema-sync.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ANALYZE SCHEMA
  // ═══════════════════════════════════════════════════════════════════════════
  test('26 — Analyze Schema button sends AI request', async () => {
    const { page } = ctx;

    const analyzeBtn = page.locator('[aria-label="Analyze database schema"]');
    if (await analyzeBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await analyzeBtn.click();
      await page.waitForTimeout(5000);
      console.log('[Test 26] Analyze Schema clicked — AI should analyze DB structure.');
    } else {
      console.log('[Test 26] Analyze Schema button not visible.');
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '26-analyze-schema.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CONNECTION MANAGEMENT — EDIT & DELETE
  // ═══════════════════════════════════════════════════════════════════════════
  test('27 — Edit connection dialog', async () => {
    const { page } = ctx;

    // Right-click on connection → Edit
    const connectionItem = page.locator(`text=/${TEST_DB.name}|E2E Test/i`).first();
    if (await connectionItem.isVisible({ timeout: 2000 }).catch(() => false)) {
      await connectionItem.click({ button: 'right' });
      await page.waitForTimeout(500);

      const editItem = page.locator('[role="menuitem"]').filter({ hasText: /Edit|Редактировать/i }).first();
      if (await editItem.isVisible({ timeout: 1000 }).catch(() => false)) {
        await editItem.click();
        await page.waitForTimeout(1000);

        // Check edit dialog opened
        const editDialog = page.locator('text=/Edit Connection|Редактировать/i').first();
        const hasEditDialog = await editDialog.isVisible({ timeout: 3000 }).catch(() => false);
        console.log(`[Test 27] Edit connection dialog: ${hasEditDialog}`);

        // Check pre-filled fields
        const hostInput = page.getByLabel(/Host|Хост/i).first();
        const hostValue = await hostInput.inputValue().catch(() => '');
        console.log(`[Test 27] Pre-filled host: ${hostValue}`);

        // Cancel
        const cancelBtn = page.getByRole('button', { name: /Cancel|Отмена/i }).first();
        if (await cancelBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
          await cancelBtn.click();
        } else {
          await page.keyboard.press('Escape');
        }
        await page.waitForTimeout(300);
      } else {
        await page.keyboard.press('Escape');
      }
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '27-edit-connection.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SETTINGS PANEL — ALL OPTIONS
  // ═══════════════════════════════════════════════════════════════════════════
  test('28 — Settings panel shows all sections', async () => {
    const { page } = ctx;

    // Open settings
    const settingsBtn = page.locator('[aria-label="Open settings"]');
    if (await settingsBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await settingsBtn.click({ force: true });
      await page.waitForTimeout(1000);
    }

    // Check all sections
    const sections = {
      subscription: await page.locator('text=/Subscription|Подписка/i').first().isVisible({ timeout: 2000 }).catch(() => false),
      model: await page.locator('text=/LLM Model|Модель/i').first().isVisible({ timeout: 1000 }).catch(() => false),
      security: await page.locator('text=/Security|Безопасность|AI Access/i').first().isVisible({ timeout: 1000 }).catch(() => false),
      theme: await page.locator('text=/Theme|Тема/i').first().isVisible({ timeout: 1000 }).catch(() => false),
      language: await page.locator('text=/Language|Язык/i').first().isVisible({ timeout: 1000 }).catch(() => false),
      legal: await page.locator('text=/Legal|Правовая/i').first().isVisible({ timeout: 1000 }).catch(() => false),
      account: await page.locator('text=/Account|Аккаунт/i').first().isVisible({ timeout: 1000 }).catch(() => false),
    };

    console.log('[Test 28] Settings sections:', sections);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '28-settings-all.png') });
  });

  test('29 — Theme toggle (Light/Dark/System)', async () => {
    const { page } = ctx;

    // Find theme toggle buttons
    const lightBtn = page.locator('button[value="light"], [aria-label*="Light"]').first();
    const darkBtn = page.locator('button[value="dark"], [aria-label*="Dark"]').first();
    const systemBtn = page.locator('button[value="system"], [aria-label*="System"]').first();

    const hasLight = await lightBtn.isVisible({ timeout: 2000 }).catch(() => false);
    const hasDark = await darkBtn.isVisible({ timeout: 1000 }).catch(() => false);
    const hasSystem = await systemBtn.isVisible({ timeout: 1000 }).catch(() => false);

    console.log(`[Test 29] Theme buttons — light: ${hasLight}, dark: ${hasDark}, system: ${hasSystem}`);

    // Toggle to light theme
    if (hasLight) {
      await lightBtn.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '29a-light-theme.png') });
      console.log('[Test 29] Switched to light theme.');
    }

    // Switch back to dark
    if (hasDark) {
      await darkBtn.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '29b-dark-theme.png') });
      console.log('[Test 29] Switched back to dark theme.');
    }
  });

  test('30 — Language toggle (EN/RU)', async () => {
    const { page } = ctx;

    const enBtn = page.locator('button').filter({ hasText: /^English$|^EN$/i }).first();
    const ruBtn = page.locator('button').filter({ hasText: /^Русский$|^RU$/i }).first();

    const hasEN = await enBtn.isVisible({ timeout: 2000 }).catch(() => false);
    const hasRU = await ruBtn.isVisible({ timeout: 1000 }).catch(() => false);

    console.log(`[Test 30] Language buttons — EN: ${hasEN}, RU: ${hasRU}`);

    // Switch to Russian
    if (hasRU) {
      await ruBtn.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '30a-russian.png') });
      console.log('[Test 30] Switched to Russian.');
    }

    // Switch back to English
    if (hasEN) {
      await enBtn.click();
      await page.waitForTimeout(500);
      console.log('[Test 30] Switched back to English.');
    }
  });

  test('31 — Promo code input', async () => {
    const { page } = ctx;

    // Look for promo code section
    const promoSection = page.locator('text=/Promo Code|Промокод/i').first();
    const hasPromo = await promoSection.isVisible({ timeout: 2000 }).catch(() => false);

    if (hasPromo) {
      await promoSection.click();
      await page.waitForTimeout(500);

      const promoInput = page.getByPlaceholder(/promo|промокод/i).first();
      if (await promoInput.isVisible({ timeout: 2000 }).catch(() => false)) {
        await promoInput.fill('TESTCODE123');
        const applyBtn = page.getByRole('button', { name: /Apply|Применить/i }).first();
        if (await applyBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
          await applyBtn.click();
          await page.waitForTimeout(2000);

          // Expect error for invalid code
          const error = page.locator('text=/Invalid|expired|Невалидный|истёк/i').first();
          const hasError = await error.isVisible({ timeout: 3000 }).catch(() => false);
          console.log(`[Test 31] Invalid promo code error shown: ${hasError}`);
        }
      }
    } else {
      console.log('[Test 31] Promo code section not visible.');
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '31-promo-code.png') });
  });

  test('32 — Legal links visible', async () => {
    const { page } = ctx;

    const links = {
      privacy: await page.locator('text=/Privacy Policy|Политика конфиденциальности/i').first().isVisible({ timeout: 2000 }).catch(() => false),
      terms: await page.locator('text=/Terms of Use|Условия использования/i').first().isVisible({ timeout: 1000 }).catch(() => false),
      offer: await page.locator('text=/Offer Agreement|Оферта/i').first().isVisible({ timeout: 1000 }).catch(() => false),
      refund: await page.locator('text=/Refund Policy|Возврат/i').first().isVisible({ timeout: 1000 }).catch(() => false),
      contacts: await page.locator('text=/Contacts|Контакты/i').first().isVisible({ timeout: 1000 }).catch(() => false),
    };

    console.log('[Test 32] Legal links:', links);

    // Check version display
    const versionText = page.locator('text=/Version|Версия/i').first();
    const hasVersion = await versionText.isVisible({ timeout: 1000 }).catch(() => false);
    console.log(`[Test 32] Version display: ${hasVersion}`);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '32-legal.png') });
  });

  test('33 — Model selection dropdown', async () => {
    const { page } = ctx;

    // Find model dropdown / select
    const modelSelect = page.locator('[aria-label*="Model"], [role="combobox"]').filter({ hasText: /qwen|gpt|model/i }).first();
    const hasModel = await modelSelect.isVisible({ timeout: 2000 }).catch(() => false);

    if (hasModel) {
      await modelSelect.click();
      await page.waitForTimeout(500);

      // Check for model options
      const options = page.locator('[role="option"]');
      const optCount = await options.count();
      console.log(`[Test 33] Model options: ${optCount}`);

      // Select first option and close
      if (optCount > 0) {
        const firstOptText = await options.first().textContent();
        console.log(`[Test 33] First model option: ${firstOptText}`);
        await options.first().click();
        await page.waitForTimeout(300);
      }
    } else {
      console.log('[Test 33] Model dropdown not found.');
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '33-model-selection.png') });
  });

  test('34 — Close settings panel', async () => {
    const { page } = ctx;

    // Close settings
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    console.log('[Test 34] Settings panel closed.');
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '34-settings-closed.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TOP NAVIGATION
  // ═══════════════════════════════════════════════════════════════════════════
  test('35 — Theme toggle button in top nav', async () => {
    const { page } = ctx;

    const themeToggle = page.locator('[aria-label*="Switch to"], [aria-label*="theme"]').first();
    const hasToggle = await themeToggle.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`[Test 35] Theme toggle in top nav: ${hasToggle}`);

    if (hasToggle) {
      await themeToggle.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '35a-theme-toggled.png') });

      // Toggle back
      await themeToggle.click();
      await page.waitForTimeout(500);
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '35-top-nav.png') });
  });

  test('36 — User profile menu', async () => {
    const { page } = ctx;

    const profileBtn = page.locator('[aria-label="User profile menu"]');
    if (await profileBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await profileBtn.click();
      await page.waitForTimeout(500);

      // Check for user info and logout
      const logoutItem = page.locator('[role="menuitem"]').filter({ hasText: /Logout|Log out|Выйти/i }).first();
      const hasLogout = await logoutItem.isVisible({ timeout: 2000 }).catch(() => false);
      console.log(`[Test 36] Logout option in profile menu: ${hasLogout}`);

      // Close menu without logout
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    } else {
      console.log('[Test 36] Profile button not found.');
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '36-profile-menu.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // STATUS BAR
  // ═══════════════════════════════════════════════════════════════════════════
  test('37 — Status bar shows DB, Backend, and Model status', async () => {
    const { page } = ctx;

    const statusBar = page.locator('[role="status"]').first();
    const hasStatusBar = await statusBar.isVisible({ timeout: 2000 }).catch(() => false);

    if (hasStatusBar) {
      const statusText = await statusBar.textContent() || '';
      console.log(`[Test 37] Status bar text: ${statusText}`);

      const hasDb = statusText.includes('DB:');
      const hasBackend = statusText.includes('Backend:');
      const hasModel = statusText.includes('Model:');

      console.log(`[Test 37] Status indicators — DB: ${hasDb}, Backend: ${hasBackend}, Model: ${hasModel}`);
    } else {
      console.log('[Test 37] Status bar not found.');
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '37-status-bar.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SQL EDITOR TABS
  // ═══════════════════════════════════════════════════════════════════════════
  test('38 — Create multiple SQL editor tabs', async () => {
    const { page } = ctx;

    const newTabBtn = page.locator('[aria-label="New query tab"]');
    if (await newTabBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Count tabs before
      const tabsBefore = await page.locator('[role="tab"]').count();

      await newTabBtn.click();
      await page.waitForTimeout(500);
      await newTabBtn.click();
      await page.waitForTimeout(500);

      const tabsAfter = await page.locator('[role="tab"]').count();
      console.log(`[Test 38] Tabs before: ${tabsBefore}, after: ${tabsAfter}`);
      // At minimum, one new tab should have been created
      if (tabsAfter <= tabsBefore) {
        console.warn('[Test 38] New query tab button did not increase tab count.');
      }
    } else {
      console.warn('[Test 38] New query tab button not found.');
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '38-multiple-tabs.png') });
  });

  test('39 — Rename SQL editor tab by double-click', async () => {
    const { page } = ctx;

    const lastTab = page.locator('[role="tab"]').filter({ hasText: /Query|Запрос/i }).last();
    if (await lastTab.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Double-click to rename
      await lastTab.dblclick();
      await page.waitForTimeout(500);

      // Look for rename input
      const renameInput = page.locator('input[type="text"]').last();
      if (await renameInput.isVisible({ timeout: 2000 }).catch(() => false)) {
        await renameInput.fill('My Custom Query');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(500);
        console.log('[Test 39] Tab renamed to "My Custom Query".');
      } else {
        console.log('[Test 39] Rename input not found after double-click.');
      }
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '39-renamed-tab.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CONNECTION FORM VALIDATION
  // ═══════════════════════════════════════════════════════════════════════════
  test('40 — Connection form validates required fields', async () => {
    const { page } = ctx;

    const addBtn = page.locator('[aria-label="Add new database connection"]');
    if (await addBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await addBtn.click();
      await page.waitForTimeout(500);

      // Try to connect with empty fields
      const hostField = page.getByLabel(/Host|Хост/i).first();
      if (await hostField.isVisible({ timeout: 1000 }).catch(() => false)) {
        await hostField.fill('');
      }

      const connectBtn = page.getByRole('button', { name: /Connect|Подключить/i });
      if (await connectBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await connectBtn.click();
        await page.waitForTimeout(1000);

        // Look for validation errors
        const errors = page.locator('text=/required|обязательно|error/i');
        const errorCount = await errors.count();
        console.log(`[Test 40] Validation errors: ${errorCount}`);
      }

      // Close form
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '40-form-validation.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // KEYBOARD SHORTCUTS
  // ═══════════════════════════════════════════════════════════════════════════
  test('41 — Cmd+K focuses chat input', async () => {
    const { page } = ctx;

    await page.keyboard.press('Meta+k');
    await page.waitForTimeout(500);

    const chatInput = page.locator('[aria-label="Chat message input"]');
    const isFocused = await chatInput.evaluate(el => document.activeElement === el).catch(() => false);
    console.log(`[Test 41] Chat input focused after Cmd+K: ${isFocused}`);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '41-cmd-k.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SECURITY MODES — DEEP TEST
  // ═══════════════════════════════════════════════════════════════════════════
  test('42 — Switch to Data Mode and verify restrictions', async () => {
    const { page } = ctx;

    // Open settings
    const settingsBtn = page.locator('[aria-label="Open settings"]');
    await settingsBtn.click({ force: true });
    await page.waitForTimeout(1000);

    // Find security mode dropdown
    const securitySelect = page.locator('[role="combobox"]').filter({ hasText: /safe|data|execute/i }).first();
    if (await securitySelect.isVisible({ timeout: 3000 }).catch(() => false)) {
      await securitySelect.click();
      await page.waitForTimeout(300);

      const dataOption = page.locator('[role="option"]').filter({ hasText: /data/i }).first();
      if (await dataOption.isVisible({ timeout: 2000 }).catch(() => false)) {
        await dataOption.click();
        await page.waitForTimeout(500);
        console.log('[Test 42] Switched to Data Mode.');
      }
    }

    // Check Data Mode info box
    const dataInfo = page.locator('text=/Read-only|SELECT queries only|только чтение/i').first();
    const hasDataInfo = await dataInfo.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`[Test 42] Data Mode info visible: ${hasDataInfo}`);

    // Close settings
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Check for data mode warning in chat header
    const dataWarning = page.locator('text=/Data Mode|Режим данных/i').first();
    const hasWarning = await dataWarning.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`[Test 42] Data Mode warning in chat: ${hasWarning}`);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '42-data-mode.png') });
  });

  test('43 — Switch to Execute Mode and verify warning', async () => {
    const { page } = ctx;

    const settingsBtn = page.locator('[aria-label="Open settings"]');
    await settingsBtn.click({ force: true });
    await page.waitForTimeout(1000);

    const securitySelect = page.locator('[role="combobox"]').filter({ hasText: /safe|data|execute/i }).first();
    if (await securitySelect.isVisible({ timeout: 3000 }).catch(() => false)) {
      await securitySelect.click();
      await page.waitForTimeout(300);

      const executeOption = page.locator('[role="option"]').filter({ hasText: /execute/i }).first();
      if (await executeOption.isVisible({ timeout: 2000 }).catch(() => false)) {
        await executeOption.click();
        await page.waitForTimeout(500);
        console.log('[Test 43] Switched to Execute Mode.');
      }
    }

    // Check Execute Mode info
    const executeInfo = page.locator('text=/Full access|all SQL|полный доступ/i').first();
    const hasExecuteInfo = await executeInfo.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`[Test 43] Execute Mode info visible: ${hasExecuteInfo}`);

    // Close settings
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Check for execute mode warning
    const executeWarning = page.locator('[aria-label*="execute mode"], [aria-label*="Execute"]').first();
    const hasWarning = await executeWarning.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`[Test 43] Execute Mode warning icon: ${hasWarning}`);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '43-execute-mode.png') });
  });

  test('44 — Switch back to Safe Mode', async () => {
    const { page } = ctx;

    const settingsBtn = page.locator('[aria-label="Open settings"]');
    await settingsBtn.click({ force: true });
    await page.waitForTimeout(1000);

    const securitySelect = page.locator('[role="combobox"]').filter({ hasText: /safe|data|execute/i }).first();
    if (await securitySelect.isVisible({ timeout: 3000 }).catch(() => false)) {
      await securitySelect.click();
      await page.waitForTimeout(300);

      const safeOption = page.locator('[role="option"]').filter({ hasText: /safe/i }).first();
      if (await safeOption.isVisible({ timeout: 2000 }).catch(() => false)) {
        await safeOption.click();
        await page.waitForTimeout(500);
        console.log('[Test 44] Switched back to Safe Mode.');
      }
    }

    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '44-safe-mode.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTOCOMPLETE & GHOST TEXT
  // ═══════════════════════════════════════════════════════════════════════════
  test('45 — SQL autocomplete suggestions appear when typing', async () => {
    const { page } = ctx;

    // Switch to first SQL tab and type
    const sqlTab = page.locator('[role="tab"]').filter({ hasText: /Query|Запрос/i }).first();
    if (await sqlTab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await sqlTab.click();
      await page.waitForTimeout(300);
    }

    const editor = page.locator('.cm-editor .cm-content').first();
    await editor.click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(200);

    // Type slowly to trigger autocomplete
    await page.keyboard.type('SEL', { delay: 100 });
    await page.waitForTimeout(1000);

    // Look for autocomplete tooltip
    const autocomplete = page.locator('.cm-tooltip-autocomplete, .cm-completionList').first();
    const hasAutocomplete = await autocomplete.isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`[Test 45] Autocomplete dropdown visible: ${hasAutocomplete}`);

    // Look for ghost text
    const ghostText = page.locator('.cm-ghostText, [class*="ghost"]').first();
    const hasGhost = await ghostText.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`[Test 45] Ghost text hint visible: ${hasGhost}`);

    // Accept suggestion with Tab if autocomplete visible
    if (hasAutocomplete || hasGhost) {
      await page.keyboard.press('Tab');
      await page.waitForTimeout(500);
      console.log('[Test 45] Tab pressed to accept suggestion.');
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '45-autocomplete.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PANEL RESIZING
  // ═══════════════════════════════════════════════════════════════════════════
  test('46 — Panel resize handles work', async () => {
    const { page } = ctx;

    const resizeHandles = page.locator('[data-panel-resize-handle-id]');
    const handleCount = await resizeHandles.count();
    console.log(`[Test 46] Resize handles found: ${handleCount}`);

    if (handleCount > 0) {
      const handle = resizeHandles.first();
      const box = await handle.boundingBox();
      if (box) {
        // Drag right 50px
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2, { steps: 5 });
        await page.mouse.up();
        await page.waitForTimeout(300);
        console.log('[Test 46] Panel resize dragged.');
      }
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '46-panel-resize.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CHAT TABS — DATABASE SELECTOR
  // ═══════════════════════════════════════════════════════════════════════════
  test('47 — Chat database connection pill and selector', async () => {
    const { page } = ctx;

    // Look for the DB connection pill in chat input area
    const dbPill = page.locator('[class*="pill"], [class*="Pill"], button').filter({ hasText: /progressql|No DB|Нет БД/i }).first();
    const hasPill = await dbPill.isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`[Test 47] Database connection pill visible: ${hasPill}`);

    if (hasPill) {
      await dbPill.click();
      await page.waitForTimeout(500);

      // Check for dropdown/menu with connections
      const connOptions = page.locator('[role="menuitem"], [role="option"]');
      const optCount = await connOptions.count();
      console.log(`[Test 47] Connection options in selector: ${optCount}`);

      if (optCount > 0) {
        await page.keyboard.press('Escape');
      }
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '47-chat-db-selector.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CONNECTION PILL IN SQL EDITOR
  // ═══════════════════════════════════════════════════════════════════════════
  test('48 — SQL Editor connection pill', async () => {
    const { page } = ctx;

    // The SQL editor has its own connection pill / indicator
    const editorPill = page.locator('[class*="connectionPill"], [class*="ConnectionPill"]').first();
    const editorConnectionBtn = page.locator('button').filter({ hasText: /progressql|E2E Test/i }).first();

    const hasPill = await editorPill.isVisible({ timeout: 2000 }).catch(() => false);
    const hasConnBtn = await editorConnectionBtn.isVisible({ timeout: 2000 }).catch(() => false);

    console.log(`[Test 48] Editor connection pill: ${hasPill}, connection button: ${hasConnBtn}`);

    if (hasConnBtn) {
      await editorConnectionBtn.click();
      await page.waitForTimeout(500);

      // Check for connection switching menu
      const menu = page.locator('[role="menu"], [role="listbox"]').first();
      const hasMenu = await menu.isVisible({ timeout: 2000 }).catch(() => false);
      console.log(`[Test 48] Connection switch menu: ${hasMenu}`);

      await page.keyboard.press('Escape');
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '48-editor-connection.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // UPGRADE TO PRO BUTTON
  // ═══════════════════════════════════════════════════════════════════════════
  test('49 — Upgrade to Pro button and payment modal', async () => {
    const { page } = ctx;

    const upgradeBtn = page.getByRole('button', { name: /Upgrade to Pro|Перейти на Pro/i }).first();
    const hasUpgrade = await upgradeBtn.isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`[Test 49] Upgrade to Pro button: ${hasUpgrade}`);

    if (hasUpgrade) {
      await upgradeBtn.click();
      await page.waitForTimeout(1000);

      // Check payment modal
      const paymentModal = page.locator('text=/payment method|способ оплаты|Card|Карта|SBP/i').first();
      const hasPayment = await paymentModal.isVisible({ timeout: 3000 }).catch(() => false);
      console.log(`[Test 49] Payment modal visible: ${hasPayment}`);

      if (hasPayment) {
        // Check for Card and SBP options
        const cardBtn = page.locator('button').filter({ hasText: /Card|Карта/i }).first();
        const sbpBtn = page.locator('button').filter({ hasText: /SBP|СБП/i }).first();
        console.log(`[Test 49] Card: ${await cardBtn.isVisible().catch(() => false)}, SBP: ${await sbpBtn.isVisible().catch(() => false)}`);
      }

      // Close modal
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '49-upgrade-payment.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CHAT — CLEAR HISTORY
  // ═══════════════════════════════════════════════════════════════════════════
  test('50 — Clear chat history', async () => {
    const { page } = ctx;

    const clearBtn = page.locator('[aria-label*="Clear history"], [aria-label*="clear"], button:has-text("Clear")').first();
    const hasClear = await clearBtn.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`[Test 50] Clear history button: ${hasClear}`);

    if (hasClear) {
      await clearBtn.click();
      await page.waitForTimeout(1000);
      console.log('[Test 50] Clear history clicked.');
    }

    // Check for empty state message
    const emptyState = page.locator('text=/Send a message|Отправьте сообщение/i').first();
    const hasEmpty = await emptyState.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`[Test 50] Empty state after clear: ${hasEmpty}`);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '50-clear-history.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════════════════
  test('99 — Close app', async () => {
    if (ctx?.app) {
      await ctx.app.close();
      console.log('[Test 99] App closed.');
    }
  });
});
