import { _electron as electron, ElectronApplication, Page } from 'playwright';
import path from 'path';

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
  const registerBtn = page.getByRole('button', { name: /register|sign up/i });
  if (await registerBtn.isEnabled({ timeout: 5000 }).catch(() => false)) {
    await registerBtn.click();
  }

  // Wait for redirect to main page
  await page.waitForURL('**/', { timeout: 10_000 }).catch(() => {/* may stay on same page on error */});
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
