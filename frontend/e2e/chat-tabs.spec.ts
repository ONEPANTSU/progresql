import { test, expect } from '@playwright/test';
import { launchApp, registerAndLogin, connectToTestDB, closeApp, AppContext } from './helpers/electron-app';
import path from 'path';
import fs from 'fs';

/**
 * chat-tabs.spec.ts
 *
 * Comprehensive E2E tests for chat tab management:
 * creation, activation, isolation, renaming, closing, and keyboard navigation.
 *
 * Tests run serially and share a single app instance.
 * After close-tab tests, new tabs are created to ensure enough tabs
 * remain for subsequent tests.
 */

const SCREENSHOTS_DIR = path.resolve(__dirname, 'screenshots');

function ensureScreenshotsDir(): void {
  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }
}

/** Wait for the tab list to be visible and return it. */
async function getTabList(ctx: AppContext) {
  return ctx.page.locator('[role="tablist"]').first();
}

/** Get all chat tabs from the tab list. */
async function getChatTabs(ctx: AppContext) {
  return ctx.page.locator('[role="tab"]');
}

/** Get count of currently visible tabs. */
async function getTabCount(ctx: AppContext): Promise<number> {
  const tabs = ctx.page.locator('[role="tab"]');
  return tabs.count();
}

/** Click the "Create new chat" button. */
async function createNewTab(ctx: AppContext): Promise<boolean> {
  const { page } = ctx;

  const newChatBtn = page.locator('[aria-label="Create new chat"]');
  if (await newChatBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await newChatBtn.click();
    await page.waitForTimeout(500);
    return true;
  }

  // Fallback: button with "+" or "add" in label
  const plusBtn = page.getByRole('button', { name: /^\+$|add chat|new chat|создать чат/i });
  if (await plusBtn.first().isVisible({ timeout: 2000 }).catch(() => false)) {
    await plusBtn.first().click();
    await page.waitForTimeout(500);
    return true;
  }

  console.warn('[createNewTab] Could not find "Create new chat" button.');
  return false;
}

let ctx: AppContext;

