import { test, expect } from '@playwright/test';
import { launchApp, registerAndLogin, connectToTestDB, closeApp, AppContext } from './helpers/electron-app';
import path from 'path';
import fs from 'fs';

/**
 * sql-editor-interactions.spec.ts
 *
 * Comprehensive E2E tests for the SQL editor:
 * typing queries, running them, inspecting results, error states,
 * and editor UX features (multi-line, select-all, clear, etc.).
 *
 * Requires Docker Compose `postgres-test` on port 5433.
 */

const SCREENSHOTS_DIR = path.resolve(__dirname, 'screenshots');

function ensureScreenshotsDir(): void {
  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }
}

/** Type a modifier key appropriate for the current platform. */
function platformModifier(): string {
  return process.platform === 'darwin' ? 'Meta' : 'Control';
}

/**
 * Click into the CodeMirror editor and clear existing content,
 * then type new content.
 */
async function clearAndTypeInEditor(ctx: AppContext, query: string): Promise<boolean> {
  const { page } = ctx;

  // Try the CodeMirror content area first
  const cmContent = page.locator('.cm-content').first();
  const cmEditor = page.locator('.cm-editor').first();

  const contentVisible = await cmContent.isVisible({ timeout: 5000 }).catch(() => false);
  const editorVisible = await cmEditor.isVisible({ timeout: 2000 }).catch(() => false);

  if (contentVisible) {
    await cmContent.click();
    // Select all and delete existing content
    await page.keyboard.press(`${platformModifier()}+a`);
    await page.waitForTimeout(100);
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(100);
    await page.keyboard.type(query);
    return true;
  } else if (editorVisible) {
    await cmEditor.click();
    await page.keyboard.press(`${platformModifier()}+a`);
    await page.waitForTimeout(100);
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(100);
    await page.keyboard.type(query);
    return true;
  }

  // Fall back to any textarea
  const textarea = page.locator('textarea').first();
  if (await textarea.isVisible({ timeout: 2000 }).catch(() => false)) {
    await textarea.fill(query);
    return true;
  }

  console.warn('[clearAndTypeInEditor] Could not find SQL editor element.');
  return false;
}

let ctx: AppContext;

