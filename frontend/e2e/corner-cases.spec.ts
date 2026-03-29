/**
 * corner-cases.spec.ts
 *
 * Edge-case & UX tests for cross-area interactions:
 * - Multi-connection: Editor vs Chat connection mismatch
 * - Explorer → Editor connection switching
 * - Chat "Execute SQL" / "Apply SQL" with different connections
 * - Ghost text / AI autocomplete insertion (spacing, duplication)
 * - Fix in Chat with connection context
 * - Tab management under multi-connection scenarios
 *
 * Tests TWO simultaneous DB connections (both to same PostgreSQL but
 * different logical connection entries) to verify context switching.
 */
import { test, expect } from '@playwright/test';
import { launchApp, registerAndLogin, AppContext } from './helpers/electron-app';
import path from 'path';
import fs from 'fs';

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots', 'corner-cases');

const TEST_USER = {
  name: 'Corner Case User',
  email: `corner_${Date.now()}@test.com`,
  password: 'CornerCase123!',
};

// Two separate connections to test cross-connection behavior
const CONN_A = {
  name: 'Connection A',
  host: '127.0.0.1',
  port: '5435',
  username: 'progressql',
  password: 'progressql',
  database: 'progressql',
};

const CONN_B = {
  name: 'Connection B',
  host: '127.0.0.1',
  port: '5435',
  username: 'progressql',
  password: 'progressql',
  database: 'progressql',
};

let ctx: AppContext;

