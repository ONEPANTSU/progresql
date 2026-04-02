import { DatabaseServer } from '@/shared/types';
import { createLogger } from '@/shared/lib/logger';
import { userKey } from '@/shared/lib/userStorage';

const log = createLogger('ConnectionStorage');

const ENCRYPTED_PREFIX = 'enc:';

function connectionsKey(): string {
  return userKey('connections');
}

function isEncryptedPassword(password: string): boolean {
  return password.startsWith(ENCRYPTED_PREFIX);
}

/**
 * Encrypt a single password via Electron safeStorage IPC.
 * Returns "enc:<base64>" on success, or plaintext if encryption is unavailable.
 */
async function encryptPassword(plaintext: string): Promise<string> {
  if (!plaintext || isEncryptedPassword(plaintext)) {
    return plaintext;
  }
  try {
    if (typeof window !== 'undefined' && window.electronAPI?.encryptPassword) {
      const result = await window.electronAPI.encryptPassword(plaintext);
      if (result.encrypted) {
        return ENCRYPTED_PREFIX + result.data;
      }
    }
  } catch (error) {
    log.error('Failed to encrypt password:', error);
  }
  return plaintext;
}

/**
 * Decrypt a single password via Electron safeStorage IPC.
 * If the password doesn't have the "enc:" prefix, returns it as-is (plaintext migration).
 */
async function decryptPassword(stored: string): Promise<string> {
  if (!stored || !isEncryptedPassword(stored)) {
    return stored;
  }
  try {
    if (typeof window !== 'undefined' && window.electronAPI?.decryptPassword) {
      const encryptedBase64 = stored.slice(ENCRYPTED_PREFIX.length);
      const decrypted = await window.electronAPI.decryptPassword(encryptedBase64);
      // If decryption returned the raw base64 (failure fallback), treat as empty
      if (decrypted === encryptedBase64) {
        log.warn('Password decryption returned raw data — clearing stored password');
        return '';
      }
      return decrypted;
    }
  } catch (error) {
    log.error('Failed to decrypt password:', error);
  }
  // If decryption failed completely, return empty so user is prompted to re-enter
  return '';
}

/**
 * Load all connections from localStorage, decrypting passwords.
 */
export async function loadConnections(): Promise<DatabaseServer[]> {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return [];
    }

    const saved = localStorage.getItem(connectionsKey());
    if (!saved) {
      return [];
    }

    const connections: DatabaseServer[] = JSON.parse(saved);
    let needsResave = false;

    for (const conn of connections) {
      if (conn.password && isEncryptedPassword(conn.password)) {
        conn.password = await decryptPassword(conn.password);
      } else if (conn.password) {
        // Plaintext password found — will be encrypted on next save (migration)
        needsResave = true;
      }
    }

    // Auto-migrate: re-save with encrypted passwords if any were plaintext
    if (needsResave) {
      log.debug('Migrating plaintext passwords to encrypted storage');
      await saveConnections(connections);
    }

    return connections;
  } catch (error) {
    log.error('Failed to load connections:', error);
    return [];
  }
}

/**
 * Save all connections to localStorage, encrypting passwords.
 */
export async function saveConnections(connections: DatabaseServer[]): Promise<void> {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return;
    }

    // Clone to avoid mutating the in-memory objects
    const toStore = JSON.parse(JSON.stringify(connections)) as DatabaseServer[];

    for (const conn of toStore) {
      if (conn.password && !isEncryptedPassword(conn.password)) {
        conn.password = await encryptPassword(conn.password);
      }
    }

    localStorage.setItem(connectionsKey(), JSON.stringify(toStore));
  } catch (error) {
    log.error('Failed to save connections:', error);
  }
}

/**
 * Debug function to inspect localStorage
 */
export function debugLocalStorage(): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    log.debug('localStorage not available (server-side rendering)');
    return;
  }

  log.debug('localStorage keys:', Object.keys(localStorage));
  log.debug('Our key exists:', localStorage.getItem(connectionsKey()) !== null);
  const raw = localStorage.getItem(connectionsKey());
  if (raw) {
    const parsed = JSON.parse(raw);
    const sanitized = parsed.map((c: any) => ({
      ...c,
      password: c.password ? (isEncryptedPassword(c.password) ? '[ENCRYPTED]' : '[PLAINTEXT]') : '[EMPTY]'
    }));
    log.debug('Connections (passwords masked):', JSON.stringify(sanitized, null, 2));
  }
}
