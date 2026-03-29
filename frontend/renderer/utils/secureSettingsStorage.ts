import { userKey } from './userStorage';

// Backend URL stays GLOBAL — needed before login for auth API requests.
const STORAGE_KEY_BACKEND_URL = 'progresql-agent-backend-url';

// Security mode values
export type SecurityMode = 'safe' | 'data' | 'execute';

// Model and security mode are per-user preferences.
function modelKey(): string {
  return userKey('agent-model');
}

function securityModeKey(): string {
  return userKey('agent-security-mode');
}

// Legacy key for migration
function safeModeKey(): string {
  return userKey('agent-safe-mode');
}

function getItem(key: string): string {
  if (typeof window !== 'undefined' && window.localStorage) {
    return localStorage.getItem(key) || '';
  }
  return '';
}

function setItem(key: string, value: string): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    localStorage.setItem(key, value);
  }
}

// ── Public API ──

export function loadBackendUrl(defaultUrl: string): string {
  // E2E test override via injected global (set by Playwright addInitScript)
  if (typeof window !== 'undefined' && (window as any).__E2E_BACKEND_URL__) {
    return (window as any).__E2E_BACKEND_URL__;
  }
  // Clear any stale localhost URL from previous dev sessions
  const saved = getItem(STORAGE_KEY_BACKEND_URL);
  if (saved && saved.includes('localhost')) {
    if (typeof window !== 'undefined' && window.localStorage) {
      localStorage.removeItem(STORAGE_KEY_BACKEND_URL);
    }
    return defaultUrl;
  }
  return saved || defaultUrl;
}

export function saveBackendUrl(url: string): void {
  setItem(STORAGE_KEY_BACKEND_URL, url);
}

export function loadModel(): string {
  return getItem(modelKey()) || 'qwen/qwen3-coder';
}

export function saveModel(model: string): void {
  setItem(modelKey(), model);
}

export function loadSecurityMode(): SecurityMode {
  const val = getItem(securityModeKey());
  if (val === 'safe' || val === 'data' || val === 'execute') {
    return val;
  }
  // Migrate from old boolean safe_mode
  const oldVal = getItem(safeModeKey());
  if (oldVal === 'false') {
    return 'execute';
  }
  return 'safe'; // Default
}

export function saveSecurityMode(mode: SecurityMode): void {
  setItem(securityModeKey(), mode);
}

// Backward compatibility — kept for old code that may still reference these
export function loadSafeMode(): boolean {
  return loadSecurityMode() === 'safe';
}

export function saveSafeMode(enabled: boolean): void {
  saveSecurityMode(enabled ? 'safe' : 'execute');
}
