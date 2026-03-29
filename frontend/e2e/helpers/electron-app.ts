import { _electron as electron, ElectronApplication, Page } from 'playwright';
import path from 'path';
import { execSync } from 'child_process';

/** Directly mark user as email-verified in the test database (bypasses SMTP). */
function verifyEmailInDB(email: string): void {
  const dbUrl = process.env.E2E_DATABASE_URL ||
    'postgres://progressql:progressql@127.0.0.1:5435/progressql';
  try {
    execSync(
      `psql "${dbUrl}" -c "UPDATE users SET email_verified = TRUE WHERE email = '${email}'"`,
      { stdio: 'ignore' },
    );
  } catch {
    // psql not available or DB not running — skip silently
  }
}

export interface AppContext {
  app: ElectronApplication;
  page: Page;
}

/**
 * Launches the Electron app for E2E testing.
 *
 * Expects the Next.js renderer to be pre-built (`npm run build`)
 * so that `main.js` can load `renderer/index.html` in production mode.
 *
 * Set PROGRESQL_E2E_DEV=1 to launch against the dev server instead
 * (requires `npm run dev` running separately).
 */
export async function launchApp(): Promise<AppContext> {
  const rootDir = path.resolve(__dirname, '../..');

  const app = await electron.launch({
    args: [path.join(rootDir, 'main.js')],
    cwd: rootDir,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ELECTRON_IS_DEV: process.env.PROGRESQL_E2E_DEV === '1' ? '1' : '0',
      PLAYWRIGHT_TEST: '1',
    },
  });

  // The first window is the main window
  const page = await app.firstWindow();

  await page.waitForLoadState('domcontentloaded');

  // Inject E2E backend URL into the page context.
  // evaluate() sets it NOW; addInitScript ensures it survives full page reloads (F5).
  const e2eBackendUrl = process.env.E2E_BACKEND_URL;
  if (e2eBackendUrl) {
    await page.evaluate((url: string) => {
      (window as any).__E2E_BACKEND_URL__ = url;
    }, e2eBackendUrl);
    await page.addInitScript((url: string) => {
      (window as any).__E2E_BACKEND_URL__ = url;
    }, e2eBackendUrl);
  }

  // Close DevTools if it was auto-opened in dev mode (isDev = !app.isPackaged)
  await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && win.webContents.isDevToolsOpened()) {
      win.webContents.closeDevTools();
    }
  }).catch(() => {/* ignore if DevTools not open */});

  // Wait a bit for the renderer to settle after DevTools close
  await page.waitForTimeout(500);

  return { app, page };
}

/**
 * Registers a test user and logs in via the UI.
 * On re-runs with duplicate email, falls back to login (after DB-verifying if needed).
 */