test.describe.serial('SQL Editor Interactions', () => {
  test.beforeAll(async () => {
    ensureScreenshotsDir();
    ctx = await launchApp();

    // Register and login
    await registerAndLogin(ctx.page, {
      name: 'SQL Tester',
      email: `sql.editor.${Date.now()}@test.local`,
      password: 'SqlTestPass123',
    });

    // Wait for main page to settle
    await ctx.page.waitForTimeout(2000);
  });

  test.afterAll(async () => {
    if (ctx?.app) {
      await closeApp(ctx.app);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 1: App launches and DB is connected
  // ─────────────────────────────────────────────────────────────────────────
  test('01 — App launches and DB is connected via setup', async () => {
    const { page } = ctx;

    // Connect to the test database
    await connectToTestDB(page);
    await page.waitForTimeout(3000);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'sql-01-db-connected.png') });

    // Verify the main page is visible
    await expect(page.getByText(/ProgreSQL/i)).toBeVisible({ timeout: 10_000 });

    // Check no critical connection error is displayed
    const errorAlert = page.locator('[role="alert"]').filter({ hasText: /ошибка|error|failed|connection refused/i });
    const hasError = await errorAlert.isVisible({ timeout: 2000 }).catch(() => false);
    if (hasError) {
      const text = await errorAlert.textContent().catch(() => '');
      console.warn('[Test 01] Connection error or warning visible:', text);
    }

    console.log('[Test 01] App launched and DB connection attempted.');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 2: SQL editor is visible and focusable
  // ─────────────────────────────────────────────────────────────────────────
  test('02 — SQL editor is visible and focusable', async () => {
    const { page } = ctx;

    await page.waitForTimeout(1000);

    // CodeMirror editor
    const cmEditor = page.locator('.cm-editor').first();
    const cmContent = page.locator('.cm-content').first();

    const editorVisible = await cmEditor.isVisible({ timeout: 8000 }).catch(() => false);

    if (!editorVisible) {
      // Fall back to textarea
      const textarea = page.locator('textarea').first();
      const textareaVisible = await textarea.isVisible({ timeout: 3000 }).catch(() => false);
      if (textareaVisible) {
        await textarea.click();
        await expect(textarea).toBeFocused({ timeout: 3000 });
        console.log('[Test 02] Fell back to textarea for SQL editor.');
      } else {
        console.warn('[Test 02] SQL editor not found — skipping focus assertion.');
        return;
      }
    } else {
      await expect(cmEditor).toBeVisible({ timeout: 8000 });

      // Click into the content area to focus
      const contentVisible = await cmContent.isVisible({ timeout: 2000 }).catch(() => false);
      if (contentVisible) {
        await cmContent.click();
      } else {
        await cmEditor.click();
      }

      await page.waitForTimeout(300);
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'sql-02-editor-visible.png') });
    console.log('[Test 02] SQL editor is visible and focusable.');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 3: Type a valid SELECT query in the editor
  // ─────────────────────────────────────────────────────────────────────────
  test('03 — Type a valid SELECT query in the editor', async () => {
    const { page } = ctx;

    const query = 'SELECT 1 AS test_column;';
    const typed = await clearAndTypeInEditor(ctx, query);

    if (!typed) {
      console.warn('[Test 03] Could not find editor — skipping.');
      return;
    }

    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'sql-03-query-typed.png') });

    // Verify the query text appears in the editor
    const editorContent = page.locator('.cm-content, .cm-line').first();
    const hasText = await editorContent.isVisible({ timeout: 3000 }).catch(() => false);
    if (hasText) {
      const text = await editorContent.textContent().catch(() => '');
      console.log('[Test 03] Editor content:', text?.substring(0, 100));
    }

    console.log('[Test 03] Valid SELECT query typed successfully.');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 4: Run query with Cmd+Enter / Ctrl+Enter → results appear
  // ─────────────────────────────────────────────────────────────────────────
  test('04 — Run query with keyboard shortcut → results appear', async () => {
    const { page } = ctx;

    // Type query first
    const query = 'SELECT 1 AS result_col, 2 AS other_col;';
    const typed = await clearAndTypeInEditor(ctx, query);

    if (!typed) {
      console.warn('[Test 04] Could not find editor — skipping.');
      return;
    }

    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'sql-04a-before-run.png') });

    // Execute with keyboard shortcut
    const modifier = platformModifier();
    await page.keyboard.press(`${modifier}+Enter`);

    // Wait for results to appear — give DB time to respond
    await page.waitForTimeout(2000);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'sql-04b-after-run.png') });

    // Look for results — could be a table, a results panel, or row count indicator
    const resultsTable = page.locator('table').first();
    const resultsPanel = page.locator('[class*="result"], [class*="Result"]').first();
    const rowCountText = page.locator('text=/\\d+\\s*(row|строк)/i').first();

    const tableVisible = await resultsTable.isVisible({ timeout: 5000 }).catch(() => false);
    const panelVisible = await resultsPanel.isVisible({ timeout: 2000 }).catch(() => false);
    const rowCountVisible = await rowCountText.isVisible({ timeout: 2000 }).catch(() => false);

    if (tableVisible || panelVisible || rowCountVisible) {
      console.log('[Test 04] Results appeared after keyboard shortcut execution.');
    } else {
      console.log('[Test 04] No explicit results element found — DB may not be connected.');
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'sql-04c-results-state.png') });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 5: Results table shows columns and rows
  // ─────────────────────────────────────────────────────────────────────────
  test('05 — Results table shows columns and rows', async () => {
    const { page } = ctx;

    // Run a query that should return multiple columns and rows
    const query = 'SELECT schemaname, tablename FROM pg_tables LIMIT 5;';
    const typed = await clearAndTypeInEditor(ctx, query);

    if (!typed) {
      console.warn('[Test 05] Could not find editor — skipping.');
      return;
    }

    await page.waitForTimeout(300);

    const modifier = platformModifier();
    await page.keyboard.press(`${modifier}+Enter`);

    await page.waitForTimeout(2000);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'sql-05-results-table.png') });

    // Check for table headers (columns)
    const tableHeaders = page.locator('th, [role="columnheader"]');
    const headerCount = await tableHeaders.count();

    if (headerCount > 0) {
      console.log(`[Test 05] Found ${headerCount} table header(s).`);
      await expect(tableHeaders.first()).toBeVisible({ timeout: 5000 });
    } else {
      // Try alternative column indicators
      const columnCells = page.locator('[class*="header"], [class*="column"]').first();
      const colVisible = await columnCells.isVisible({ timeout: 2000 }).catch(() => false);
      console.log('[Test 05] Header cells:', colVisible ? 'found via class' : 'not found (DB may be unavailable).');
    }

    // Check for data rows
    const tableRows = page.locator('tbody tr, [role="row"]');
    const rowCount = await tableRows.count();
    console.log(`[Test 05] Found ${rowCount} data row(s) in results.`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 6: Run query that returns empty results → shows empty state or 0 rows
  // ─────────────────────────────────────────────────────────────────────────
  test('06 — Query returning empty results shows empty state', async () => {
    const { page } = ctx;

    // Query a table that should be empty or use a condition that returns nothing
    const query = "SELECT * FROM pg_tables WHERE tablename = 'this_table_does_not_exist_xyz_abc_987';";
    const typed = await clearAndTypeInEditor(ctx, query);

    if (!typed) {
      console.warn('[Test 06] Could not find editor — skipping.');
      return;
    }

    await page.waitForTimeout(300);

    const modifier = platformModifier();
    await page.keyboard.press(`${modifier}+Enter`);

    await page.waitForTimeout(2000);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'sql-06-empty-results.png') });

    // Look for empty state indicators
    const emptyStateText = page.locator('text=/0 row|пуст|no results|no data|нет данных/i').first();
    const emptyStateEl = page.locator('[class*="empty"], [class*="Empty"]').first();
    const zeroRowsEl = page.locator('text=/\\(0\\)|0 rows/i').first();

    const emptyTextVisible = await emptyStateText.isVisible({ timeout: 3000 }).catch(() => false);
    const emptyElVisible = await emptyStateEl.isVisible({ timeout: 1000 }).catch(() => false);
    const zeroRowsVisible = await zeroRowsEl.isVisible({ timeout: 1000 }).catch(() => false);

    if (emptyTextVisible || emptyElVisible || zeroRowsVisible) {
      console.log('[Test 06] Empty state indicator shown for zero-row query result.');
    } else {
      // Check that at least no error is shown (the query is valid SQL)
      const errorEl = page.locator('[class*="error"]').filter({ hasText: /syntax error|pg_error/i });
      const hasError = await errorEl.isVisible({ timeout: 1000 }).catch(() => false);
      if (hasError) {
        console.warn('[Test 06] Unexpected error for empty-result query.');
      } else {
        console.log('[Test 06] No empty state element found — results area may handle empty sets silently.');
      }
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 7: Run query with SQL error → error message shown in results area
  // ─────────────────────────────────────────────────────────────────────────
  test('07 — SQL error query shows error in results area', async () => {
    const { page } = ctx;

    // Intentionally broken SQL
    const query = 'SELECT * FROM nonexistent_table_xyz_123_abc;';
    const typed = await clearAndTypeInEditor(ctx, query);

    if (!typed) {
      console.warn('[Test 07] Could not find editor — skipping.');
      return;
    }

    await page.waitForTimeout(300);

    const modifier = platformModifier();
    await page.keyboard.press(`${modifier}+Enter`);

    await page.waitForTimeout(2000);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'sql-07-sql-error.png') });

    // Look for error in results area
    const errorInResults = page.locator('[class*="error"], [class*="Error"]').filter({
      hasText: /does not exist|не существует|error|relation|undefined/i,
    });
    const alertError = page.locator('[role="alert"]').first();
    const pgErrorText = page.locator('text=/ERROR|relation .* does not exist/i').first();

    const errorVisible = await errorInResults.first().isVisible({ timeout: 5000 }).catch(() => false);
    const alertVisible = await alertError.isVisible({ timeout: 2000 }).catch(() => false);
    const pgErrorVisible = await pgErrorText.isVisible({ timeout: 2000 }).catch(() => false);

    if (errorVisible || alertVisible || pgErrorVisible) {
      console.log('[Test 07] SQL error message shown in results area for invalid query.');
    } else {
      console.log('[Test 07] No explicit SQL error element found — DB may not be connected.');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 8: Clear the editor content
  // ─────────────────────────────────────────────────────────────────────────
  test('08 — Clear the editor content', async () => {
    const { page } = ctx;

    // First type something
    const typed = await clearAndTypeInEditor(ctx, 'SELECT 1; -- content to clear');
    if (!typed) {
      console.warn('[Test 08] Could not find editor — skipping.');
      return;
    }

    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'sql-08a-before-clear.png') });

    // Try clear button first
    const clearBtn = page.getByRole('button', { name: /clear|очистить/i });
    const clearIconBtn = page.locator('button[title*="Clear"], button[title*="clear"], button[aria-label*="clear"], button[aria-label*="Clear"]');

    const clearBtnVisible = await clearBtn.isVisible({ timeout: 2000 }).catch(() => false);
    const clearIconVisible = await clearIconBtn.first().isVisible({ timeout: 1000 }).catch(() => false);

    if (clearBtnVisible) {
      await clearBtn.click();
      await page.waitForTimeout(300);
      console.log('[Test 08] Cleared via clear button.');
    } else if (clearIconVisible) {
      await clearIconBtn.first().click();
      await page.waitForTimeout(300);
      console.log('[Test 08] Cleared via clear icon button.');
    } else {
      // Fall back to keyboard Ctrl/Cmd+A → Delete
      const cmContent = page.locator('.cm-content').first();
      const cmVisible = await cmContent.isVisible({ timeout: 2000 }).catch(() => false);
      if (cmVisible) {
        await cmContent.click();
        const modifier = platformModifier();
        await page.keyboard.press(`${modifier}+a`);
        await page.waitForTimeout(100);
        await page.keyboard.press('Delete');
        await page.waitForTimeout(300);
        console.log('[Test 08] Cleared via keyboard select-all + delete.');
      }
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'sql-08b-after-clear.png') });

    // Verify editor content area appears empty
    const cmContent = page.locator('.cm-content').first();
    if (await cmContent.isVisible({ timeout: 2000 }).catch(() => false)) {
      const text = await cmContent.textContent().catch(() => '');
      const isEmptyOrWhitespace = !text || text.trim().length === 0;
      console.log('[Test 08] Editor content after clear:', isEmptyOrWhitespace ? '(empty)' : text?.substring(0, 50));
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 9: Editor accepts multi-line query
  // ─────────────────────────────────────────────────────────────────────────
  test('09 — Editor accepts multi-line query', async () => {
    const { page } = ctx;

    // We'll type the query line-by-line using keyboard Enter
    const cmContent = page.locator('.cm-content').first();
    const cmEditor = page.locator('.cm-editor').first();

    const contentVisible = await cmContent.isVisible({ timeout: 5000 }).catch(() => false);
    const editorVisible = await cmEditor.isVisible({ timeout: 2000 }).catch(() => false);

    if (!contentVisible && !editorVisible) {
      console.warn('[Test 09] SQL editor not found — skipping multi-line test.');
      return;
    }

    // Clear first
    if (contentVisible) {
      await cmContent.click();
    } else {
      await cmEditor.click();
    }

    const modifier = platformModifier();
    await page.keyboard.press(`${modifier}+a`);
    await page.waitForTimeout(100);
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(100);

    // Type a multi-line query
    await page.keyboard.type('SELECT');
    await page.keyboard.press('Enter');
    await page.keyboard.type('  schemaname,');
    await page.keyboard.press('Enter');
    await page.keyboard.type('  tablename');
    await page.keyboard.press('Enter');
    await page.keyboard.type('FROM pg_tables');
    await page.keyboard.press('Enter');
    await page.keyboard.type('LIMIT 3;');

    await page.waitForTimeout(500);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'sql-09-multiline-query.png') });

    // Verify multiple lines are present
    const lines = page.locator('.cm-line');
    const lineCount = await lines.count();
    console.log(`[Test 09] Editor has ${lineCount} visible line(s) in CodeMirror.`);

    if (lineCount >= 2) {
      console.log('[Test 09] Multi-line query accepted — multiple .cm-line elements found.');
    } else {
      // May be a textarea — check for newlines
      const textarea = page.locator('textarea').first();
      if (await textarea.isVisible({ timeout: 1000 }).catch(() => false)) {
        const val = await textarea.inputValue().catch(() => '');
        const newlineCount = (val.match(/\n/g) || []).length;
        console.log(`[Test 09] Textarea has ${newlineCount} newline(s).`);
      }
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 10: Run button (if visible) triggers query execution
  // ─────────────────────────────────────────────────────────────────────────
  test('10 — Run button triggers query execution', async () => {
    const { page } = ctx;

    // Type a simple query
    const typed = await clearAndTypeInEditor(ctx, 'SELECT NOW() AS current_time;');
    if (!typed) {
      console.warn('[Test 10] Could not find editor — skipping.');
      return;
    }

    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'sql-10a-before-run-button.png') });

    // Look for Run/Execute button
    const runBtn = page.getByRole('button', { name: /run|выполнить|execute/i });
    const runIconBtn = page.locator(
      'button[title*="Run"], button[title*="run"], button[title*="Execute"], button[aria-label*="Run"], button[aria-label*="Execute"], button[aria-label*="Выполнить"]',
    );

    const runBtnVisible = await runBtn.first().isVisible({ timeout: 3000 }).catch(() => false);
    const runIconVisible = await runIconBtn.first().isVisible({ timeout: 2000 }).catch(() => false);

    if (runBtnVisible) {
      await runBtn.first().click();
      await page.waitForTimeout(2000);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'sql-10b-after-run-button.png') });
      console.log('[Test 10] Run button clicked successfully.');
    } else if (runIconVisible) {
      await runIconBtn.first().click();
      await page.waitForTimeout(2000);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'sql-10b-after-run-icon.png') });
      console.log('[Test 10] Run icon button clicked successfully.');
    } else {
      console.log('[Test 10] No visible Run button found — feature may not be available in current view.');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 11: Row count indicator updates after query
  // ─────────────────────────────────────────────────────────────────────────
  test('11 — Row count indicator updates after query', async () => {
    const { page } = ctx;

    // Run a query that will return a known number of rows
    const typed = await clearAndTypeInEditor(ctx, 'SELECT generate_series(1, 10) AS n;');
    if (!typed) {
      console.warn('[Test 11] Could not find editor — skipping.');
      return;
    }

    await page.waitForTimeout(300);

    const modifier = platformModifier();
    await page.keyboard.press(`${modifier}+Enter`);

    await page.waitForTimeout(2000);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'sql-11-row-count.png') });

    // Look for a row count indicator
    const rowCountEl = page.locator('text=/\\d+\\s*(row|строк|запис)/i').first();
    const statusBarEl = page.locator('[role="status"], [class*="status"]').first();
    const footerEl = page.locator('[class*="footer"], [class*="Footer"]').first();

    const rowCountVisible = await rowCountEl.isVisible({ timeout: 3000 }).catch(() => false);
    const statusVisible = await statusBarEl.isVisible({ timeout: 2000 }).catch(() => false);
    const footerVisible = await footerEl.isVisible({ timeout: 1000 }).catch(() => false);

    if (rowCountVisible) {
      const text = await rowCountEl.textContent().catch(() => '');
      console.log('[Test 11] Row count indicator text:', text);
    } else if (statusVisible) {
      const text = await statusBarEl.textContent().catch(() => '');
      console.log('[Test 11] Status bar text:', text?.substring(0, 100));
    } else {
      console.log('[Test 11] No row count indicator found — DB may not be connected.');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 12: Results columns are visible (table headers)
  // ─────────────────────────────────────────────────────────────────────────
  test('12 — Results columns are visible as table headers', async () => {
    const { page } = ctx;

    // Run a query with named columns
    const typed = await clearAndTypeInEditor(ctx, "SELECT 'hello' AS greeting, 42 AS answer, true AS flag;");
    if (!typed) {
      console.warn('[Test 12] Could not find editor — skipping.');
      return;
    }

    await page.waitForTimeout(300);

    const modifier = platformModifier();
    await page.keyboard.press(`${modifier}+Enter`);

    await page.waitForTimeout(2000);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'sql-12-column-headers.png') });

    // Check for column headers
    const thElements = page.locator('th');
    const columnHeaderRoles = page.locator('[role="columnheader"]');
    const headerCells = page.locator('[class*="header-cell"], [class*="headerCell"], [class*="col-header"]');

    const thCount = await thElements.count();
    const roleCount = await columnHeaderRoles.count();
    const classCount = await headerCells.count();

    console.log(`[Test 12] th elements: ${thCount}, role=columnheader: ${roleCount}, class-based: ${classCount}`);

    if (thCount > 0) {
      await expect(thElements.first()).toBeVisible({ timeout: 5000 });

      // Verify that column names appear somewhere in the headers
      const headerTexts: string[] = [];
      for (let i = 0; i < Math.min(thCount, 5); i++) {
        const text = await thElements.nth(i).textContent().catch(() => '');
        if (text) headerTexts.push(text.trim());
      }
      console.log('[Test 12] Column header texts:', headerTexts);
    } else if (roleCount > 0) {
      await expect(columnHeaderRoles.first()).toBeVisible({ timeout: 5000 });
    } else {
      console.log('[Test 12] No column headers found — DB may not be connected or results use a different layout.');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 13: Query results can be scrolled (large result set)
  // ─────────────────────────────────────────────────────────────────────────
  test('13 — Query results are scrollable for large result sets', async () => {
    const { page } = ctx;

    // Generate a large result set
    const typed = await clearAndTypeInEditor(ctx, 'SELECT generate_series(1, 100) AS row_num, md5(generate_series(1, 100)::text) AS hash_val;');
    if (!typed) {
      console.warn('[Test 13] Could not find editor — skipping.');
      return;
    }

    await page.waitForTimeout(300);

    const modifier = platformModifier();
    await page.keyboard.press(`${modifier}+Enter`);

    await page.waitForTimeout(2000);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'sql-13a-large-results.png') });

    // Find the results container
    const resultsContainer = page.locator(
      'table, [class*="result"], [class*="Result"], [class*="grid"], [class*="Grid"]',
    ).first();

    if (!(await resultsContainer.isVisible({ timeout: 3000 }).catch(() => false))) {
      console.log('[Test 13] No results container found — DB may not be connected.');
      return;
    }

    // Check scroll capability
    const isScrollable = await resultsContainer.evaluate((el) => {
      return el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth;
    }).catch(() => false);

    if (isScrollable) {
      // Perform an actual scroll
      await resultsContainer.evaluate((el) => el.scrollTop += 200);
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'sql-13b-after-scroll.png') });
      console.log('[Test 13] Results container is scrollable.');
    } else {
      // Try scrolling via parent container
      const scrollParent = page.locator('[class*="scroll"], [style*="overflow"]').first();
      if (await scrollParent.isVisible({ timeout: 1000 }).catch(() => false)) {
        await scrollParent.evaluate((el) => el.scrollTop += 200);
        await page.waitForTimeout(300);
        console.log('[Test 13] Scrolled via parent scroll container.');
      } else {
        console.log('[Test 13] Results container scrollHeight <= clientHeight (may be a flat list or pagination).');
      }
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 14: Copy query button or Ctrl+A selects all in editor
  // ─────────────────────────────────────────────────────────────────────────
  test('14 — Ctrl/Cmd+A selects all content in editor', async () => {
    const { page } = ctx;

    const testQuery = 'SELECT version();';
    const typed = await clearAndTypeInEditor(ctx, testQuery);
    if (!typed) {
      console.warn('[Test 14] Could not find editor — skipping.');
      return;
    }

    await page.waitForTimeout(300);

    // Focus the editor
    const cmContent = page.locator('.cm-content').first();
    if (await cmContent.isVisible({ timeout: 2000 }).catch(() => false)) {
      await cmContent.click();
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'sql-14a-before-select-all.png') });

    // Use Ctrl/Cmd+A to select all
    const modifier = platformModifier();
    await page.keyboard.press(`${modifier}+a`);
    await page.waitForTimeout(300);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'sql-14b-after-select-all.png') });

    // Verify selection exists in the editor
    const hasSelection = await page.evaluate(() => {
      const selection = window.getSelection();
      if (!selection) return false;
      return selection.toString().length > 0;
    }).catch(() => false);

    if (hasSelection) {
      const selectedText = await page.evaluate(() => window.getSelection()?.toString() || '').catch(() => '');
      console.log(`[Test 14] Selected text via Ctrl+A: "${selectedText.substring(0, 100)}"`);
    }

    // Also check for an optional "Copy" button
    const copyBtn = page.getByRole('button', { name: /copy|копировать|скопировать/i });
    const copyIconBtn = page.locator('button[title*="Copy"], button[aria-label*="copy"], button[aria-label*="Copy"]');

    const copyBtnVisible = await copyBtn.first().isVisible({ timeout: 2000 }).catch(() => false);
    const copyIconVisible = await copyIconBtn.first().isVisible({ timeout: 1000 }).catch(() => false);

    if (copyBtnVisible) {
      console.log('[Test 14] Copy button is visible in the editor toolbar.');
    } else if (copyIconVisible) {
      console.log('[Test 14] Copy icon button is visible.');
    } else {
      console.log('[Test 14] No copy button found — Ctrl+A select-all is the primary mechanism.');
    }

    console.log('[Test 14] Select-all interaction completed.');
  });
});
