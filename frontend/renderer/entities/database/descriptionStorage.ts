import { userKey } from '@/shared/lib/userStorage';

function descriptionsKey(): string {
  return userKey('user-descriptions');
}

export interface UserDescription {
  objectType: string;
  schema: string;
  name: string;
  description: string;
}

function buildKey(objectType: string, schema: string, name: string): string {
  return `${objectType}:${schema}.${name}`;
}

function loadAll(): Record<string, string> {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return {};
    const raw = localStorage.getItem(descriptionsKey());
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveAll(data: Record<string, string>): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    localStorage.setItem(descriptionsKey(), JSON.stringify(data));
  } catch {
    // ignore
  }
}

export function getDescription(objectType: string, schema: string, name: string): string {
  const key = buildKey(objectType, schema, name);
  return loadAll()[key] || '';
}

export function setDescription(objectType: string, schema: string, name: string, description: string): void {
  const all = loadAll();
  const key = buildKey(objectType, schema, name);
  if (description.trim()) {
    all[key] = description.trim();
  } else {
    delete all[key];
  }
  saveAll(all);
}

export function getAllDescriptions(): Record<string, string> {
  return loadAll();
}

export function getDescriptionsForContext(): string {
  const all = loadAll();
  const entries = Object.entries(all);
  if (entries.length === 0) return '';
  return entries
    .map(([key, desc]) => `${key}: ${desc}`)
    .join('\n');
}
