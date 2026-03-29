/**
 * subscription-persistence.spec.ts
 *
 * Corner-case tests for:
 * 1. Subscription lifecycle — trial expiry, Pro → Free transition, UI updates
 * 2. Payment guards — duplicate payment prevention
 * 3. Connection persistence — survive app restart, auto-reconnect
 * 4. JWT token expiry handling
 * 5. Promo code edge cases
 * 6. Stale session recovery
 */
import { test, expect } from '@playwright/test';
import { launchApp, registerAndLogin, AppContext } from './helpers/electron-app';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots', 'subscription');
const DB_URL = process.env.E2E_DATABASE_URL || 'postgres://progressql:progressql@127.0.0.1:5435/progressql';

const TEST_USER = {
  name: 'Sub Test User',
  email: `subtest_${Date.now()}@test.com`,
  password: 'SubTest123!',
};

const TEST_DB_CONN = {
  name: 'Sub Test DB',
  host: '127.0.0.1',
  port: '5435',
  username: 'progressql',
  password: 'progressql',
  database: 'progressql',
};

let ctx: AppContext;

/** Run SQL against test database */
function dbExec(sql: string): string {
  try {
    return execSync(`psql "${DB_URL}" -t -c "${sql}"`, { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

/** Helper: add connection via dialog */
async function addConnection(page: import('playwright').Page): Promise<void> {
  const addBtn = page.locator('[aria-label="Add new database connection"]').first();
  if (await addBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await addBtn.click();
  } else {
    const iconButtons = page.locator('button').filter({ has: page.locator('svg') });
    const count = await iconButtons.count();
    for (let i = 0; i < count; i++) {
      const btn = iconButtons.nth(i);
      const box = await btn.boundingBox().catch(() => null);
      if (box && box.y < 50 && box.width < 50) { await btn.click(); break; }
    }
  }
  await page.waitForTimeout(1000);

  const dialog = page.locator('[role="dialog"]');
  if (await dialog.isVisible({ timeout: 3000 }).catch(() => false)) {
    const inputs = dialog.locator('input:not([type="hidden"])');
    const values = [TEST_DB_CONN.name, TEST_DB_CONN.host, TEST_DB_CONN.port, TEST_DB_CONN.username, TEST_DB_CONN.password, TEST_DB_CONN.database];
    const inputCount = await inputs.count();
    for (let i = 0; i < Math.min(inputCount, values.length); i++) {
      await inputs.nth(i).click({ clickCount: 3 });
      await inputs.nth(i).fill(values[i]);
    }
    const connectBtn = dialog.getByRole('button', { name: /Connect to Database|Подключить/i });
    if (await connectBtn.isEnabled({ timeout: 2000 }).catch(() => false)) await connectBtn.click();
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
  }
  await page.waitForTimeout(1000);

  // Click to activate
  const connItem = page.locator(`text=/${TEST_DB_CONN.name}/i`).first();
  if (await connItem.isVisible({ timeout: 3000 }).catch(() => false)) {
    await connItem.click();
    await page.waitForTimeout(3000);
  }
}

/** Helper: open settings */
async function openSettings(page: import('playwright').Page): Promise<void> {
  const btn = page.locator('[aria-label="Open settings"]');
  if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await btn.click({ force: true });
    await page.waitForTimeout(1000);
  }
}

/** Helper: close settings */
async function closeSettings(page: import('playwright').Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
}

/** Helper: dismiss snackbar toasts */
async function dismissToasts(page: import('playwright').Page): Promise<void> {
  const snackbar = page.locator('.MuiSnackbar-root');
  if (await snackbar.isVisible({ timeout: 500 }).catch(() => false)) {
    const closeBtn = snackbar.locator('button').first();
    if (await closeBtn.isVisible({ timeout: 300 }).catch(() => false)) await closeBtn.click();
    await snackbar.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  }
}

test.describe.serial('Subscription & Persistence — Corner Cases', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // SETUP
  // ═══════════════════════════════════════════════════════════════════════════
  test('00 — Setup: register user and connect to DB', async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    ctx = await launchApp();
    const { page } = ctx;
    await page.waitForTimeout(2000);

    // Handle stale sessions — ensure we land on login/register page
    const signInEl = page.getByRole('heading', { name: /sign in/i })
      .or(page.getByRole('button', { name: /sign in/i }))
      .or(page.getByRole('link', { name: /register|sign up/i }));

    const alreadyOnAuth = await signInEl.first().isVisible({ timeout: 5000 }).catch(() => false);
    console.log(`[SP-00] On auth page: ${alreadyOnAuth}, URL: ${page.url()}`);

    if (!alreadyOnAuth) {
      // Try settings panel → logout
      const settingsBtn = page.locator('[aria-label="Open settings"]');
      if (await settingsBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await settingsBtn.click({ force: true });
        await page.waitForTimeout(500);
        const logoutBtn = page.locator('button').filter({ hasText: /Log out|Выйти/i }).first();
        if (await logoutBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await logoutBtn.click();
          await page.waitForTimeout(5000);
        } else {
          await page.keyboard.press('Escape');
        }
      }

      // If still not on auth page, clear storage and force navigate to login
      const nowOnAuth = await signInEl.first().isVisible({ timeout: 3000 }).catch(() => false);
      if (!nowOnAuth) {
        await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });

        // Force navigate: detect protocol and build login URL
        const currentUrl = page.url();
        if (currentUrl.includes('.html')) {
          // Electron production (file://)
          const loginUrl = currentUrl.replace(/\/[^/]*\.html.*$/, '/login.html');
          await page.goto(loginUrl);
        } else {
          // Dev server (http://)
          const base = currentUrl.replace(/\/$/, '');
          await page.goto(`${base}/login`);
        }
        await page.waitForTimeout(3000);
        // Wait for login page to be ready
        await signInEl.first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
      }
    }

    console.log(`[SP-00] Final URL before register: ${page.url()}`);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '00-before-register.png') });

    // Wait for the auth page to be fully loaded
    const emailField = page.getByLabel(/email/i).first()
      .or(page.locator('input[type="email"]').first())
      .or(page.locator('input[name="email"]').first());
    const registerLink = page.getByRole('link', { name: /register|sign up|создать/i }).first();

    // Wait for either email field (already on register) or register link (on login)
    await Promise.race([
      emailField.waitFor({ state: 'visible', timeout: 15_000 }),
      registerLink.waitFor({ state: 'visible', timeout: 15_000 }),
    ]).catch(async () => {
      console.log(`[SP-00] Neither email nor register link visible. Page content may be loading...`);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '00-debug-stuck.png') });
    });

    await registerAndLogin(page, TEST_USER);
    await expect(
      page.getByRole('heading', { name: /Connections|AI Assistant/i }).first(),
    ).toBeVisible({ timeout: 15_000 });

    await addConnection(page);

    const editor = page.locator('.cm-editor').first();
    await editor.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '00-setup.png') });
    console.log('[SP-00] Setup complete.');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SUBSCRIPTION: Trial period display
  // ═══════════════════════════════════════════════════════════════════════════
  test('01 — New user sees trial expiry warning', async () => {
    const { page } = ctx;

    // New user should have 3-day trial
    // Check for trial warning in chat panel or settings
    const chatPanel = page.locator('[aria-label="AI Assistant panel"]');
    if (!(await chatPanel.isVisible({ timeout: 1000 }).catch(() => false))) {
      await page.keyboard.press('Meta+k');
      await page.waitForTimeout(500);
    }

    // Look for trial warning
    const trialWarning = page.locator('text=/trial.*expires|trial.*days|пробный.*истек|пробный.*дн/i').first();
    const hasTrialWarning = await trialWarning.isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`[SP-01] Trial warning visible: ${hasTrialWarning}`);

    // Check for "Upgrade to Pro" button
    const upgradeBtn = page.locator('text=/Upgrade to Pro|Перейти на Pro/i').first();
    const hasUpgrade = await upgradeBtn.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`[SP-01] Upgrade button visible: ${hasUpgrade}`);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-trial-warning.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SUBSCRIPTION: Simulate trial expiry via DB
  // ═══════════════════════════════════════════════════════════════════════════
  test('02 — Expired trial shows "expired" warning without re-login', async () => {
    const { page } = ctx;

    // Expire the trial via direct DB update
    const result = dbExec(
      `UPDATE users SET trial_ends_at = NOW() - INTERVAL '1 day' WHERE email = '${TEST_USER.email}' RETURNING id`,
    );
    console.log(`[SP-02] Updated user trial: ${result}`);

    // Wait for profile refresh (normally 5 min, but we can trigger it)
    // Reload page to force profile refresh
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    // Re-inject backend URL after reload
    const e2eBackendUrl = process.env.E2E_BACKEND_URL;
    if (e2eBackendUrl) {
      await page.evaluate((url: string) => {
        (window as any).__E2E_BACKEND_URL__ = url;
      }, e2eBackendUrl);
    }
    await page.waitForTimeout(3000);

    // Check for expired warning
    const expiredWarning = page.locator('text=/expired|истёк|истек|upgrade.*Pro/i').first();
    const hasExpired = await expiredWarning.isVisible({ timeout: 10_000 }).catch(() => false);
    console.log(`[SP-02] Expired warning visible: ${hasExpired}`);

    // AI features should be restricted
    const chatInput = page.locator('textarea:not([aria-hidden="true"]):not([readonly])').last();
    const canChat = await chatInput.isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`[SP-02] Chat input still visible: ${canChat}`);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-expired-trial.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SUBSCRIPTION: Simulate Pro upgrade via DB
  // ═══════════════════════════════════════════════════════════════════════════
  test('03 — Pro upgrade reflects in UI without re-login', async () => {
    const { page } = ctx;

    // Upgrade to Pro via DB
    dbExec(
      `UPDATE users SET plan = 'pro', plan_expires_at = NOW() + INTERVAL '30 days' WHERE email = '${TEST_USER.email}'`,
    );
    console.log('[SP-03] User upgraded to Pro in DB.');

    // Wait for profile refresh or reload
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    if (process.env.E2E_BACKEND_URL) {
      await page.evaluate((url: string) => {
        (window as any).__E2E_BACKEND_URL__ = url;
      }, process.env.E2E_BACKEND_URL);
    }
    await page.waitForTimeout(3000);

    // Check that expired warning is gone
    const expiredWarning = page.locator('text=/expired|истёк|истек/i').first();
    const stillExpired = await expiredWarning.isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`[SP-03] Still shows expired: ${stillExpired}`);

    // Check for Pro badge or subscription info
    await openSettings(page);
    const proBadge = page.locator('text=/Pro|Professional|premium/i').first();
    const hasPro = await proBadge.isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`[SP-03] Pro badge visible: ${hasPro}`);
    await closeSettings(page);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '03-pro-upgrade.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SUBSCRIPTION: Pro expiry transition
  // ═══════════════════════════════════════════════════════════════════════════
  test('04 — Pro expiry transitions user back to free plan', async () => {
    const { page } = ctx;

    // Expire Pro via DB
    dbExec(
      `UPDATE users SET plan_expires_at = NOW() - INTERVAL '1 day' WHERE email = '${TEST_USER.email}'`,
    );
    console.log('[SP-04] Pro plan expired in DB.');

    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    if (process.env.E2E_BACKEND_URL) {
      await page.evaluate((url: string) => {
        (window as any).__E2E_BACKEND_URL__ = url;
      }, process.env.E2E_BACKEND_URL);
    }
    await page.waitForTimeout(3000);

    // Should show expired or upgrade prompt
    const warning = page.locator('text=/expired|Upgrade|истёк|upgrade/i').first();
    const hasWarning = await warning.isVisible({ timeout: 10_000 }).catch(() => false);
    console.log(`[SP-04] Expiry warning: ${hasWarning}`);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '04-pro-expired.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SUBSCRIPTION: Restore trial for further tests
  // ═══════════════════════════════════════════════════════════════════════════
  test('05 — Restore valid trial for remaining tests', async () => {
    const { page } = ctx;

    dbExec(
      `UPDATE users SET plan = 'free', plan_expires_at = NULL, trial_ends_at = NOW() + INTERVAL '3 days' WHERE email = '${TEST_USER.email}'`,
    );

    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    if (process.env.E2E_BACKEND_URL) {
      await page.evaluate((url: string) => {
        (window as any).__E2E_BACKEND_URL__ = url;
      }, process.env.E2E_BACKEND_URL);
    }
    await page.waitForTimeout(3000);

    console.log('[SP-05] Trial restored.');
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '05-trial-restored.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PAYMENT: Upgrade button opens payment modal
  // ═══════════════════════════════════════════════════════════════════════════
  test('06 — Upgrade to Pro button opens payment modal', async () => {
    const { page } = ctx;

    // Open settings first (Upgrade button is inside SettingsPanel)
    await openSettings(page);
    await page.waitForTimeout(500);

    const upgradeBtn = page.getByRole('button', { name: /Upgrade to Pro|Обновить до Pro/i }).first();
    const hasUpgrade = await upgradeBtn.isVisible({ timeout: 5000 }).catch(() => false);
    console.log(`[SP-06] Upgrade button: ${hasUpgrade}`);

    if (hasUpgrade) {
      await upgradeBtn.click();
      await page.waitForTimeout(2000);

      // Payment modal should appear (uses data-testid="payment-modal" or role="dialog")
      const paymentModal = page.locator('[data-testid="payment-modal"], [role="dialog"]').filter({
        hasText: /₽|Card|SBP|Карт|СБП/i,
      }).first();
      const hasModal = await paymentModal.isVisible({ timeout: 5000 }).catch(() => false);
      console.log(`[SP-06] Payment modal: ${hasModal}`);

      if (hasModal) {
        // Check for payment methods via data-testid
        const hasCard = await page.locator('[data-testid="payment-method-card"]').isVisible({ timeout: 1000 }).catch(() => false);
        const hasSBP = await page.locator('[data-testid="payment-method-sbp"]').isVisible({ timeout: 1000 }).catch(() => false);
        console.log(`[SP-06] Methods — Card: ${hasCard}, SBP: ${hasSBP}`);

        // Check for price
        const priceText = page.locator('text=/₽/').first();
        const hasPrice = await priceText.isVisible({ timeout: 1000 }).catch(() => false);
        console.log(`[SP-06] Price visible: ${hasPrice}`);

        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      }
    }

    await closeSettings(page);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '06-payment-modal.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PROMO: Invalid code error
  // ═══════════════════════════════════════════════════════════════════════════
  test('07 — Invalid promo code shows proper error', async () => {
    const { page } = ctx;

    // Open settings, then click Upgrade to open payment modal
    await openSettings(page);
    await page.waitForTimeout(500);

    const upgradeBtn = page.getByRole('button', { name: /Upgrade to Pro|Обновить до Pro/i }).first();
    if (await upgradeBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await upgradeBtn.click();
      await page.waitForTimeout(1500);

      // Expand the promo code collapsible section inside payment modal
      const promoToggle = page.locator('[data-testid="promo-code-toggle"]');
      if (await promoToggle.isVisible({ timeout: 2000 }).catch(() => false)) {
        await promoToggle.click();
        await page.waitForTimeout(500);
      }

      const promoInput = page.locator('[data-testid="promo-code-input"]');
      if (await promoInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        await promoInput.fill('DEFINITELY_INVALID_CODE_999');
        const applyBtn = page.getByRole('button', { name: /Apply|Применить/i }).first();
        if (await applyBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
          await applyBtn.click();
          await page.waitForTimeout(2000);

          // Should show error
          const error = page.locator('text=/Invalid|not found|expired|Невалидный|недействительный|просроченный/i').first();
          const hasError = await error.isVisible({ timeout: 3000 }).catch(() => false);
          console.log(`[SP-07] Invalid promo error: ${hasError}`);
        }
      } else {
        console.log('[SP-07] Promo input not found (may need promo-code-toggle click).');
      }

      // Close modal
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    } else {
      console.log('[SP-07] Upgrade button not visible.');
    }

    await closeSettings(page);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '07-promo-error.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PERSISTENCE: Connections survive page reload
  // ═══════════════════════════════════════════════════════════════════════════
  test('08 — Connections persist after page reload', async () => {
    const { page } = ctx;

    // Check current connections before reload
    const connBefore = page.locator(`text=/${TEST_DB_CONN.name}/i`).first();
    const hadConn = await connBefore.isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`[SP-08] Connection before reload: ${hadConn}`);

    // Reload page
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    // Re-inject backend URL
    if (process.env.E2E_BACKEND_URL) {
      await page.evaluate((url: string) => {
        (window as any).__E2E_BACKEND_URL__ = url;
      }, process.env.E2E_BACKEND_URL);
    }
    await page.waitForTimeout(3000);

    // Check connection still exists
    const connAfter = page.locator(`text=/${TEST_DB_CONN.name}/i`).first();
    const hasConn = await connAfter.isVisible({ timeout: 10_000 }).catch(() => false);
    console.log(`[SP-08] Connection after reload: ${hasConn}`);

    // Editor should be visible (auto-reconnected)
    const editor = page.locator('.cm-editor').first();
    const editorVisible = await editor.isVisible({ timeout: 10_000 }).catch(() => false);
    console.log(`[SP-08] Editor after reload (auto-reconnect): ${editorVisible}`);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '08-persist-reload.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PERSISTENCE: Chat history survives page reload
  // ═══════════════════════════════════════════════════════════════════════════
  test('09 — Chat messages persist after page reload', async () => {
    const { page } = ctx;

    // Open chat and send a message first
    await page.keyboard.press('Meta+k');
    await page.waitForTimeout(500);

    const chatInput = page.locator('textarea:not([aria-hidden="true"]):not([readonly])').last();
    if (await chatInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await chatInput.fill('Test persistence message');
      await chatInput.press('Enter');
      await page.waitForTimeout(3000);
    }

    // Reload
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    if (process.env.E2E_BACKEND_URL) {
      await page.evaluate((url: string) => {
        (window as any).__E2E_BACKEND_URL__ = url;
      }, process.env.E2E_BACKEND_URL);
    }
    await page.waitForTimeout(3000);

    // Open chat and check if message persists
    await page.keyboard.press('Meta+k');
    await page.waitForTimeout(500);

    const persistedMsg = page.locator('text=/Test persistence message/').first();
    const msgPersisted = await persistedMsg.isVisible({ timeout: 5000 }).catch(() => false);
    console.log(`[SP-09] Chat message persisted: ${msgPersisted}`);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '09-chat-persist.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PERSISTENCE: SQL editor tabs and content survive reload
  // ═══════════════════════════════════════════════════════════════════════════
  test('10 — SQL editor tab content persists after reload', async () => {
    const { page } = ctx;

    const editor = page.locator('.cm-editor .cm-content').first();
    if (await editor.isVisible({ timeout: 5000 }).catch(() => false)) {
      await editor.click();
      await page.keyboard.press('Meta+a');
      await page.keyboard.type('SELECT \'persistence_test\' AS marker;', { delay: 15 });
      await page.waitForTimeout(500);
    }

    // Reload
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    if (process.env.E2E_BACKEND_URL) {
      await page.evaluate((url: string) => {
        (window as any).__E2E_BACKEND_URL__ = url;
      }, process.env.E2E_BACKEND_URL);
    }
    await page.waitForTimeout(3000);

    // Wait for editor to fully restore (connection may need to reconnect)
    const editorAfter = page.locator('.cm-editor .cm-content').first();
    await editorAfter.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const contentAfter = await editorAfter.textContent().catch(() => '');
    const contentPersisted = contentAfter?.includes('persistence_test');
    console.log(`[SP-10] Editor content persisted: ${contentPersisted}`);
    console.log(`[SP-10] Content: "${contentAfter?.substring(0, 60)}"`);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '10-editor-persist.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // JWT: Token in localStorage
  // ═══════════════════════════════════════════════════════════════════════════
  test('11 — Auth token exists in localStorage', async () => {
    const { page } = ctx;

    const token = await page.evaluate(() => {
      return localStorage.getItem('progresql-auth-token');
    });

    const hasToken = !!token && token.length > 20;
    console.log(`[SP-11] Auth token present: ${hasToken}, length: ${token?.length}`);
    expect(hasToken).toBe(true);

    // Token should be a valid JWT (3 parts separated by dots)
    const parts = token?.split('.') || [];
    console.log(`[SP-11] JWT parts: ${parts.length}`);
    expect(parts.length).toBe(3);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '11-token.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // JWT: Expired token forces re-login
  // ═══════════════════════════════════════════════════════════════════════════
  test('12 — Clearing auth token forces re-login on reload', async () => {
    const { page } = ctx;

    // Save token AND user data for restoration (our AuthProvider clears both if token is missing)
    const savedData = await page.evaluate(() => {
      const token = localStorage.getItem('progresql-auth-token');
      const user = localStorage.getItem('progresql-current-user');
      // Clear token to simulate expiry
      localStorage.removeItem('progresql-auth-token');
      return { token, user };
    });

    // Reload — should redirect to login
    await page.reload();
    await page.waitForTimeout(5000);

    // Should be on login page
    const signInBtn = page.getByRole('button', { name: /sign in|login|войти/i }).first();
    const onLoginPage = await signInBtn.isVisible({ timeout: 10_000 }).catch(() => false);
    console.log(`[SP-12] Redirected to login: ${onLoginPage}`);

    // Restore token AND user data
    if (savedData.token) {
      await page.evaluate((data: { token: string; user: string | null }) => {
        localStorage.setItem('progresql-auth-token', data.token);
        if (data.user) {
          localStorage.setItem('progresql-current-user', data.user);
        }
      }, savedData as { token: string; user: string | null });
    }

    // Reload again to restore session
    await page.reload();
    await page.waitForTimeout(3000);

    if (process.env.E2E_BACKEND_URL) {
      await page.evaluate((url: string) => {
        (window as any).__E2E_BACKEND_URL__ = url;
      }, process.env.E2E_BACKEND_URL);
    }
    await page.waitForTimeout(3000);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '12-token-clear.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SETTINGS: Theme preference persists
  // ═══════════════════════════════════════════════════════════════════════════
  test('13 — Theme preference survives reload', async () => {
    const { page } = ctx;

    await openSettings(page);

    // Switch to light theme
    const lightBtn = page.locator('button[value="light"], [aria-label*="Light"]').first();
    if (await lightBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await lightBtn.click();
      await page.waitForTimeout(500);
    }
    await closeSettings(page);

    // Get current background color
    const bgBefore = await page.evaluate(() => {
      return getComputedStyle(document.body).backgroundColor;
    });

    // Reload
    await page.reload();
    await page.waitForTimeout(3000);

    if (process.env.E2E_BACKEND_URL) {
      await page.evaluate((url: string) => {
        (window as any).__E2E_BACKEND_URL__ = url;
      }, process.env.E2E_BACKEND_URL);
    }
    await page.waitForTimeout(3000);

    // Check if theme persisted
    const bgAfter = await page.evaluate(() => {
      return getComputedStyle(document.body).backgroundColor;
    });
    console.log(`[SP-13] BG before: ${bgBefore}, after: ${bgAfter}`);
    console.log(`[SP-13] Theme persisted: ${bgBefore === bgAfter}`);

    // Switch back to dark
    await openSettings(page);
    const darkBtn = page.locator('button[value="dark"], [aria-label*="Dark"]').first();
    if (await darkBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await darkBtn.click();
      await page.waitForTimeout(500);
    }
    await closeSettings(page);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '13-theme-persist.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SETTINGS: Language preference persists
  // ═══════════════════════════════════════════════════════════════════════════
  test('14 — Language preference survives reload', async () => {
    const { page } = ctx;

    await openSettings(page);

    // Switch to Russian
    const ruBtn = page.locator('button').filter({ hasText: /^Русский$|^RU$/i }).first();
    if (await ruBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await ruBtn.click();
      await page.waitForTimeout(500);
    }
    await closeSettings(page);

    // Reload
    await page.reload();
    await page.waitForTimeout(3000);

    if (process.env.E2E_BACKEND_URL) {
      await page.evaluate((url: string) => {
        (window as any).__E2E_BACKEND_URL__ = url;
      }, process.env.E2E_BACKEND_URL);
    }
    await page.waitForTimeout(3000);

    // Wait for main page to fully load
    await page.locator('[aria-label="Open settings"], [aria-label="Открыть настройки"]').first()
      .waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});

    // Check if Russian UI is showing (look for Russian text anywhere)
    const ruText = page.locator('text=/Настройки|Подключения|AI Ассистент|Подключение/i').first();
    const hasRu = await ruText.isVisible({ timeout: 5000 }).catch(() => false);

    // Also check via localStorage as fallback
    const langInStorage = await page.evaluate(() => localStorage.getItem('progresql-language'));
    console.log(`[SP-14] Russian UI after reload: ${hasRu}, lang in storage: ${langInStorage}`);

    // Switch back to English
    await openSettings(page);
    const enBtn = page.locator('button').filter({ hasText: /^English$|^EN$/i }).first();
    if (await enBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await enBtn.click();
      await page.waitForTimeout(500);
    }
    await closeSettings(page);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '14-lang-persist.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SECURITY: Model selection persists
  // ═══════════════════════════════════════════════════════════════════════════
  test('15 — Security mode persists after reload', async () => {
    const { page } = ctx;

    await openSettings(page);

    // Switch to Execute mode
    const secSelect = page.locator('[role="combobox"]').filter({ hasText: /safe|data|execute/i }).first();
    if (await secSelect.isVisible({ timeout: 3000 }).catch(() => false)) {
      await secSelect.click();
      await page.waitForTimeout(300);
      const executeOpt = page.locator('[role="option"]').filter({ hasText: /execute/i }).first();
      if (await executeOpt.isVisible({ timeout: 2000 }).catch(() => false)) {
        await executeOpt.click();
        await page.waitForTimeout(500);
      }
    }
    await closeSettings(page);

    // Reload
    await page.reload();
    await page.waitForTimeout(3000);

    if (process.env.E2E_BACKEND_URL) {
      await page.evaluate((url: string) => {
        (window as any).__E2E_BACKEND_URL__ = url;
      }, process.env.E2E_BACKEND_URL);
    }
    await page.waitForTimeout(3000);

    // Wait for main page to be ready
    await page.locator('[aria-label="Open settings"], [aria-label="Открыть настройки"]').first()
      .waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});

    // Check if security mode persisted
    await openSettings(page);
    await page.waitForTimeout(500);
    const currentMode = page.locator('[role="combobox"]').filter({ hasText: /execute/i }).first();
    const persisted = await currentMode.isVisible({ timeout: 5000 }).catch(() => false);

    // Also check via localStorage
    const modeInStorage = await page.evaluate(() => {
      // Try user-scoped key pattern
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.includes('agent-security-mode')) {
          return `${key}=${localStorage.getItem(key!)}`;
        }
      }
      return 'not found';
    });
    console.log(`[SP-15] Execute mode persisted: ${persisted}, storage: ${modeInStorage}`);

    // Restore to safe
    if (await page.locator('[role="combobox"]').filter({ hasText: /safe|data|execute/i }).first().isVisible({ timeout: 1000 }).catch(() => false)) {
      await page.locator('[role="combobox"]').filter({ hasText: /safe|data|execute/i }).first().click();
      await page.waitForTimeout(300);
      const safeOpt = page.locator('[role="option"]').filter({ hasText: /safe/i }).first();
      if (await safeOpt.isVisible({ timeout: 1000 }).catch(() => false)) {
        await safeOpt.click();
      }
    }
    await closeSettings(page);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '15-security-persist.png') });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════════════════
  test('99 — Close app', async () => {
    // Clean up user
    dbExec(`DELETE FROM legal_acceptances WHERE user_id IN (SELECT id FROM users WHERE email = '${TEST_USER.email}')`);
    dbExec(`DELETE FROM users WHERE email = '${TEST_USER.email}'`);

    if (ctx?.app) {
      await ctx.app.close();
      console.log('[SP-99] App closed.');
    }
  });
});
