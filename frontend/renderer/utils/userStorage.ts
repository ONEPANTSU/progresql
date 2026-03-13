/**
 * User-scoped localStorage utility.
 *
 * All per-user data (connections, chats, settings, etc.) is stored under
 * keys namespaced by the current user's ID, preventing data leakage
 * between different accounts on the same machine.
 *
 * Keys that remain GLOBAL (not scoped):
 *  - progresql-auth-token       (needed before login)
 *  - progresql-current-user     (needed before login)
 *  - progresql-agent-backend-url (needed for auth requests)
 *  - theme-mode                 (UI preference, not sensitive)
 */

const CURRENT_USER_KEY = 'progresql-current-user';

/**
 * Get the current user's ID from localStorage.
 * Returns null if no user is logged in.
 */
export function getCurrentUserId(): string | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const raw = localStorage.getItem(CURRENT_USER_KEY);
    if (!raw) return null;
    const user = JSON.parse(raw);
    return user?.id || null;
  } catch {
    return null;
  }
}

/**
 * Build a user-scoped localStorage key.
 * Returns `progresql-{userId}-{suffix}` when a user is logged in.
 * Falls back to `progresql-{suffix}` when no user is available.
 *
 * IMPORTANT: Call this at access time, not at module load time,
 * because the user ID may not be available yet during import.
 */
export function userKey(suffix: string): string {
  const userId = getCurrentUserId();
  if (userId) {
    return `progresql-${userId}-${suffix}`;
  }
  return `progresql-${suffix}`;
}

/**
 * Migrate legacy global localStorage keys to user-scoped keys.
 * Should be called once after login/registration when user ID is available.
 * Idempotent — skips if already migrated for this user.
 */
export function migrateToUserStorage(): void {
  const userId = getCurrentUserId();
  if (!userId) return;

  const migratedFlag = `progresql-migrated-${userId}`;
  if (typeof window === 'undefined' || !window.localStorage) return;
  if (localStorage.getItem(migratedFlag)) return;

  // NOTE: Do NOT migrate 'connections' — each user should set up their own DB connections.
  // Only migrate UI preferences that are safe to share.
  const keysToMigrate: [string, string][] = [
    ['progresql-agent-model', 'agent-model'],
    ['progresql-agent-safe-mode', 'agent-safe-mode'],
  ];

  for (const [oldKey, suffix] of keysToMigrate) {
    const value = localStorage.getItem(oldKey);
    if (value !== null) {
      const newKey = `progresql-${userId}-${suffix}`;
      if (localStorage.getItem(newKey) === null) {
        localStorage.setItem(newKey, value);
      }
    }
  }

  localStorage.setItem(migratedFlag, 'true');
}
