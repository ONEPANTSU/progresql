import { userKey } from './userStorage';

// Backend URL stays GLOBAL — needed before login for auth API requests.
const STORAGE_KEY_BACKEND_URL = 'progresql-agent-backend-url';

// Model and safe mode are per-user preferences.
function modelKey(): string {
  return userKey('agent-model');
}

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

export function loadSafeMode(): boolean {
  const val = getItem(safeModeKey());
  // Default to true (safe mode ON) when not explicitly set.
  return val !== 'false';
}

export function saveSafeMode(enabled: boolean): void {
  setItem(safeModeKey(), enabled ? 'true' : 'false');
}