export async function registerAndLogin(
  page: Page,
  user: { name: string; email: string; password: string },
): Promise<void> {
  // Navigate to register page only if not already there
  const currentUrl = page.url();
  if (!currentUrl.includes('register')) {
    const registerLink = page.getByRole('link', { name: /register|sign up/i });
    if (await registerLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await registerLink.click();
      await page.waitForURL('**/register', { timeout: 10_000 }).catch(() => {});
    }
  }

  // Fill registration form — labels may be "Name", "Email", "Password"
  const nameField = page.getByLabel(/name|имя/i).first();
  if (await nameField.isVisible({ timeout: 3000 }).catch(() => false)) {
    await nameField.fill(user.name);
  }
  await page.getByLabel(/email/i).first().fill(user.email);

  // Fill all password fields (password + confirm password)
  const passwordFields = page.locator('input[type="password"]');
  const count = await passwordFields.count();
  for (let i = 0; i < count; i++) {
    await passwordFields.nth(i).fill(user.password);
  }

  // Check Terms of Use checkbox if present (required to enable Register button)
  const termsCheckbox = page.locator('input[type="checkbox"]').first();
  if (await termsCheckbox.isVisible({ timeout: 1000 }).catch(() => false)) {
    const isChecked = await termsCheckbox.isChecked().catch(() => false);
    if (!isChecked) {
      await termsCheckbox.click({ force: true });
    }
  }

  const registerBtn = page.getByRole('button', { name: /register|sign up/i });
  if (await registerBtn.isEnabled({ timeout: 5000 }).catch(() => false)) {
    await registerBtn.click();
  }

  // Wait for registration to complete: either navigate to verify-email, main page, or show error
  // Use a longer timeout to avoid race conditions with the registration API response
  await page.waitForURL((url: URL) => !url.pathname.includes('/register'), { timeout: 15_000 })
    .catch(() => {}); // if still on register after 15s, there was an error

  // Handle email verification page (first-time registration with real backend)
  if (page.url().includes('verify-email')) {
    // User was created — mark as verified in DB, then log in
    verifyEmailInDB(user.email);
    const logoutBtn = page.getByRole('button', { name: /log out|logout|выйти/i });
    if (await logoutBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await logoutBtn.click();
      await page.waitForURL('**/login', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(500);
    }
    await loginWithCredentials(page, user.email, user.password);
    return;
  }

  // If still on register page (duplicate email or other error), fall back to login
  if (page.url().includes('register')) {
    verifyEmailInDB(user.email); // user may exist but unverified from a previous run
    const signInLink = page.getByRole('link', { name: /sign in|login/i });
    if (await signInLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      await signInLink.click();
      await page.waitForURL('**/login', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(500);
    }
    await loginWithCredentials(page, user.email, user.password);
    return;
  }

  // Standard success — redirected to main page already
  await page.waitForURL('**/', { timeout: 5000 }).catch(() => {});
}

/** Helper: fill email + password on the login page and click Sign In. */
async function loginWithCredentials(page: Page, email: string, password: string): Promise<void> {
  const emailField = page.locator('input[type="email"], input[id*="email"], input[name*="email"]').first();
  const emailFallback = page.getByLabel(/email/i).first();
  const ef = await emailField.isVisible({ timeout: 2000 }).catch(() => false) ? emailField : emailFallback;
  await ef.fill(email);

  const passField = page.locator('input[type="password"]').first();
  if (await passField.isVisible({ timeout: 2000 }).catch(() => false)) {
    await passField.fill(password);
  }
  const loginBtn = page.getByRole('button', { name: /sign in|login|войти/i });
  if (await loginBtn.isEnabled({ timeout: 3000 }).catch(() => false)) {
    await loginBtn.click();
  }
  await page.waitForURL('**/', { timeout: 10_000 }).catch(() => {});
}

/**
 * Connects to the test PostgreSQL database via the UI.
 * Expects Docker Compose `postgres-test` to be running on port 5433.
 */
export async function connectToTestDB(page: Page): Promise<void> {
  // The main page should show a connection dialog or button.
  // Fill the connection form fields.
  // DB config matches docker-compose.yml: postgres-test on 5433
  const dbConfig = {
    host: 'localhost',
    port: '5433',
    user: 'progressql',
    password: 'progressql',
    database: 'progressql_test',
  };

  // Look for "Add connection" or similar button
  const addBtn = page.getByRole('button', { name: /добавить|add|connect|подключ/i });
  if (await addBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await addBtn.click();
  }

  // Fill connection fields (labels may be in Russian or English)
  const hostField = page.getByLabel(/host/i);
  if (await hostField.isVisible({ timeout: 3000 }).catch(() => false)) {
    await hostField.fill(dbConfig.host);
  }

  const portField = page.getByLabel(/port/i);
  if (await portField.isVisible({ timeout: 1000 }).catch(() => false)) {
    await portField.fill(dbConfig.port);
  }

  const userField = page.getByLabel(/user|пользователь/i);
  if (await userField.isVisible({ timeout: 1000 }).catch(() => false)) {
    await userField.fill(dbConfig.user);
  }

  const passField = page.getByLabel(/password|пароль/i);
  if (await passField.isVisible({ timeout: 1000 }).catch(() => false)) {
    await passField.fill(dbConfig.password);
  }

  const dbField = page.getByLabel(/database|база/i);
  if (await dbField.isVisible({ timeout: 1000 }).catch(() => false)) {
    await dbField.fill(dbConfig.database);
  }

  // Click connect/save
  const connectBtn = page.getByRole('button', { name: /connect|подключить|сохранить|save/i });
  if (await connectBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await connectBtn.click();
  }
}

/**
 * Closes the Electron app gracefully.
 */
export async function closeApp(app: ElectronApplication): Promise<void> {
  await app.close();
}