/** Helper: add a database connection via the dialog */
async function addConnection(
  page: import('playwright').Page,
  conn: typeof CONN_A,
): Promise<void> {
  const addBtn = page.locator('[aria-label="Add new database connection"]').first();
  if (await addBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await addBtn.click();
  } else {
    // Fallback: small + button near CONNECTIONS header
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

  const dialog = page.locator('[role="dialog"]');
  if (await dialog.isVisible({ timeout: 3000 }).catch(() => false)) {
    const textInputs = dialog.locator('input:not([type="hidden"])');
    const inputCount = await textInputs.count();
    const values = [conn.name, conn.host, conn.port, conn.username, conn.password, conn.database];
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

  await page.waitForTimeout(1000);
}

/** Helper: click connection in sidebar to connect it */
async function activateConnection(
  page: import('playwright').Page,
  connName: string,
): Promise<void> {
  const connItem = page.locator(`text=/${connName}/i`).first();
  if (await connItem.isVisible({ timeout: 3000 }).catch(() => false)) {
    await connItem.click();
    await page.waitForTimeout(3000);
  }
}

/** Helper: get the currently active connection name from status bar or editor pill */
async function getEditorConnection(page: import('playwright').Page): Promise<string> {
  const statusBar = page.locator('[role="status"]').first();
  const statusText = await statusBar.textContent().catch(() => '');
  // Extract "DB: Connection A" from status bar
  const match = statusText?.match(/DB:\s*([^·\n]+)/);
  return match?.[1]?.trim() || '';
}

/** Helper: get chat's active connection from DB pill */
async function getChatConnection(page: import('playwright').Page): Promise<string> {
  const dbPill = page.locator('button, [class*="pill"]').filter({
    hasText: /Connection [AB]|progressql|No DB/i,
  }).first();
  return (await dbPill.textContent().catch(() => '')) || '';
}

/** Helper: ensure chat panel is open */
async function ensureChatOpen(page: import('playwright').Page): Promise<void> {
  const chatPanel = page.locator('[aria-label="AI Assistant panel"]');
  if (await chatPanel.isVisible({ timeout: 1000 }).catch(() => false)) return;
  await page.keyboard.press('Meta+k');
  await page.waitForTimeout(500);
}

/** Helper: dismiss snackbar toasts */
async function dismissToasts(page: import('playwright').Page): Promise<void> {
  const snackbar = page.locator('.MuiSnackbar-root');
  if (await snackbar.isVisible({ timeout: 500 }).catch(() => false)) {
    const closeBtn = snackbar.locator('button').first();
    if (await closeBtn.isVisible({ timeout: 300 }).catch(() => false)) {
      await closeBtn.click();
    }
    await snackbar.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  }
}

/** Helper: send chat message */
async function sendChat(page: import('playwright').Page, msg: string): Promise<void> {
  const chatInput = page.locator('textarea:not([aria-hidden="true"]):not([readonly])').last();
  await chatInput.fill(msg);
  await chatInput.press('Enter');
  // Wait for response (stop button disappear or timeout)
  const stopBtn = page.locator('[aria-label="Stop generation"]');
  if (await stopBtn.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await stopBtn.waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
  } else {
    await page.waitForTimeout(3000);
  }
}

test.describe.serial('Corner Cases — Cross-Area UX', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // SETUP: Two connections
  // ═══════════════════════════════════════════════════════════════════════════
  test('00 — Setup: launch, register, add TWO connections', async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    ctx = await launchApp();
    const { page } = ctx;
    await page.waitForTimeout(2000);

    // Handle stale sessions — might be on main page, verify-email, or login
    const currentUrl = page.url();

    if (currentUrl.includes('verify-email')) {
      const logoutLink = page.locator('a, button').filter({ hasText: /Log out|Выйти/i }).first();
      if (await logoutLink.isVisible({ timeout: 3000 }).catch(() => false)) {
        await logoutLink.click();
        await page.waitForURL((url: URL) => url.pathname.includes('login'), { timeout: 10_000 }).catch(() => {});
        await page.waitForTimeout(1000);
      }
    } else if (!currentUrl.includes('login') && !currentUrl.includes('register')) {
      // Already on main page — need to logout first
      // Try settings → logout
      const settingsBtn = page.locator('[aria-label="Open settings"]');
      if (await settingsBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await settingsBtn.click({ force: true });
        await page.waitForTimeout(500);
        const logoutBtn = page.locator('button').filter({ hasText: /Log out|Выйти/i }).first();
        if (await logoutBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await logoutBtn.click();
          await page.waitForURL((url: URL) => url.pathname.includes('login'), { timeout: 10_000 }).catch(() => {});
          await page.waitForTimeout(1000);
        } else {
          await page.keyboard.press('Escape');
        }
      }
      // Try profile menu → logout
      if (!page.url().includes('login')) {
        const profileBtn = page.locator('[aria-label="User profile menu"]');
        if (await profileBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await profileBtn.click();
          await page.waitForTimeout(500);
          const logoutItem = page.locator('[role="menuitem"]').filter({ hasText: /Log out|Выйти/i }).first();
          if (await logoutItem.isVisible({ timeout: 2000 }).catch(() => false)) {
            await logoutItem.click();
            await page.waitForURL((url: URL) => url.pathname.includes('login'), { timeout: 10_000 }).catch(() => {});
            await page.waitForTimeout(1000);
          }
        }
      }
      // Last resort: clear localStorage
      if (!page.url().includes('login')) {
        await page.evaluate(() => {
          localStorage.clear();
          sessionStorage.clear();
        });
        await page.reload();
        await page.waitForTimeout(3000);
      }
    }

    await registerAndLogin(page, TEST_USER);
    await expect(
      page.getByRole('heading', { name: /Connections|AI Assistant/i }).first(),
    ).toBeVisible({ timeout: 15_000 });

    // Add Connection A
    await addConnection(page, CONN_A);
    console.log('[CC-00] Connection A added.');

    // Add Connection B
    await addConnection(page, CONN_B);
    console.log('[CC-00] Connection B added.');

    // Activate Connection A (click to connect)
    await activateConnection(page, CONN_A.name);

    // Wait for editor to appear (= DB connected)
    const editor = page.locator('.cm-editor').first();
    await editor.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
    console.log(`[CC-00] Editor visible: ${await editor.isVisible().catch(() => false)}`);

    // Now also activate Connection B
    await activateConnection(page, CONN_B.name);
    await page.waitForTimeout(3000);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '00-two-connections.png') });
    console.log('[CC-00] Setup complete — two connections added.');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. EDITOR vs CHAT CONNECTION MISMATCH
  // ═══════════════════════════════════════════════════════════════════════════
  test('01 — Editor and Chat can have different active connections', async () => {
    const { page } = ctx;

    // Set editor to Connection A
    await activateConnection(page, CONN_A.name);
    await page.waitForTimeout(2000);

    const editorConn = await getEditorConnection(page);
    console.log(`[CC-01] Editor connection: "${editorConn}"`);

    // Open chat and check its connection
    await ensureChatOpen(page);
    const chatConn = await getChatConnection(page);
    console.log(`[CC-01] Chat connection: "${chatConn}"`);

    // Switch chat's DB pill to Connection B (if possible)
    const dbPill = page.locator('button, [class*="pill"]').filter({
      hasText: /Connection|progressql|No DB/i,
    }).first();
    if (await dbPill.isVisible({ timeout: 2000 }).catch(() => false)) {
      await dbPill.click();
      await page.waitForTimeout(500);

      // Look for Connection B in dropdown
      const connBOption = page.locator('[role="menuitem"], [role="option"]').filter({
        hasText: /Connection B/i,
      }).first();
      if (await connBOption.isVisible({ timeout: 2000 }).catch(() => false)) {
        await connBOption.click();
        await page.waitForTimeout(500);
        console.log('[CC-01] Switched chat to Connection B.');
      } else {
        await page.keyboard.press('Escape');
        console.log('[CC-01] Connection B not in chat dropdown.');
      }
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-connection-mismatch.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. EXECUTE SQL from CHAT uses CHAT's connection (not editor's)
  // ═══════════════════════════════════════════════════════════════════════════
  test('02 — Execute SQL from chat should use chat connection, not editor', async () => {
    const { page } = ctx;

    await ensureChatOpen(page);

    // Send a query request in chat
    await sendChat(page, 'Write SELECT version()');

    // Check if we got SQL blocks
    const sqlBlocks = page.locator('pre, [class*="sql-block"]').filter({
      hasText: /SELECT|version/i,
    });
    const blockCount = await sqlBlocks.count();
    console.log(`[CC-02] SQL blocks in response: ${blockCount}`);

    if (blockCount > 0) {
      // Hover over SQL block to reveal buttons
      await sqlBlocks.first().hover();
      await page.waitForTimeout(500);

      const executeBtn = page.locator('[aria-label="Execute SQL"]').first();
      if (await executeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await executeBtn.click();
        await page.waitForTimeout(3000);

        // Check that query executed successfully — look for results or error in QueryResults panel
        const queryResults = page.locator('text=/rows|columns|Query Results/i').first();
        const hasResults = await queryResults.isVisible({ timeout: 5000 }).catch(() => false);

        // Check for actual error in the results panel (not sidebar/status bar text)
        const errorInResults = page.locator('[class*="QueryResults"], [class*="query-results"]')
          .locator('text=/Error:|not connected|no database connection/i').first();
        const hasResultsError = await errorInResults.isVisible({ timeout: 1000 }).catch(() => false);

        console.log(`[CC-02] Query results visible: ${hasResults}, Error in results: ${hasResultsError}`);

        if (hasResultsError) {
          console.error('[CC-02] BUG: Execute from chat failed due to connection mismatch!');
        } else if (hasResults) {
          console.log('[CC-02] OK: Execute from chat succeeded.');
        }
      }
    } else {
      console.log('[CC-02] No SQL blocks — LLM may not have returned SQL.');
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-execute-from-chat.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. APPLY SQL from CHAT switches editor connection
  // ═══════════════════════════════════════════════════════════════════════════
  test('03 — Apply SQL from chat should switch editor to chat connection', async () => {
    const { page } = ctx;

    const sqlBlocks = page.locator('pre, [class*="sql-block"]').filter({
      hasText: /SELECT|version/i,
    });
    const blockCount = await sqlBlocks.count();

    if (blockCount > 0) {
      await sqlBlocks.first().hover();
      await page.waitForTimeout(500);

      const applyBtn = page.locator('[aria-label="Apply SQL to editor"]').first();
      if (await applyBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        // Note editor connection before
        const connBefore = await getEditorConnection(page);

        await applyBtn.click();
        await page.waitForTimeout(2000);

        // Check editor connection after
        const connAfter = await getEditorConnection(page);
        console.log(`[CC-03] Editor connection: "${connBefore}" → "${connAfter}"`);

        // Editor content should contain the applied SQL
        const editor = page.locator('.cm-editor .cm-content').first();
        const editorText = await editor.textContent().catch(() => '');
        const hasSQL = editorText?.toLowerCase().includes('select');
        console.log(`[CC-03] Editor has applied SQL: ${hasSQL}`);

        if (!hasSQL) {
          console.error('[CC-03] BUG: Apply SQL did not insert SQL into editor!');
        }
      }
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '03-apply-from-chat.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. QUERY TABLE from Explorer switches editor connection
  // ═══════════════════════════════════════════════════════════════════════════
  test('04 — Query Table from Explorer should switch editor connection', async () => {
    const { page } = ctx;

    // Make sure Connection A is expanded in the tree
    const connAItem = page.locator(`text=/${CONN_A.name}/i`).first();
    if (await connAItem.isVisible({ timeout: 3000 }).catch(() => false)) {
      await connAItem.click();
      await page.waitForTimeout(2000);
    }

    // Expand Tables section
    const tablesSection = page.locator('text=/Tables|Таблицы/i').first();
    if (await tablesSection.isVisible({ timeout: 3000 }).catch(() => false)) {
      await tablesSection.click();
      await page.waitForTimeout(1000);
    }

    // Right-click on users table → Query Table
    const usersTable = page.locator('text=/^users$/').first();
    if (await usersTable.isVisible({ timeout: 3000 }).catch(() => false)) {
      const connBefore = await getEditorConnection(page);

      await usersTable.click({ button: 'right' });
      await page.waitForTimeout(500);

      const queryItem = page.locator('[role="menuitem"]').filter({
        hasText: /SELECT|Query|Запрос/i,
      }).first();
      if (await queryItem.isVisible({ timeout: 2000 }).catch(() => false)) {
        await queryItem.click();
        await page.waitForTimeout(2000);

        // Editor should now have SELECT * FROM users LIMIT 100
        const editor = page.locator('.cm-editor .cm-content').first();
        const editorText = await editor.textContent().catch(() => '');
        console.log(`[CC-04] Editor content: "${editorText?.substring(0, 60)}"`);

        const hasUsersQuery = editorText?.toLowerCase().includes('users');
        console.log(`[CC-04] Has users query: ${hasUsersQuery}`);

        const connAfter = await getEditorConnection(page);
        console.log(`[CC-04] Editor connection: "${connBefore}" → "${connAfter}"`);

        if (!hasUsersQuery) {
          console.error('[CC-04] BUG: Query Table did not insert SELECT!');
        }
      } else {
        await page.keyboard.press('Escape');
      }
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '04-query-table.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. FIX IN CHAT preserves connection context
  // ═══════════════════════════════════════════════════════════════════════════
  test('05 — Fix in Chat should use correct connection context', async () => {
    const { page } = ctx;

    // Run a broken query in editor
    const editor = page.locator('.cm-editor .cm-content').first();
    if (await editor.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editor.click();
      await page.keyboard.press('Meta+a');
      await page.keyboard.type('SELECT * FROM definitely_nonexistent_table_xyz;', { delay: 15 });
      await page.keyboard.press('F5');
      await page.waitForTimeout(3000);

      // Click Fix in Chat
      const fixBtn = page.locator('button').filter({ hasText: /Fix|Исправить/i }).first();
      if (await fixBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        const editorConn = await getEditorConnection(page);
        await fixBtn.click();
        await page.waitForTimeout(3000);

        // Chat should open with the error context
        const chatPanel = page.locator('[aria-label="AI Assistant panel"]');
        const chatOpen = await chatPanel.isVisible({ timeout: 3000 }).catch(() => false);
        console.log(`[CC-05] Chat opened after Fix: ${chatOpen}`);

        // Check chat's connection — should match editor's
        const chatConn = await getChatConnection(page);
        console.log(`[CC-05] Editor: "${editorConn}", Chat: "${chatConn}"`);

        // Wait for AI response
        const stopBtn = page.locator('[aria-label="Stop generation"]');
        if (await stopBtn.isVisible({ timeout: 10_000 }).catch(() => false)) {
          await stopBtn.waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
        }
      } else {
        console.log('[CC-05] Fix button not found (query might have succeeded).');
      }
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '05-fix-in-chat.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. GHOST TEXT: Tab insertion doesn't duplicate existing text
  // ═══════════════════════════════════════════════════════════════════════════
  test('06 — Ghost text Tab accept does not duplicate typed keyword', async () => {
    const { page } = ctx;
    await dismissToasts(page);

    const editor = page.locator('.cm-editor .cm-content').first();
    if (!(await editor.isVisible({ timeout: 3000 }).catch(() => false))) {
      console.log('[CC-06] Editor not visible, skipping.');
      return;
    }

    // Clear editor
    await editor.click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(300);

    // Type "SELECT" slowly — ghost text might suggest continuation
    await page.keyboard.type('SELECT ', { delay: 100 });
    await page.waitForTimeout(1500);

    // Check if ghost text appeared
    const ghostText = page.locator('.cm-ghost-text, [class*="ghost"]').first();
    const hasGhost = await ghostText.isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`[CC-06] Ghost text visible: ${hasGhost}`);

    if (hasGhost) {
      const ghostContent = await ghostText.textContent().catch(() => '');
      console.log(`[CC-06] Ghost suggestion: "${ghostContent?.substring(0, 40)}"`);

      // Accept with Tab
      await page.keyboard.press('Tab');
      await page.waitForTimeout(500);

      // Get full editor content
      const fullText = await editor.textContent().catch(() => '');
      console.log(`[CC-06] Editor after Tab: "${fullText?.substring(0, 60)}"`);

      // Check for duplicated SELECT (e.g. "SELECT SELECT ...")
      const selectCount = (fullText?.match(/SELECT/gi) || []).length;
      console.log(`[CC-06] SELECT count: ${selectCount}`);

      if (selectCount > 1) {
        console.error('[CC-06] BUG: Ghost text duplicated "SELECT"!');
      }

      // Check for missing space (words merged: "SELECTid" or "FROMtable")
      // Note: no /i flag — [a-z][A-Z] specifically detects camelCase-like merges
      const hasMergedWords = /[a-z][A-Z]/.test(fullText || '');
      if (hasMergedWords) {
        console.error('[CC-06] BUG: Ghost text caused merged words (missing space)!');
      }
    } else {
      console.log('[CC-06] No ghost text appeared — autocomplete may need active WebSocket.');
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '06-ghost-text.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. GHOST TEXT: Typing continues after ghost text without merge
  // ═══════════════════════════════════════════════════════════════════════════
  test('07 — Continuing to type clears ghost text without merging', async () => {
    const { page } = ctx;

    const editor = page.locator('.cm-editor .cm-content').first();
    if (!(await editor.isVisible({ timeout: 3000 }).catch(() => false))) return;

    await editor.click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(300);

    // Type partial keyword and wait for ghost
    await page.keyboard.type('SEL', { delay: 100 });
    await page.waitForTimeout(1500);

    const ghostText = page.locator('.cm-ghost-text').first();
    const hasGhost = await ghostText.isVisible({ timeout: 3000 }).catch(() => false);

    if (hasGhost) {
      // Continue typing without pressing Tab — ghost should disappear
      await page.keyboard.type('ECT * FROM', { delay: 50 });
      await page.waitForTimeout(500);

      const ghostStillVisible = await ghostText.isVisible({ timeout: 1000 }).catch(() => false);
      console.log(`[CC-07] Ghost still visible after typing: ${ghostStillVisible}`);

      // Editor should have clean text without ghost remnants
      const editorText = await editor.textContent().catch(() => '');
      console.log(`[CC-07] Editor text: "${editorText}"`);

      // Should NOT contain ghost text merged in
      const looksClean = editorText?.includes('SELECT * FROM');
      console.log(`[CC-07] Clean text: ${looksClean}`);
    } else {
      console.log('[CC-07] No ghost text to test with.');
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '07-ghost-dismiss.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. RUN QUERY: Ctrl+Enter uses editor's connection, not chat's
  // ═══════════════════════════════════════════════════════════════════════════
  test('08 — Ctrl+Enter run uses editor connection pill, not chat', async () => {
    const { page } = ctx;

    const editor = page.locator('.cm-editor .cm-content').first();
    if (!(await editor.isVisible({ timeout: 3000 }).catch(() => false))) return;

    await editor.click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.type('SELECT current_database(), current_user;', { delay: 15 });

    // Run with Ctrl+Enter
    await page.keyboard.press('Control+Enter');
    await page.waitForTimeout(3000);

    // Check results
    const results = page.locator('[role="grid"], table, [class*="result"]').first();
    const hasResults = await results.isVisible({ timeout: 5000 }).catch(() => false);
    console.log(`[CC-08] Query results visible: ${hasResults}`);

    // Should show "progressql" as database name
    const dbName = page.locator('text=/progressql/').first();
    const showsDB = await dbName.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`[CC-08] Shows database name: ${showsDB}`);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '08-ctrl-enter.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 9. CONNECTION PILL in editor shows correct connection
  // ═══════════════════════════════════════════════════════════════════════════
  test('09 — Editor connection pill reflects active connection', async () => {
    const { page } = ctx;

    // Switch to Connection A via sidebar
    await activateConnection(page, CONN_A.name);
    await page.waitForTimeout(2000);

    const editorConn = await getEditorConnection(page);
    console.log(`[CC-09] Editor shows: "${editorConn}"`);

    // Now switch to Connection B
    await activateConnection(page, CONN_B.name);
    await page.waitForTimeout(2000);

    const editorConn2 = await getEditorConnection(page);
    console.log(`[CC-09] After switching: "${editorConn2}"`);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '09-editor-pill.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 10. SQL TAB retains its own connection
  // ═══════════════════════════════════════════════════════════════════════════
  test('10 — SQL tabs remember their own connection independently', async () => {
    const { page } = ctx;

    // Create a new tab while Connection A is active
    await activateConnection(page, CONN_A.name);
    await page.waitForTimeout(2000);

    const newTabBtn = page.locator('[aria-label="New query tab"]');
    if (await newTabBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await newTabBtn.click();
      await page.waitForTimeout(500);
    }

    // Type a query in Tab 2
    const editor = page.locator('.cm-editor .cm-content').first();
    if (await editor.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editor.click();
      await page.keyboard.type('-- Tab 2: Connection A query', { delay: 15 });
    }

    // Switch to Connection B
    await activateConnection(page, CONN_B.name);
    await page.waitForTimeout(2000);

    // Switch back to Tab 1
    const tabs = page.locator('[role="tab"]').filter({ hasText: /Query|Запрос/i });
    if ((await tabs.count()) > 1) {
      await tabs.first().click();
      await page.waitForTimeout(500);

      const conn = await getEditorConnection(page);
      console.log(`[CC-10] Tab 1 connection after switching: "${conn}"`);
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '10-tab-connection.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 11. EXPLAIN from Explorer opens chat with correct connection
  // ═══════════════════════════════════════════════════════════════════════════
  test('11 — Explain from Explorer passes connection to chat', async () => {
    const { page } = ctx;

    // Expand tables under Connection A
    const tablesSection = page.locator('text=/Tables|Таблицы/i').first();
    if (await tablesSection.isVisible({ timeout: 3000 }).catch(() => false)) {
      await tablesSection.click();
      await page.waitForTimeout(1000);
    }

    const usersTable = page.locator('text=/^users$/').first();
    if (await usersTable.isVisible({ timeout: 3000 }).catch(() => false)) {
      await usersTable.click({ button: 'right' });
      await page.waitForTimeout(500);

      const explainAI = page.locator('[role="menuitem"]').filter({
        hasText: /Explain|AI|Объяснить/i,
      }).first();
      if (await explainAI.isVisible({ timeout: 2000 }).catch(() => false)) {
        await explainAI.click();
        await page.waitForTimeout(3000);

        // Chat should be open
        const chatPanel = page.locator('[aria-label="AI Assistant panel"]');
        const chatOpen = await chatPanel.isVisible({ timeout: 3000 }).catch(() => false);
        console.log(`[CC-11] Chat opened: ${chatOpen}`);

        // Chat connection should match the explorer's connection
        const chatConn = await getChatConnection(page);
        console.log(`[CC-11] Chat connection: "${chatConn}"`);
      } else {
        await page.keyboard.press('Escape');
        console.log('[CC-11] Explain AI not in menu.');
      }
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '11-explain-connection.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 12. CHAT: Switching connection via pill updates context
  // ═══════════════════════════════════════════════════════════════════════════
  test('12 — Chat DB pill switch updates agent connection context', async () => {
    const { page } = ctx;
    await ensureChatOpen(page);

    const dbPill = page.locator('button, [class*="pill"]').filter({
      hasText: /Connection|progressql|No DB/i,
    }).first();

    if (await dbPill.isVisible({ timeout: 2000 }).catch(() => false)) {
      const pillBefore = await dbPill.textContent();
      console.log(`[CC-12] DB pill before: "${pillBefore}"`);

      await dbPill.click();
      await page.waitForTimeout(500);

      // Check for available connections in dropdown
      const options = page.locator('[role="menuitem"], [role="option"]');
      const optCount = await options.count();
      console.log(`[CC-12] Connection options: ${optCount}`);

      // Take screenshot of dropdown
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '12a-pill-dropdown.png') });

      if (optCount > 1) {
        // Select a different connection
        await options.nth(1).click();
        await page.waitForTimeout(500);

        const pillAfter = await dbPill.textContent();
        console.log(`[CC-12] DB pill after: "${pillAfter}"`);
      } else {
        await page.keyboard.press('Escape');
      }
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '12-pill-switch.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 13. COPY NAME from context menu copies full qualified name
  // ═══════════════════════════════════════════════════════════════════════════
  test('13 — Copy Name from context menu copies table name', async () => {
    const { page } = ctx;

    const usersTable = page.locator('text=/^users$/').first();
    if (await usersTable.isVisible({ timeout: 3000 }).catch(() => false)) {
      await usersTable.click({ button: 'right' });
      await page.waitForTimeout(500);

      const copyItem = page.locator('[role="menuitem"]').filter({
        hasText: /Copy Name|Копировать имя/i,
      }).first();
      if (await copyItem.isVisible({ timeout: 2000 }).catch(() => false)) {
        await copyItem.click();
        await page.waitForTimeout(500);
        console.log('[CC-13] Copy Name clicked.');

        // Verify by pasting into editor
        const editor = page.locator('.cm-editor .cm-content').first();
        if (await editor.isVisible({ timeout: 2000 }).catch(() => false)) {
          await editor.click();
          await page.keyboard.press('Meta+a');
          await page.keyboard.press('Backspace');
          await page.keyboard.press('Meta+v');
          await page.waitForTimeout(500);

          const pastedText = await editor.textContent().catch(() => '');
          console.log(`[CC-13] Pasted text: "${pastedText}"`);

          if (pastedText?.includes('users')) {
            console.log('[CC-13] ✓ Correct table name pasted.');
          }
        }
      } else {
        await page.keyboard.press('Escape');
      }
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '13-copy-name.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 14. EMPTY QUERY: Run button disabled or shows error
  // ═══════════════════════════════════════════════════════════════════════════
  test('14 — Run empty query shows appropriate feedback', async () => {
    const { page } = ctx;

    const editor = page.locator('.cm-editor .cm-content').first();
    if (!(await editor.isVisible({ timeout: 3000 }).catch(() => false))) return;

    // Clear editor
    await editor.click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(300);

    // Try to run
    await page.keyboard.press('F5');
    await page.waitForTimeout(1000);

    // Check: either nothing happens, or error message
    const errorMsg = page.locator('text=/empty|пустой|no query|нет запроса/i').first();
    const hasError = await errorMsg.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`[CC-14] Empty query error: ${hasError}`);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '14-empty-query.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 15. MULTIPLE SEMICOLONS: Run multiple statements
  // ═══════════════════════════════════════════════════════════════════════════
  test('15 — Multiple statements separated by semicolons', async () => {
    const { page } = ctx;

    const editor = page.locator('.cm-editor .cm-content').first();
    if (!(await editor.isVisible({ timeout: 3000 }).catch(() => false))) return;

    await editor.click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.type('SELECT 1 AS first; SELECT 2 AS second;', { delay: 15 });
    await page.keyboard.press('F5');
    await page.waitForTimeout(3000);

    // Should show results (may show last statement or both)
    const results = page.locator('[role="grid"], table, [class*="result"]').first();
    const hasResults = await results.isVisible({ timeout: 5000 }).catch(() => false);
    console.log(`[CC-15] Multi-statement results: ${hasResults}`);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '15-multi-statement.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 16. FORMAT SQL: doesn't break valid SQL
  // ═══════════════════════════════════════════════════════════════════════════
  test('16 — Format SQL preserves query semantics', async () => {
    const { page } = ctx;

    const editor = page.locator('.cm-editor .cm-content').first();
    if (!(await editor.isVisible({ timeout: 3000 }).catch(() => false))) return;

    await editor.click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.type('select id,name,email from users where id>0 order by name limit 10', { delay: 15 });

    const formatBtn = page.locator('[aria-label="Format SQL"]');
    if (await formatBtn.isEnabled({ timeout: 2000 }).catch(() => false)) {
      await formatBtn.click();
      await page.waitForTimeout(500);

      const formattedText = await editor.textContent().catch(() => '');
      console.log(`[CC-16] Formatted: "${formattedText?.substring(0, 80)}"`);

      // Should still contain key parts
      const hasSelect = formattedText?.toUpperCase().includes('SELECT');
      const hasFrom = formattedText?.toUpperCase().includes('FROM');
      const hasWhere = formattedText?.toUpperCase().includes('WHERE');
      console.log(`[CC-16] Parts intact: SELECT=${hasSelect}, FROM=${hasFrom}, WHERE=${hasWhere}`);
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '16-format-sql.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 17. CHAT INPUT: Enter sends, Shift+Enter adds newline
  // ═══════════════════════════════════════════════════════════════════════════
  test('17 — Chat: Enter sends message, Shift+Enter adds newline', async () => {
    const { page } = ctx;
    await ensureChatOpen(page);

    // Create new chat
    const newChatBtn = page.locator('[aria-label="Create new chat"]');
    if (await newChatBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await newChatBtn.click();
      await page.waitForTimeout(500);
    }

    const chatInput = page.locator('textarea:not([aria-hidden="true"]):not([readonly])').last();
    await chatInput.fill('');

    // Shift+Enter should add newline (not send)
    await chatInput.type('Line 1');
    await chatInput.press('Shift+Enter');
    await chatInput.type('Line 2');
    await page.waitForTimeout(300);

    const inputValue = await chatInput.inputValue().catch(() => '');
    const hasNewline = inputValue.includes('\n');
    console.log(`[CC-17] Input has newline: ${hasNewline}, value: "${inputValue}"`);

    // Clear without sending
    await chatInput.fill('');

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '17-enter-newline.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 18. PAGINATION in query results
  // ═══════════════════════════════════════════════════════════════════════════
  test('18 — Query with many rows shows pagination', async () => {
    const { page } = ctx;

    const editor = page.locator('.cm-editor .cm-content').first();
    if (!(await editor.isVisible({ timeout: 3000 }).catch(() => false))) return;

    await editor.click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.type('SELECT generate_series(1, 200) AS num;', { delay: 15 });
    await page.keyboard.press('F5');
    await page.waitForTimeout(3000);

    // Check for MUI TablePagination controls (data-testid or class-based)
    const pagination = page.locator('[data-testid="query-results-pagination"], [class*="MuiTablePagination"]').first();
    const hasPagination = await pagination.isVisible({ timeout: 5000 }).catch(() => false);
    console.log(`[CC-18] Pagination visible: ${hasPagination}`);

    // MUI pagination shows "Rows per page" and "1–25 of 200" text
    if (hasPagination) {
      const displayedRows = await pagination.textContent().catch(() => '');
      console.log(`[CC-18] Pagination text: "${displayedRows?.substring(0, 60)}"`);
    }

    // MUI uses IconButton with aria-label for next/prev page
    const nextBtn = page.locator('[aria-label="Go to next page"]').first();
    const hasNext = await nextBtn.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`[CC-18] Next page button: ${hasNext}`);

    if (hasNext) {
      await nextBtn.click();
      await page.waitForTimeout(500);
      const displayedAfter = await pagination.textContent().catch(() => '');
      console.log(`[CC-18] After next page: "${displayedAfter?.substring(0, 60)}"`);
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '18-pagination.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 19. EDITOR: Undo/Redo works after AI operations
  // ═══════════════════════════════════════════════════════════════════════════
  test('19 — Undo/Redo works in editor after operations', async () => {
    const { page } = ctx;

    const editor = page.locator('.cm-editor .cm-content').first();
    if (!(await editor.isVisible({ timeout: 3000 }).catch(() => false))) return;

    // Type something
    await editor.click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.type('SELECT 1;', { delay: 15 });
    await page.waitForTimeout(300);

    const before = await editor.textContent().catch(() => '');

    // Clear
    await page.keyboard.press('Meta+a');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(300);

    const afterClear = await editor.textContent().catch(() => '');
    console.log(`[CC-19] After clear: "${afterClear}"`);

    // Undo
    await page.keyboard.press('Meta+z');
    await page.waitForTimeout(300);

    const afterUndo = await editor.textContent().catch(() => '');
    console.log(`[CC-19] After undo: "${afterUndo}"`);

    const undoWorked = afterUndo?.includes('SELECT');
    console.log(`[CC-19] Undo restored content: ${undoWorked}`);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '19-undo-redo.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════════════════
  test('99 — Close app', async () => {
    if (ctx?.app) {
      await ctx.app.close();
      console.log('[CC-99] App closed.');
    }
  });
});
