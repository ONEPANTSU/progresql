import { useState, useCallback, useEffect, useRef } from 'react';
import { SQLTab } from '@/shared/types';
import { userKey } from '@/shared/lib/userStorage';

function tabsKey(): string {
  return userKey('sql-tabs');
}

function activeTabKey(): string {
  return userKey('active-sql-tab');
}
const DEFAULT_CONTENT = '-- Write your SQL query here\nSELECT * FROM your_table LIMIT 10;';

let tabCounter = 0;

function generateTabId(): string {
  tabCounter += 1;
  return `tab-${Date.now()}-${tabCounter}`;
}

function loadTabs(): SQLTab[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(tabsKey());
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveTabs(tabs: SQLTab[]) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(tabsKey(), JSON.stringify(tabs));
}

function loadActiveTabId(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(activeTabKey());
}

function saveActiveTabId(id: string | null) {
  if (typeof window === 'undefined') return;
  if (id) {
    localStorage.setItem(activeTabKey(), id);
  } else {
    localStorage.removeItem(activeTabKey());
  }
}

export interface UseSQLTabsReturn {
  /** Tabs for the currently active connection */
  tabs: SQLTab[];
  /** Currently active tab */
  activeTab: SQLTab | null;
  /** Active tab ID */
  activeTabId: string | null;
  /** Create a new tab for the given connection */
  createTab: (connectionId: string) => SQLTab;
  /** Switch to a tab */
  setActiveTab: (tabId: string) => void;
  /** Close a tab */
  closeTab: (tabId: string) => void;
  /** Update the content of a tab */
  updateTabContent: (tabId: string, content: string) => void;
  /** Rename a tab */
  renameTab: (tabId: string, title: string) => void;
}

export function useSQLTabs(activeConnectionId: string | null): UseSQLTabsReturn {
  const [allTabs, setAllTabs] = useState<SQLTab[]>(() => loadTabs());
  const [activeTabId, setActiveTabId] = useState<string | null>(() => loadActiveTabId());
  const prevConnectionIdRef = useRef<string | null>(null);

  // Persist tabs
  useEffect(() => {
    saveTabs(allTabs);
  }, [allTabs]);

  // Persist active tab
  useEffect(() => {
    saveActiveTabId(activeTabId);
  }, [activeTabId]);

  // Filter tabs for active connection
  const tabs = activeConnectionId
    ? allTabs.filter(t => t.connectionId === activeConnectionId)
    : [];

  // Active tab object
  const activeTab = activeTabId ? tabs.find(t => t.id === activeTabId) ?? null : null;

  // When connection changes, switch to an existing tab for that connection or create one
  useEffect(() => {
    if (activeConnectionId === prevConnectionIdRef.current) return;
    prevConnectionIdRef.current = activeConnectionId;

    if (!activeConnectionId) {
      setActiveTabId(null);
      return;
    }

    const connectionTabs = allTabs.filter(t => t.connectionId === activeConnectionId);
    if (connectionTabs.length > 0) {
      // Switch to first tab of this connection (or keep current if it belongs to this connection)
      const currentBelongs = activeTabId && connectionTabs.some(t => t.id === activeTabId);
      if (!currentBelongs) {
        setActiveTabId(connectionTabs[0].id);
      }
    } else {
      // Auto-create first tab for this connection
      const newTab: SQLTab = {
        id: generateTabId(),
        connectionId: activeConnectionId,
        title: 'Query 1',
        content: DEFAULT_CONTENT,
        createdAt: new Date().toISOString(),
      };
      setAllTabs(prev => [...prev, newTab]);
      setActiveTabId(newTab.id);
    }
  }, [activeConnectionId, allTabs, activeTabId]);

  const createTab = useCallback((connectionId: string): SQLTab => {
    const connectionTabs = allTabs.filter(t => t.connectionId === connectionId);
    // Find the next available number (avoid duplicates like "Query 2", "Query 2")
    const usedNumbers = new Set(
      connectionTabs
        .map(t => {
          const m = t.title.match(/^Query (\d+)$/);
          return m ? parseInt(m[1], 10) : 0;
        })
        .filter(n => n > 0)
    );
    let num = 1;
    while (usedNumbers.has(num)) num++;
    const newTab: SQLTab = {
      id: generateTabId(),
      connectionId,
      title: `Query ${num}`,
      content: DEFAULT_CONTENT,
      createdAt: new Date().toISOString(),
    };
    setAllTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
    return newTab;
  }, [allTabs]);

  const closeTab = useCallback((tabId: string) => {
    setAllTabs(prev => {
      const updated = prev.filter(t => t.id !== tabId);
      // If closing active tab, switch to another tab of same connection
      if (activeTabId === tabId && activeConnectionId) {
        const remaining = updated.filter(t => t.connectionId === activeConnectionId);
        if (remaining.length > 0) {
          setActiveTabId(remaining[remaining.length - 1].id);
        } else {
          // Create a new tab if none left
          const newTab: SQLTab = {
            id: generateTabId(),
            connectionId: activeConnectionId,
            title: 'Query 1',
            content: DEFAULT_CONTENT,
            createdAt: new Date().toISOString(),
          };
          setActiveTabId(newTab.id);
          return [...updated, newTab];
        }
      }
      return updated;
    });
  }, [activeTabId, activeConnectionId]);

  const updateTabContent = useCallback((tabId: string, content: string) => {
    setAllTabs(prev => prev.map(t => t.id === tabId ? { ...t, content } : t));
  }, []);

  const renameTab = useCallback((tabId: string, title: string) => {
    setAllTabs(prev => prev.map(t => t.id === tabId ? { ...t, title } : t));
  }, []);

  const setActiveTabCallback = useCallback((tabId: string) => {
    setActiveTabId(tabId);
  }, []);

  return {
    tabs,
    activeTab,
    activeTabId,
    createTab,
    setActiveTab: setActiveTabCallback,
    closeTab,
    updateTabContent,
    renameTab,
  };
}
