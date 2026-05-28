import { KnowledgeSourceIndex } from '@/shared/types';
import { createLogger } from '@/shared/lib/logger';
import { userKey } from '@/shared/lib/userStorage';

const log = createLogger('KnowledgeIndexStorage');

function indexKey(sourceId: string): string {
  return userKey(`knowledge-index:${sourceId}`);
}

export function loadKnowledgeIndex(sourceId: string): KnowledgeSourceIndex | undefined {
  if (typeof window === 'undefined' || !window.localStorage) return undefined;
  try {
    const raw = localStorage.getItem(indexKey(sourceId));
    return raw ? JSON.parse(raw) as KnowledgeSourceIndex : undefined;
  } catch (error) {
    log.error('Failed to load knowledge index:', error);
    return undefined;
  }
}

export function saveKnowledgeIndex(sourceId: string, index?: KnowledgeSourceIndex): void {
  if (typeof window === 'undefined' || !window.localStorage || !index) return;
  try {
    localStorage.setItem(indexKey(sourceId), JSON.stringify(index));
  } catch (error) {
    log.error('Failed to save knowledge index:', error);
  }
}

export function hydrateKnowledgeIndexes<T extends { knowledgeSources?: Array<{ id: string; index?: KnowledgeSourceIndex }> }>(connection: T): T {
  for (const source of connection.knowledgeSources || []) {
    source.index = loadKnowledgeIndex(source.id) || source.index;
  }
  return connection;
}

export function persistAndStripKnowledgeIndexes<T extends { knowledgeSources?: Array<{ id: string; index?: KnowledgeSourceIndex }> }>(connection: T): T {
  for (const source of connection.knowledgeSources || []) {
    if (source.index) {
      saveKnowledgeIndex(source.id, source.index);
      delete source.index;
    }
  }
  return connection;
}