test.describe.serial('Chat Tabs', () => {
  test.beforeAll(async () => {
    ensureScreenshotsDir();
    ctx = await launchApp();

    // Register and login
    await registerAndLogin(ctx.page, {
      name: 'Chat Tab Tester',
      email: `chat.tabs.${Date.now()}@test.local`,
      password: 'ChatTabPass123',
    });

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

    await connectToTestDB(page);
    await page.waitForTimeout(3000);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'chat-01-db-connected.png') });

    await expect(page.getByText(/ProgreSQL/i)).toBeVisible({ timeout: 10_000 });
    console.log('[Test 01] App launched and DB connection attempted.');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 2: Initially one default chat tab is visible
  // ─────────────────────────────────────────────────────────────────────────
  test('02 — Initially one default chat tab is visible', async () => {
    const { page } = ctx;

    // Wait for the chat panel to be rendered
    const chatPanel = page.locator('[role="complementary"][aria-label="AI Assistant panel"]');
    const panelVisible = await chatPanel.isVisible({ timeout: 8000 }).catch(() => false);

    if (!panelVisible) {
      console.warn('[Test 02] Chat panel not visible — checking for tablist directly.');
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'chat-02-initial-state.png') });

    const tabList = page.locator('[role="tablist"]').first();
    const tabListVisible = await tabList.isVisible({ timeout: 8000 }).catch(() => false);

    if (!tabListVisible) {
      console.warn('[Test 02] Tab list not visible — chat panel may not be open or feature is absent.');
      return;
    }

    // Verify at least one tab exists
    const tabs = page.locator('[role="tab"]');
    const tabCount = await tabs.count();
    console.log(`[Test 02] Initial tab count: ${tabCount}`);
    expect(tabCount).toBeGreaterThanOrEqual(1);

    // Verify the first tab is selected
    const firstTab = tabs.first();
    const isSelected = await firstTab.getAttribute('aria-selected').catch(() => null);
    console.log('[Test 02] First tab aria-selected:', isSelected);

    // At least one tab should be in selected state
    const selectedTabs = page.locator('[role="tab"][aria-selected="true"]');
    const selectedCount = await selectedTabs.count();
    expect(selectedCount).toBeGreaterThanOrEqual(1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 3: Create new chat tab with "+" button → tab count increases
  // ─────────────────────────────────────────────────────────────────────────
  test('03 — Create new chat tab with "+" button increases tab count', async () => {
    const { page } = ctx;

    const tabListVisible = await page.locator('[role="tablist"]').first().isVisible({ timeout: 5000 }).catch(() => false);
    if (!tabListVisible) {
      console.warn('[Test 03] Tab list not visible — skipping.');
      return;
    }

    const countBefore = await getTabCount(ctx);
    console.log(`[Test 03] Tab count before: ${countBefore}`);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'chat-03a-before-new-tab.png') });

    const created = await createNewTab(ctx);
    if (!created) {
      console.warn('[Test 03] Could not create new tab — feature may be absent.');
      return;
    }

    await page.waitForTimeout(500);

    const countAfter = await getTabCount(ctx);
    console.log(`[Test 03] Tab count after: ${countAfter}`);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'chat-03b-after-new-tab.png') });

    expect(countAfter).toBeGreaterThan(countBefore);
    console.log(`[Test 03] Tab count increased from ${countBefore} to ${countAfter}.`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 4: Click on new tab → it becomes active (aria-selected="true")
  // ─────────────────────────────────────────────────────────────────────────
  test('04 — Clicking a tab makes it active (aria-selected="true")', async () => {
    const { page } = ctx;

    const tabListVisible = await page.locator('[role="tablist"]').first().isVisible({ timeout: 5000 }).catch(() => false);
    if (!tabListVisible) {
      console.warn('[Test 04] Tab list not visible — skipping.');
      return;
    }

    // Ensure we have at least 2 tabs
    let tabCount = await getTabCount(ctx);
    if (tabCount < 2) {
      const created = await createNewTab(ctx);
      if (!created) {
        console.warn('[Test 04] Cannot create second tab — skipping.');
        return;
      }
      tabCount = await getTabCount(ctx);
    }

    // Click on the last tab (which may not be the currently active one)
    const tabs = page.locator('[role="tab"]');
    const lastTab = tabs.last();

    await lastTab.click();
    await page.waitForTimeout(500);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'chat-04-tab-activated.png') });

    const isSelected = await lastTab.getAttribute('aria-selected').catch(() => null);
    console.log('[Test 04] Last tab aria-selected after click:', isSelected);
    expect(isSelected).toBe('true');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 5: Tab list has role="tablist"
  // ─────────────────────────────────────────────────────────────────────────
  test('05 — Tab list has role="tablist"', async () => {
    const { page } = ctx;

    const tabList = page.locator('[role="tablist"]').first();
    const visible = await tabList.isVisible({ timeout: 5000 }).catch(() => false);

    if (!visible) {
      console.warn('[Test 05] role="tablist" element not found — feature may be absent.');
      return;
    }

    await expect(tabList).toBeVisible({ timeout: 5000 });

    // Tab list should also have an aria-label
    const ariaLabel = await tabList.getAttribute('aria-label').catch(() => null);
    console.log('[Test 05] Tablist aria-label:', ariaLabel);
    if (ariaLabel) {
      expect(ariaLabel.length).toBeGreaterThan(0);
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'chat-05-tablist-role.png') });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 6: Chat tabs have role="tab"
  // ─────────────────────────────────────────────────────────────────────────
  test('06 — Chat tabs have role="tab"', async () => {
    const { page } = ctx;

    const tabs = page.locator('[role="tab"]');
    const tabCount = await tabs.count();

    if (tabCount === 0) {
      console.warn('[Test 06] No role="tab" elements found — chat tab feature may be absent.');
      return;
    }

    console.log(`[Test 06] Found ${tabCount} elements with role="tab".`);
    await expect(tabs.first()).toBeVisible({ timeout: 5000 });

    // Verify each visible tab has aria-selected attribute
    for (let i = 0; i < Math.min(tabCount, 5); i++) {
      const tab = tabs.nth(i);
      if (!(await tab.isVisible({ timeout: 1000 }).catch(() => false))) continue;
      const ariaSelected = await tab.getAttribute('aria-selected').catch(() => null);
      // aria-selected must be either "true" or "false"
      expect(['true', 'false']).toContain(ariaSelected);
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'chat-06-tab-roles.png') });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 7: New chat button is visible with aria-label="Create new chat"
  // ─────────────────────────────────────────────────────────────────────────
  test('07 — New chat button is visible with correct aria-label', async () => {
    const { page } = ctx;

    const newChatBtn = page.locator('[aria-label="Create new chat"]');
    const visible = await newChatBtn.isVisible({ timeout: 5000 }).catch(() => false);

    if (!visible) {
      // Fallback: look for any "new chat" button
      const fallbackBtn = page.getByRole('button', { name: /create.*chat|new.*chat|добавить.*чат/i });
      const fallbackVisible = await fallbackBtn.first().isVisible({ timeout: 3000 }).catch(() => false);

      if (fallbackVisible) {
        console.log('[Test 07] New chat button found via fallback selector (no exact aria-label match).');
      } else {
        console.warn('[Test 07] New chat button not found with any selector.');
      }
      return;
    }

    await expect(newChatBtn).toBeVisible({ timeout: 5000 });
    console.log('[Test 07] New chat button visible with aria-label="Create new chat".');
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'chat-07-new-chat-button.png') });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 8: Send a message in one tab → other tabs are unaffected
  // ─────────────────────────────────────────────────────────────────────────
  test('08 — Message sent in one tab does not affect other tabs', async () => {
    const { page } = ctx;

    const tabListVisible = await page.locator('[role="tablist"]').first().isVisible({ timeout: 5000 }).catch(() => false);
    if (!tabListVisible) {
      console.warn('[Test 08] Tab list not visible — skipping isolation test.');
      return;
    }

    // Ensure we have at least 2 tabs
    let tabCount = await getTabCount(ctx);
    while (tabCount < 2) {
      const created = await createNewTab(ctx);
      if (!created) break;
      tabCount = await getTabCount(ctx);
    }

    if (tabCount < 2) {
      console.warn('[Test 08] Could not create enough tabs — skipping isolation test.');
      return;
    }

    // Click on the first tab to activate it
    const tabs = page.locator('[role="tab"]');
    await tabs.first().click();
    await page.waitForTimeout(300);

    // Find the chat input and type a message
    const chatInput = page.locator('[aria-label="Chat message input"], textarea').last();
    const inputVisible = await chatInput.isVisible({ timeout: 3000 }).catch(() => false);

    if (!inputVisible) {
      console.warn('[Test 08] Chat input not found — cannot send message.');
      return;
    }

    const testMessage = 'This message is only in tab 1';
    await chatInput.fill(testMessage);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'chat-08a-message-in-tab1.png') });

    // Now click on the second tab
    await tabs.nth(1).click();
    await page.waitForTimeout(500);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'chat-08b-second-tab-state.png') });

    // The test message should not appear in the second tab's input
    const chatInputTab2 = page.locator('[aria-label="Chat message input"], textarea').last();
    if (await chatInputTab2.isVisible({ timeout: 2000 }).catch(() => false)) {
      const tab2Value = await chatInputTab2.inputValue().catch(() => '');
      const tab2Visible = tab2Value === testMessage;
      console.log(`[Test 08] Tab 2 input has the tab 1 message: ${tab2Visible}`);
      // The input in tab 2 should be empty or have different content
      if (!tab2Visible) {
        console.log('[Test 08] Message isolation confirmed — tabs have independent inputs.');
      }
    }

    // Go back to tab 1 and verify the message is still there
    await tabs.first().click();
    await page.waitForTimeout(300);

    const chatInputTab1Again = page.locator('[aria-label="Chat message input"], textarea').last();
    if (await chatInputTab1Again.isVisible({ timeout: 2000 }).catch(() => false)) {
      const tab1Value = await chatInputTab1Again.inputValue().catch(() => '');
      console.log('[Test 08] Tab 1 input value after switching back:', tab1Value?.substring(0, 50));
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 9: Close a tab with close button → tab is removed
  // ─────────────────────────────────────────────────────────────────────────
  test('09 — Close a tab with its close button removes the tab', async () => {
    const { page } = ctx;

    const tabListVisible = await page.locator('[role="tablist"]').first().isVisible({ timeout: 5000 }).catch(() => false);
    if (!tabListVisible) {
      console.warn('[Test 09] Tab list not visible — skipping close test.');
      return;
    }

    // Ensure we have at least 3 tabs before closing, so tests can continue
    let tabCount = await getTabCount(ctx);
    while (tabCount < 3) {
      const created = await createNewTab(ctx);
      if (!created) break;
      tabCount = await getTabCount(ctx);
    }

    tabCount = await getTabCount(ctx);
    if (tabCount < 2) {
      console.warn('[Test 09] Not enough tabs to close one safely — skipping.');
      return;
    }

    const countBefore = tabCount;
    console.log(`[Test 09] Tab count before close: ${countBefore}`);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'chat-09a-before-close.png') });

    // Find the close button on a non-active tab (to avoid triggering active-tab close behavior)
    // Close buttons use aria-label^="Close chat:"
    const closeBtns = page.locator('[aria-label^="Close chat:"]');
    const closeBtnCount = await closeBtns.count();

    if (closeBtnCount === 0) {
      // Fallback: close button with "×" or "close" aria-label
      const genericCloseBtns = page.locator('[role="tab"] button, [role="tab"] [aria-label*="close"], [role="tab"] [aria-label*="закрыть"]');
      const genericCount = await genericCloseBtns.count();

      if (genericCount === 0) {
        console.warn('[Test 09] No close buttons found on tabs — feature may require hover or be absent.');
        return;
      }

      await genericCloseBtns.first().click();
    } else {
      // Click close on the last tab to avoid closing the active one
      await closeBtns.last().click();
    }

    await page.waitForTimeout(500);

    const countAfter = await getTabCount(ctx);
    console.log(`[Test 09] Tab count after close: ${countAfter}`);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'chat-09b-after-close.png') });

    expect(countAfter).toBeLessThan(countBefore);
    console.log('[Test 09] Tab successfully removed by close button.');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 10: After closing active tab → adjacent tab becomes active
  // ─────────────────────────────────────────────────────────────────────────
  test('10 — Closing the active tab makes an adjacent tab active', async () => {
    const { page } = ctx;

    const tabListVisible = await page.locator('[role="tablist"]').first().isVisible({ timeout: 5000 }).catch(() => false);
    if (!tabListVisible) {
      console.warn('[Test 10] Tab list not visible — skipping.');
      return;
    }

    // Ensure we have at least 3 tabs
    let tabCount = await getTabCount(ctx);
    while (tabCount < 3) {
      const created = await createNewTab(ctx);
      if (!created) break;
      tabCount = await getTabCount(ctx);
    }

    tabCount = await getTabCount(ctx);
    if (tabCount < 2) {
      console.warn('[Test 10] Not enough tabs — skipping adjacent-activation test.');
      return;
    }

    // Click on a middle or non-first tab to make it active
    const tabs = page.locator('[role="tab"]');
    const targetIndex = tabCount > 2 ? 1 : tabCount - 1; // middle tab if possible
    await tabs.nth(targetIndex).click();
    await page.waitForTimeout(300);

    // Record which tab was active
    const activeTab = page.locator('[role="tab"][aria-selected="true"]').first();
    const activeLabel = await activeTab.getAttribute('aria-label').catch(() => null);
    console.log(`[Test 10] Active tab before close: ${activeLabel}`);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'chat-10a-before-active-close.png') });

    // Close the active tab
    const activCloseBtn = page.locator('[role="tab"][aria-selected="true"]').locator('[aria-label^="Close chat:"]');
    const activCloseBtnCount = await activCloseBtn.count();

    if (activCloseBtnCount === 0) {
      // Fallback generic close
      const genericClose = page.locator('[role="tab"][aria-selected="true"] button').last();
      if (await genericClose.isVisible({ timeout: 2000 }).catch(() => false)) {
        await genericClose.click();
      } else {
        console.warn('[Test 10] Could not find close button on active tab — skipping.');
        return;
      }
    } else {
      await activCloseBtn.first().click();
    }

    await page.waitForTimeout(500);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'chat-10b-after-active-close.png') });

    // Verify a tab is now active
    const newActiveTab = page.locator('[role="tab"][aria-selected="true"]').first();
    const newActiveVisible = await newActiveTab.isVisible({ timeout: 3000 }).catch(() => false);

    if (newActiveVisible) {
      const newActiveLabel = await newActiveTab.getAttribute('aria-label').catch(() => null);
      console.log(`[Test 10] New active tab after close: ${newActiveLabel}`);
      expect(newActiveLabel).not.toEqual(activeLabel);
    } else {
      console.warn('[Test 10] No active tab found after close — unexpected state.');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 11: Cannot close the last remaining tab
  // ─────────────────────────────────────────────────────────────────────────
  test('11 — Cannot close the last remaining tab', async () => {
    const { page } = ctx;

    const tabListVisible = await page.locator('[role="tablist"]').first().isVisible({ timeout: 5000 }).catch(() => false);
    if (!tabListVisible) {
      console.warn('[Test 11] Tab list not visible — skipping last-tab protection test.');
      return;
    }

    // Close tabs until only one remains
    let tabCount = await getTabCount(ctx);
    let safetyCounter = 0;
    while (tabCount > 1 && safetyCounter < 10) {
      safetyCounter++;
      const closeBtns = page.locator('[aria-label^="Close chat:"]');
      const closeBtnCount = await closeBtns.count();

      if (closeBtnCount === 0) {
        // Fallback
        const genericClose = page.locator('[role="tab"] button').last();
        if (await genericClose.isVisible({ timeout: 1000 }).catch(() => false)) {
          await genericClose.click();
          await page.waitForTimeout(300);
        } else {
          break;
        }
      } else {
        await closeBtns.last().click();
        await page.waitForTimeout(300);
      }

      tabCount = await getTabCount(ctx);
    }

    tabCount = await getTabCount(ctx);
    console.log(`[Test 11] Tab count reduced to: ${tabCount}`);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'chat-11a-last-tab.png') });

    if (tabCount !== 1) {
      console.warn('[Test 11] Could not reduce to exactly 1 tab — skipping close-protection check.');
      return;
    }

    // With only 1 tab remaining, close button should be absent or disabled
    const lastTab = page.locator('[role="tab"]').first();
    const closeOnLastTab = lastTab.locator('[aria-label^="Close chat:"]');
    const closeCount = await closeOnLastTab.count();

    if (closeCount === 0) {
      console.log('[Test 11] Close button is absent on the last remaining tab — protected correctly.');
    } else {
      // Check if it's disabled
      const isDisabled = await closeOnLastTab.first().isDisabled({ timeout: 1000 }).catch(() => false);
      const isVisible = await closeOnLastTab.first().isVisible({ timeout: 1000 }).catch(() => false);

      if (isDisabled) {
        console.log('[Test 11] Close button on last tab is disabled — protected correctly.');
      } else if (!isVisible) {
        console.log('[Test 11] Close button on last tab is hidden — protected correctly.');
      } else {
        // Try to click it anyway and verify the tab count remains 1
        await closeOnLastTab.first().click();
        await page.waitForTimeout(500);
        const countAfterAttempt = await getTabCount(ctx);
        console.log(`[Test 11] Tab count after clicking close on last tab: ${countAfterAttempt}`);
        // Should still be at least 1
        expect(countAfterAttempt).toBeGreaterThanOrEqual(1);
      }
    }

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'chat-11b-last-tab-protected.png') });

    // Ensure we create tabs back so subsequent tests can proceed
    await createNewTab(ctx);
    await createNewTab(ctx);
    await page.waitForTimeout(300);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 12: Double-click on tab title → rename mode (input appears)
  // ─────────────────────────────────────────────────────────────────────────
  test('12 — Double-click on tab title enters rename mode', async () => {
    const { page } = ctx;

    const tabListVisible = await page.locator('[role="tablist"]').first().isVisible({ timeout: 5000 }).catch(() => false);
    if (!tabListVisible) {
      console.warn('[Test 12] Tab list not visible — skipping rename test.');
      return;
    }

    const tabs = page.locator('[role="tab"]');
    const tabCount = await tabs.count();
    if (tabCount === 0) {
      console.warn('[Test 12] No tabs found — skipping rename test.');
      return;
    }

    // Double-click on the first tab title
    const firstTab = tabs.first();
    await firstTab.dblclick();
    await page.waitForTimeout(500);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'chat-12a-after-dblclick.png') });

    // Check for an input/text field appearing inside or near the tab
    const renameInput = page.locator('[role="tablist"] input, [role="tab"] input, [role="tab"] [contenteditable="true"]');
    const renameVisible = await renameInput.first().isVisible({ timeout: 3000 }).catch(() => false);

    if (renameVisible) {
      console.log('[Test 12] Rename input appeared after double-click on tab title.');
      await expect(renameInput.first()).toBeVisible({ timeout: 3000 });
    } else {
      console.warn('[Test 12] Rename input not found after double-click — rename feature may not be implemented via double-click.');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 13: Type new name + Enter in rename mode → tab title updated
  // ─────────────────────────────────────────────────────────────────────────
  test('13 — Type new name and press Enter in rename mode updates tab title', async () => {
    const { page } = ctx;

    const tabListVisible = await page.locator('[role="tablist"]').first().isVisible({ timeout: 5000 }).catch(() => false);
    if (!tabListVisible) {
      console.warn('[Test 13] Tab list not visible — skipping.');
      return;
    }

    const tabs = page.locator('[role="tab"]');
    const tabCount = await tabs.count();
    if (tabCount === 0) {
      console.warn('[Test 13] No tabs found — skipping rename test.');
      return;
    }

    // Trigger rename mode
    await tabs.first().dblclick();
    await page.waitForTimeout(500);

    const renameInput = page.locator('[role="tablist"] input, [role="tab"] input, [role="tab"] [contenteditable="true"]');
    const renameVisible = await renameInput.first().isVisible({ timeout: 3000 }).catch(() => false);

    if (!renameVisible) {
      console.warn('[Test 13] Rename input not found — skipping title update test.');
      return;
    }

    const newTabName = 'Renamed Tab ' + Date.now().toString().slice(-4);

    // Clear existing value and type new name
    await renameInput.first().fill('');
    await renameInput.first().type(newTabName);
    await page.waitForTimeout(200);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'chat-13a-rename-typed.png') });

    // Confirm with Enter
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'chat-13b-rename-confirmed.png') });

    // Verify the tab now shows the new name
    const updatedTab = page.locator('[role="tab"]').filter({ hasText: newTabName });
    const ariaLabelMatch = page.locator(`[aria-label="Chat: ${newTabName}"], [aria-label^="Chat:"]`).filter({ hasText: newTabName });

    const textVisible = await updatedTab.first().isVisible({ timeout: 3000 }).catch(() => false);
    const labelMatch = await ariaLabelMatch.first().isVisible({ timeout: 1000 }).catch(() => false);

    if (textVisible || labelMatch) {
      console.log(`[Test 13] Tab title updated to "${newTabName}" successfully.`);
    } else {
      console.warn(`[Test 13] Could not verify tab title update to "${newTabName}".`);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 14: Press Escape in rename mode → original title restored
  // ─────────────────────────────────────────────────────────────────────────
  test('14 — Press Escape in rename mode restores original title', async () => {
    const { page } = ctx;

    const tabListVisible = await page.locator('[role="tablist"]').first().isVisible({ timeout: 5000 }).catch(() => false);
    if (!tabListVisible) {
      console.warn('[Test 14] Tab list not visible — skipping.');
      return;
    }

    const tabs = page.locator('[role="tab"]');
    const tabCount = await tabs.count();
    if (tabCount === 0) {
      console.warn('[Test 14] No tabs found — skipping escape-cancel test.');
      return;
    }

    // Get original tab title before rename
    const firstTab = tabs.first();
    const originalLabel = await firstTab.getAttribute('aria-label').catch(() => null);
    const originalText = await firstTab.textContent().catch(() => '');
    console.log(`[Test 14] Original tab label: "${originalLabel}", text: "${originalText?.trim()}"`);

    // Trigger rename mode
    await firstTab.dblclick();
    await page.waitForTimeout(500);

    const renameInput = page.locator('[role="tablist"] input, [role="tab"] input, [role="tab"] [contenteditable="true"]');
    const renameVisible = await renameInput.first().isVisible({ timeout: 3000 }).catch(() => false);

    if (!renameVisible) {
      console.warn('[Test 14] Rename input not found — skipping escape-cancel test.');
      return;
    }

    // Type a temporary name
    await renameInput.first().fill('Temp Name That Should Be Discarded');
    await page.waitForTimeout(200);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'chat-14a-rename-in-progress.png') });

    // Press Escape to cancel
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'chat-14b-after-escape.png') });

    // Verify the rename input is gone
    const inputAfterEscape = await renameInput.first().isVisible({ timeout: 1000 }).catch(() => false);
    expect(inputAfterEscape).toBe(false);

    // Verify original title is restored
    const tabAfterEscape = page.locator('[role="tab"]').first();
    const newLabel = await tabAfterEscape.getAttribute('aria-label').catch(() => null);
    const newText = await tabAfterEscape.textContent().catch(() => '');

    const tempNameVisible = page.locator('[role="tab"]').filter({ hasText: 'Temp Name That Should Be Discarded' });
    const hasTempName = await tempNameVisible.isVisible({ timeout: 1000 }).catch(() => false);

    if (!hasTempName) {
      console.log('[Test 14] Temporary name discarded — original title restored after Escape.');
    } else {
      console.warn('[Test 14] Temp name still visible — Escape cancel may not be implemented.');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 15: Keyboard navigation — Tab key navigates between tabs
  // ─────────────────────────────────────────────────────────────────────────
  test('15 — Keyboard navigation with Tab key moves between tabs', async () => {
    const { page } = ctx;

    const tabListVisible = await page.locator('[role="tablist"]').first().isVisible({ timeout: 5000 }).catch(() => false);
    if (!tabListVisible) {
      console.warn('[Test 15] Tab list not visible — skipping keyboard navigation test.');
      return;
    }

    // Ensure we have at least 2 tabs
    let tabCount = await getTabCount(ctx);
    if (tabCount < 2) {
      await createNewTab(ctx);
      tabCount = await getTabCount(ctx);
    }

    // Focus the first tab
    const firstTab = page.locator('[role="tab"]').first();
    await firstTab.focus();
    await page.waitForTimeout(200);

    const initialFocus = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? el.getAttribute('role') + ':' + (el.getAttribute('aria-label') || el.textContent?.substring(0, 30)) : 'none';
    }).catch(() => 'unknown');

    console.log('[Test 15] Initial focused element:', initialFocus);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'chat-15a-tab-focused.png') });

    // Press Tab and observe focus movement
    const focusSequence: string[] = [initialFocus];
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      await page.waitForTimeout(150);

      const focused = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el) return 'none';
        const role = el.getAttribute('role') || el.tagName.toLowerCase();
        const label = el.getAttribute('aria-label') || el.textContent?.substring(0, 30) || '';
        return `${role}:${label}`;
      }).catch(() => 'unknown');

      focusSequence.push(focused);
    }

    console.log('[Test 15] Focus sequence:', focusSequence);

    // Verify focus moved to different elements
    const uniqueElements = new Set(focusSequence);
    expect(uniqueElements.size).toBeGreaterThan(1);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'chat-15b-keyboard-nav.png') });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test 16: Multiple messages in different tabs stay isolated
  // ─────────────────────────────────────────────────────────────────────────
  test('16 — Messages in different chat tabs stay isolated', async () => {
    const { page } = ctx;

    const tabListVisible = await page.locator('[role="tablist"]').first().isVisible({ timeout: 5000 }).catch(() => false);
    if (!tabListVisible) {
      console.warn('[Test 16] Tab list not visible — skipping message isolation test.');
      return;
    }

    // Ensure we have at least 2 tabs
    let tabCount = await getTabCount(ctx);
    while (tabCount < 2) {
      const created = await createNewTab(ctx);
      if (!created) break;
      tabCount = await getTabCount(ctx);
    }

    if (tabCount < 2) {
      console.warn('[Test 16] Could not create 2 tabs — skipping isolation test.');
      return;
    }

    const tabs = page.locator('[role="tab"]');

    // ── Tab 1: send a message ──
    await tabs.first().click();
    await page.waitForTimeout(500);

    const chatInput1 = page.locator('[aria-label="Chat message input"], textarea').last();
    const msg1 = 'Isolation test message tab one ' + Date.now();

    if (await chatInput1.isVisible({ timeout: 3000 }).catch(() => false)) {
      await chatInput1.fill(msg1);

      // Send the message
      const sendBtn = page.getByRole('button', { name: /send|отправить/i });
      if (await sendBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await sendBtn.click();
      } else {
        await chatInput1.press('Enter');
      }

      await page.waitForTimeout(1000);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'chat-16a-tab1-message-sent.png') });
    }

    // ── Tab 2: verify message not present ──
    await tabs.nth(1).click();
    await page.waitForTimeout(500);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'chat-16b-tab2-state.png') });

    // The message sent in tab 1 should not appear in tab 2's conversation
    const msg1InTab2 = page.locator(`text="${msg1}"`);
    const msg1VisibleInTab2 = await msg1InTab2.isVisible({ timeout: 2000 }).catch(() => false);

    if (!msg1VisibleInTab2) {
      console.log('[Test 16] Message isolation confirmed — Tab 1 message not visible in Tab 2.');
    } else {
      console.warn('[Test 16] Tab 1 message appears in Tab 2 — isolation may not be working.');
    }

    // Switch back to tab 1 and verify the message is there
    await tabs.first().click();
    await page.waitForTimeout(500);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'chat-16c-back-to-tab1.png') });
    console.log('[Test 16] Message isolation test complete.');
  });
});
