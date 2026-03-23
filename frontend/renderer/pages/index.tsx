import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Box,
  Typography,
  IconButton,
  CircularProgress,
} from '@mui/material';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import DatabasePanel from '../components/DatabasePanel';
import ERDiagram from '../components/ERDiagram';
import SQLEditor, { SQLEditorHandle } from '../components/SQLEditor';
import QueryResults from '../components/QueryResults';
import ChatPanel, { ChatPanelHandle } from '../components/ChatPanel';
import SettingsPanel from '../components/SettingsPanel';
import EditConnectionDialog from '../components/EditConnectionDialog';
import ErrorBoundary from '../components/ErrorBoundary';
import ElementDetailsModal from '../components/ElementDetailsModal';
import StatusBar from '../components/StatusBar';
import { DatabaseServer, DatabaseStructureResponse, Field, QueryResult } from '../types';
import { useAuth } from '../providers/AuthProvider';
import { useRouter } from 'next/router';
import { loadConnections, saveConnections, debugLocalStorage } from '../utils/connectionStorage';
import { useNotifications } from '../contexts/NotificationContext';
import { useAgent } from '../contexts/AgentContext';
import { createLogger } from '../utils/logger';
import { getDescriptionsForContext } from '../utils/descriptionStorage';
import { getSubscriptionWarning } from '../services/auth';
import { useSQLTabs } from '../hooks/useSQLTabs';
import { userKey } from '../utils/userStorage';
import { useTranslation } from '../contexts/LanguageContext';
import CloseIcon from '@mui/icons-material/Close';
import AccountTreeIcon from '@mui/icons-material/AccountTree';

const log = createLogger('Index');

// Softer divider color for panel separators
const DIVIDER_COLOR = 'rgba(255, 255, 255, 0.08)';

export default function Home() {
  const { isAuthenticated, isEmailVerified, user, logout } = useAuth();
  const router = useRouter();
  const { showSuccess, showInfo, showError } = useNotifications();
  const { t } = useTranslation();

  // Refs for notification functions — used in effects to avoid missing-dependency
  // warnings and stale closures without re-triggering the effects.
  const notifyRef = useRef({ showSuccess, showInfo, showError });
  useEffect(() => {
    notifyRef.current = { showSuccess, showInfo, showError };
  });
  const [connections, setConnections] = useState<DatabaseServer[]>([]);
  const [activeConnection, setActiveConnection] = useState<DatabaseServer | null>(null);
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [lastExecutedQuery, setLastExecutedQuery] = useState<string>('');
  const [databaseStructure, setDatabaseStructure] = useState<DatabaseStructureResponse | null>(null);
  const [isChatOpen, setIsChatOpen] = useState(true);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [connectionToEdit, setConnectionToEdit] = useState<DatabaseServer | null>(null);
  const [isRestoringConnections, setIsRestoringConnections] = useState(false);
  const [isDatabasePanelOpen, setIsDatabasePanelOpen] = useState(true);
  const [hasShownRestoreNotification, setHasShownRestoreNotification] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [connectionErrors, setConnectionErrors] = useState<Record<string, string>>({});
  const [isImproving, setIsImproving] = useState(false);
  const [errorLine, setErrorLine] = useState<number | null>(null);
  const [erDiagramTabs, setErDiagramTabs] = useState<Array<{ id: string; connectionId: string; connectionName: string }>>([]);
  const [activeCenterTab, setActiveCenterTab] = useState<{ type: 'sql'; id?: string } | { type: 'er'; id: string }>({ type: 'sql' });
  const [erDetailsModalOpen, setErDetailsModalOpen] = useState(false);
  const [erDetailsElement, setErDetailsElement] = useState<any>(null);
  const sqlEditorRef = useRef<SQLEditorHandle>(null);
  const chatPanelRef = useRef<ChatPanelHandle>(null);
  const agent = useAgent();
  const sqlTabs = useSQLTabs(activeConnection?.id ?? null);

  // Guard: redirect unauthenticated users to login, unverified to verify-email
  const shouldRedirect = !isAuthenticated || !isEmailVerified;
  useEffect(() => {
    const isFileProtocol = window.location.protocol === 'file:';
    const api = isFileProtocol ? (window as any).electronAPI : null;
    if (!isAuthenticated) {
      if (api?.getPageUrl) {
        window.location.href = api.getPageUrl('/login');
      } else {
        router.replace('/login');
      }
    } else if (!isEmailVerified) {
      if (api?.getPageUrl) {
        window.location.href = api.getPageUrl('/verify-email');
      } else {
        router.replace('/verify-email');
      }
    }
  }, [isAuthenticated, isEmailVerified, router]);

  // Load connections from localStorage when user becomes authenticated
  useEffect(() => {
    if (!isAuthenticated) {
      // Clear connections when not authenticated
      setConnections([]);
      setActiveConnection(null);
      setQueryResult(null);
      setDatabaseStructure(null);
      setIsRestoringConnections(false);
      // Don't reset notification flag here - only reset on actual logout
      return;
    }

    // Only run on client side
    if (typeof window === 'undefined') {
      return;
    }

    setIsRestoringConnections(true);

    // Check if notification was already shown in this session
    const notificationShown = localStorage.getItem(userKey('restore-notification-shown')) === 'true';
    setHasShownRestoreNotification(notificationShown);

    // Debug localStorage
    debugLocalStorage();

    // Load connections (async due to password decryption)
    const restoreAsync = async () => {
      const globalConnections = await loadConnections();
      log.debug('Loading connections for authenticated user:', globalConnections.length);
      setConnections(globalConnections);

      // Show notification if connections were restored (only on first load)
      if (globalConnections.length > 0 && !notificationShown) {
        notifyRef.current.showInfo(t('notify.connectionsRestored', { count: globalConnections.length }));
        setHasShownRestoreNotification(true);
        localStorage.setItem(userKey('restore-notification-shown'), 'true');
      } else {
        log.debug('No connections found or notification already shown');
      }

      // Restore all active connections (multi-connection support)
      const activeConns = globalConnections.filter((c: DatabaseServer) => c.isActive);
      if (activeConns.length > 0) {
        // Set the first active as the "selected" connection
        setActiveConnection(activeConns[0]);

        const restoreAllConnections = async () => {
          try {
            // Reconnect all previously active connections in parallel
            await Promise.all(activeConns.map(conn => performConnection(conn)));
          } catch (err) {
            log.error('Error restoring connections:', err);
          } finally {
            setIsRestoringConnections(false);
          }
        };

        // Restore connections — use app-ready event OR immediate call, never both
        let restored = false;
        const safeRestore = () => {
          if (restored) return;
          restored = true;
          restoreAllConnections();
        };

        if (window.electronAPI?.onAppReady) {
          window.electronAPI.onAppReady(() => {
            log.debug('Received app-ready, restoring connections');
            safeRestore();
          });
          log.debug('electronAPI available, restoring connections immediately');
          safeRestore();
        } else {
          log.debug('electronAPI not available, restoring connections directly');
          safeRestore();
        }
      } else {
        setActiveConnection(null);
        setIsRestoringConnections(false);
      }
    };
    restoreAsync();

    // Cleanup: remove app-ready listener on unmount or re-run
    return () => {
      if (window.electronAPI?.removeAppReadyListener) {
        window.electronAPI.removeAppReadyListener();
      }
    };
  }, [isAuthenticated]); // Run when authentication status changes

  // Save connections to localStorage whenever they change
  useEffect(() => {
    if (connections.length > 0) {
      log.debug('Saving connections to localStorage');
      saveConnections(connections);
    }
  }, [connections]);

  // Debug: Check if electronAPI is available
  useEffect(() => {
    log.debug('window.electronAPI available:', !!window.electronAPI);
    if (window.electronAPI) {
      log.debug('electronAPI methods:', Object.keys(window.electronAPI));
    }
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;

      // Cmd/Ctrl+K — focus chat input
      if (mod && e.key === 'k') {
        e.preventDefault();
        if (!isChatOpen) setIsChatOpen(true);
        // Small delay to allow panel to render if it was closed
        setTimeout(() => chatPanelRef.current?.focusInput(), 50);
      }

      // Cmd/Ctrl+E — focus SQL editor
      if (mod && e.key === 'e') {
        e.preventDefault();
        sqlEditorRef.current?.focus();
      }

      // Cmd/Ctrl+L — attach selected SQL as compact card in chat input
      if (mod && e.key === 'l') {
        e.preventDefault();
        const selectedSQL = sqlEditorRef.current?.getSelectedSQL();
        if (selectedSQL && selectedSQL.trim()) {
          if (!isChatOpen) setIsChatOpen(true);
          setTimeout(() => chatPanelRef.current?.attachSQL(selectedSQL), 50);
        }
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [isChatOpen]);

  // Listen for database auto-reconnect events from main process
  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI?.onDBConnectionLost) return;

    window.electronAPI.onDBConnectionLost((data) => {
      log.warn('Database connection lost:', data.message);
      setIsReconnecting(true);
      setConnectionError('Database connection lost. Reconnecting...');
      notifyRef.current.showError('Connection lost. Auto-reconnecting...');
    });

    window.electronAPI.onDBReconnecting((data) => {
      log.info(`Reconnect attempt ${data.attempt}/${data.maxAttempts}`);
      setConnectionError(`Reconnecting... (attempt ${data.attempt}/${data.maxAttempts})`);
    });

    window.electronAPI.onDBReconnected(async (data) => {
      const reconnectedId = data.connectionId;
      log.info('Database reconnected successfully:', reconnectedId);
      setIsReconnecting(false);
      setConnectionError(null);
      notifyRef.current.showSuccess('Database reconnected');

      // Refresh database structure after reconnect
      const targetId = reconnectedId || activeConnection?.id;
      if (targetId && window.electronAPI?.getDatabaseStructure) {
        try {
          const structureResult = await window.electronAPI.getDatabaseStructure(targetId);
          if (structureResult.success) {
            if (targetId === activeConnection?.id) {
              setDatabaseStructure(structureResult);
            }
            setConnections(prev => prev.map(c =>
              c.id === targetId
                ? { ...c, databases: structureResult.databases || [] }
                : c
            ));
          }
        } catch (err) {
          log.warn('Failed to refresh structure after reconnect:', err);
        }
      }
    });

    window.electronAPI.onDBReconnectFailed((data) => {
      const failedId = data.connectionId;
      log.error('Auto-reconnect failed:', data.message, failedId);
      setIsReconnecting(false);
      setConnectionError(data.message);
      // Mark the specific connection as inactive since reconnect failed
      const targetId = failedId || activeConnection?.id;
      if (targetId) {
        setConnections(prev => prev.map(c =>
          c.id === targetId ? { ...c, isActive: false } : c
        ));
        if (activeConnection?.id === targetId) {
          setActiveConnection(null);
        }
      }
      notifyRef.current.showError(data.message);
    });

    return () => {
      if (window.electronAPI?.removeDBConnectionListeners) {
        window.electronAPI.removeDBConnectionListeners();
      }
    };
  }, [activeConnection]);

  const handleAddConnection = (connectionConfig: Omit<DatabaseServer, 'id' | 'databases' | 'isActive'>) => {
    const newConnection: DatabaseServer = {
      ...connectionConfig,
      id: Date.now().toString(),
      databases: [],
      isActive: false,
    };
    setConnections(prev => [...prev, newConnection]);
    showSuccess(t('notify.connectionAdded', { name: connectionConfig.connectionName }));
  };

  const handleConnect = async (connectionId: string) => {
    const connection = connections.find(c => c.id === connectionId);
    if (!connection) {
      log.error('Connection not found:', connectionId);
      showError('Connection not found');
      return;
    }

    // If already connected (green), just switch active without reconnecting
    if (connection.isActive && connection.id !== activeConnection?.id) {
      setActiveConnection(connection);
      // Refresh structure for this connection
      try {
        const structureResult = await window.electronAPI?.getDatabaseStructure(connectionId);
        if (structureResult?.success) {
          setDatabaseStructure(structureResult);
        }
      } catch (e) {
        log.error('Failed to get structure for active connection:', e);
      }
      return;
    }

    await performConnection(connection);
  };

  const performConnection = async (connection: DatabaseServer) => {
    const connectionId = connection.id;

    // Set connecting state and clear previous error for this connection
    setConnectingId(connectionId);
    setConnectionErrors(prev => {
      const next = { ...prev };
      delete next[connectionId];
      return next;
    });

    try {
      log.debug('Starting database connection:', connectionId);

      // Check if electronAPI is available
      if (!window.electronAPI) {
        const errorMsg = 'Electron API is not available. Make sure you are running in Electron environment.';
        log.error(errorMsg);
        setConnectionError(errorMsg);
        setConnectionErrors(prev => ({ ...prev, [connectionId]: errorMsg }));
        setConnectingId(null);
        showError(errorMsg);
        return;
      }

      if (!window.electronAPI.connectDatabase) {
        const errorMsg = 'connectDatabase method is not available in Electron API.';
        log.error(errorMsg);
        setConnectionError(errorMsg);
        setConnectionErrors(prev => ({ ...prev, [connectionId]: errorMsg }));
        setConnectingId(null);
        showError(errorMsg);
        return;
      }

      setConnectionError(null); // Clear any previous errors

      const connectionConfig = {
        connectionId: connection.id,
        host: connection.host,
        port: connection.port,
        username: connection.username,
        password: connection.password,
        database: connection.database || 'postgres',
        connectionName: connection.connectionName
      };

      log.debug('Calling electronAPI.connectDatabase');

      // Timeout to prevent hanging IPC calls (e.g., on Windows first load)
      const connectWithTimeout = (config: typeof connectionConfig, timeoutMs = 15000) => {
        return Promise.race([
          window.electronAPI.connectDatabase(config),
          new Promise<{ success: false; message: string }>((_, reject) =>
            setTimeout(() => reject(new Error('Connection timed out. Please try again.')), timeoutMs)
          ),
        ]);
      };

      const result = await connectWithTimeout(connectionConfig);

      if (result.success) {
        log.debug('Connection successful');
        setConnectingId(null);
        showSuccess(t('notify.connected'));

        setActiveConnection(connection);

        // Get database structure
        log.debug('Getting database structure...');
        try {
          const structureResult = await window.electronAPI.getDatabaseStructure(connectionId);

          if (structureResult.success) {
            setDatabaseStructure(structureResult);

            // Fetch list of all available databases on this server
            let availableDatabases: Array<{ name: string; owner?: string; encoding?: string; size?: string }> | undefined;
            try {
              const dbListResult = await window.electronAPI.listDatabases(connectionId);
              if (dbListResult.success && dbListResult.databases) {
                availableDatabases = dbListResult.databases;
              }
            } catch (e) {
              log.warn('Failed to list databases:', e);
            }

            // Mark this connection as active (keep others' isActive unchanged)
            setConnections(prev => prev.map(c =>
              c.id === connectionId ? {
                ...c,
                databases: structureResult.databases || [],
                isActive: true,
                activeDatabase: connection.database || 'postgres',
                ...(availableDatabases ? { availableDatabases } : {}),
              } : c
            ));

            log.debug('Connection updated with database structure');
          } else {
            log.error('Failed to get database structure:', structureResult.message);
            setConnections(prev => prev.map(c =>
              c.id === connectionId ? { ...c, isActive: true } : c
            ));
            setConnectionError(`Failed to get database structure: ${structureResult.message}`);
            showError(t('notify.dbStructureErrorDetail', { error: structureResult.message || '' }));
          }
        } catch (structureError) {
          log.error('Error getting database structure:', structureError);
          setConnections(prev => prev.map(c =>
            c.id === connectionId ? { ...c, isActive: true } : c
          ));
          showError(t('notify.dbStructureError'));
        }
      } else {
        const errorMsg = result.message || 'Connection failed';
        log.error('Connection failed:', errorMsg);
        setConnectionError(errorMsg);
        setConnectionErrors(prev => ({ ...prev, [connectionId]: errorMsg }));
        setConnectingId(null);
        showError(t('notify.connectionError', { error: errorMsg }));
      }
    } catch (error) {
      log.error('Connection error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown connection error';
      setConnectionError(errorMessage);
      setConnectionErrors(prev => ({ ...prev, [connectionId]: errorMessage }));
      setConnectingId(null);
      showError(t('notify.connectionError', { error: errorMessage }));
    }
  };

  const handleDisconnect = async (connectionId: string) => {
    try {
      const result = await window.electronAPI.disconnectDatabase(connectionId);
      if (result.success) {
        setConnections(prev => prev.map(c =>
          c.id === connectionId ? { ...c, isActive: false, databases: [] } : c
        ));
        // If the disconnected connection was the active one, switch to another connected or null
        if (activeConnection?.id === connectionId) {
          setConnections(prev => {
            const otherActive = prev.find(c => c.isActive && c.id !== connectionId);
            setActiveConnection(otherActive ?? null);
            if (!otherActive) {
              setQueryResult(null);
              setDatabaseStructure(null);
            }
            return prev;
          });
        }
      }
    } catch (error) {
      log.error('Disconnection error:', error);
    }
  };

  const handleSwitchDatabase = async (connectionId: string, database: string) => {
    const connection = connections.find(c => c.id === connectionId);
    if (!connection) return;

    // Already on this database
    if (connection.activeDatabase === database) return;

    setConnectingId(connectionId);
    try {
      const result = await window.electronAPI.switchDatabase(connectionId, database);
      if (result.success) {
        // Fetch structure for new database
        const structureResult = await window.electronAPI.getDatabaseStructure(connectionId);
        if (structureResult.success) {
          setDatabaseStructure(structureResult);
          setConnections(prev => prev.map(c =>
            c.id === connectionId ? {
              ...c,
              databases: structureResult.databases || [],
              activeDatabase: database,
            } : c
          ));
          // Update activeConnection ref
          setActiveConnection(prev =>
            prev?.id === connectionId ? { ...prev, databases: structureResult.databases || [], activeDatabase: database } : prev
          );
        }
        showSuccess(t('notify.connected') + ` (${database})`);
      } else {
        showError(result.message || 'Failed to switch database');
      }
    } catch (error) {
      log.error('Switch database error:', error);
      showError(error instanceof Error ? error.message : 'Switch database error');
    } finally {
      setConnectingId(null);
    }
  };

  const handleEditConnection = (connection: DatabaseServer) => {
    setConnectionToEdit(connection);
    setEditDialogOpen(true);
  };

  const handleUpdateConnection = (connectionId: string, updatedData: Omit<DatabaseServer, 'id' | 'databases' | 'isActive'>) => {
    setConnections(prev => prev.map(conn =>
      conn.id === connectionId
        ? { ...conn, ...updatedData }
        : conn
    ));

    // If the updated connection is the active one, update the active connection state
    if (activeConnection?.id === connectionId) {
      setActiveConnection(prev => prev ? { ...prev, ...updatedData } : null);
    }

    showSuccess(t('notify.connectionUpdated', { name: updatedData.connectionName }));

    // Auto-reconnect after editing — always try to connect with updated params.
    // This handles both active connections (reconnect) and disconnected ones (retry).
    handleConnect(connectionId);
  };

  const handleCloseEditDialog = () => {
    setEditDialogOpen(false);
    setConnectionToEdit(null);
  };

  const handleDeleteConnection = async (connectionId: string) => {
    const connectionToDelete = connections.find(c => c.id === connectionId);
    // Disconnect if active before deleting
    if (connectionToDelete?.isActive) {
      try { await window.electronAPI.disconnectDatabase(connectionId); } catch (_) { /* ignore */ }
    }
    setConnections(prev => prev.filter(c => c.id !== connectionId));
    if (activeConnection?.id === connectionId) {
      const otherActive = connections.find(c => c.isActive && c.id !== connectionId);
      setActiveConnection(otherActive ?? null);
      if (!otherActive) {
        setQueryResult(null);
        setDatabaseStructure(null);
      }
    }
    if (connectionToDelete) {
      showSuccess(t('notify.connectionDeleted', { name: connectionToDelete.connectionName }));
    }
  };

  const handleRefreshConnection = async (connectionId: string) => {
    const connection = connections.find(c => c.id === connectionId);
    if (!connection || !connection.isActive) return;

    try {
      log.debug('Refreshing database structure for:', connectionId);

      if (!window.electronAPI?.getDatabaseStructure) {
        showError('Electron API not available');
        return;
      }

      const structureResult = await window.electronAPI.getDatabaseStructure(connectionId);

      if (structureResult.success) {
        setDatabaseStructure(structureResult);
        setConnections(prev => prev.map(c =>
          c.id === connectionId ? {
            ...c,
            databases: structureResult.databases || [],
          } : c
        ));
        showSuccess(t('notify.dbStructureUpdated'));
        log.debug('Database structure refreshed successfully');
      } else {
        const msg = structureResult.message || '';
        log.error('Failed to refresh database structure:', msg);
        if (msg.includes('connection lost') || msg.includes('Auto-reconnect')) {
          setIsReconnecting(true);
          showError(t('notify.connectionLost'));
        } else {
          showError(t('notify.updateError', { error: msg }));
        }
      }
    } catch (error) {
      log.error('Refresh connection error:', error);
      showError(t('notify.dbStructureUpdateError'));
    }
  };

  const insertIntoEditor = (name: string) => {
    const escaped = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
    sqlEditorRef.current?.insertText(escaped);
  };

  const handleSelectTable = (tableName: string) => {
    insertIntoEditor(tableName);
  };

  const handleSelectView = (viewName: string) => {
    insertIntoEditor(viewName);
  };

  const handleSelectFunction = (functionName: string) => {
    insertIntoEditor(functionName);
  };

  const handleSelectProcedure = (procedureName: string) => {
    insertIntoEditor(procedureName);
  };

  const handleImproveQuery = (sql: string) => {
    if (getSubscriptionWarning(user) === 'expired') {
      showError(t('subscription.improveBlocked'));
      return;
    }
    if (!agent.isConnected) {
      showError(t('notify.improveConnectBackend'));
      return;
    }
    setIsImproving(true);
    agent.sendRequest(
      { action: 'improve_sql', context: { selected_sql: sql, user_descriptions: getDescriptionsForContext() || undefined } },
      {
        onResponse: (response) => {
          setIsImproving(false);
          if (response.result.sql) {
            sqlEditorRef.current?.replaceSelection(response.result.sql);
          }
        },
        onError: () => {
          setIsImproving(false);
          showError(t('notify.improveFailed'));
        },
      },
    );
  };

  const handleAnalyzeSchema = () => {
    if (!isChatOpen) {
      setIsChatOpen(true);
    }
    chatPanelRef.current?.sendAnalyzeSchema();
  };

  const handleExplainObject = (objectName: string, objectType: string, definition?: string) => {
    if (!isChatOpen) {
      setIsChatOpen(true);
    }
    if (definition) {
      // Has SQL definition (view, function, etc.) — explain as SQL
      setTimeout(() => chatPanelRef.current?.sendExplainSQL(definition), 50);
    } else {
      // No definition (table, sequence, etc.) — send as plain text question
      const prompt = `Explain the ${objectType} "${objectName}" — what is it for, what columns/structure does it have?`;
      setTimeout(() => {
        chatPanelRef.current?.setInputText(prompt);
        chatPanelRef.current?.focusInput();
      }, 50);
    }
  };

  const handleQueryTable = (tableName: string) => {
    // If it's already a full SQL statement (DDL/DML), use as-is
    const isDDL = /^\s*(CREATE|DROP|ALTER|INSERT|UPDATE|DELETE|TRUNCATE|GRANT|REVOKE)\s/i.test(tableName);
    const query = isDDL ? tableName : `SELECT * FROM ${tableName}\n  LIMIT 100;`;
    sqlEditorRef.current?.replaceSelection(query);
  };

  const handleApplySQL = (sql: string, targetConnectionId?: string) => {
    if (targetConnectionId) {
      // Switch to the target connection if different from current
      const targetConn = connections.find(c => c.id === targetConnectionId);
      if (targetConn && targetConn.id !== activeConnection?.id) {
        setActiveConnection(targetConn);
      }
      // Create a new tab on the target connection with the SQL
      const newTab = sqlTabs.createTab(targetConnectionId);
      sqlTabs.updateTabContent(newTab.id, sql);
    } else {
      sqlEditorRef.current?.replaceSelection(sql);
    }
  };

  const handleERViewTableInfo = useCallback((tableName: string, connectionId: string) => {
    const conn = connections.find(c => c.id === connectionId);
    if (!conn) return;
    const tables = conn.databases?.[0]?.tables ?? [];
    const table = tables.find(t => t.table_name === tableName);
    if (!table) return;
    setErDetailsElement(table);
    setErDetailsModalOpen(true);
  }, [connections]);

  const handleOpenERDiagram = (connectionId: string) => {
    const conn = connections.find(c => c.id === connectionId);
    if (!conn) return;
    // Check if tab already exists for this connection
    const existing = erDiagramTabs.find(t => t.connectionId === connectionId);
    if (existing) {
      setActiveCenterTab({ type: 'er', id: existing.id });
      return;
    }
    const newTab = {
      id: `er-${connectionId}-${Date.now()}`,
      connectionId,
      connectionName: conn.connectionName || conn.host || 'Database',
    };
    setErDiagramTabs(prev => [...prev, newTab]);
    setActiveCenterTab({ type: 'er', id: newTab.id });
  };

  const handleCloseERTab = (tabId: string) => {
    setErDiagramTabs(prev => prev.filter(t => t.id !== tabId));
    // If we're closing the active ER tab, switch back to SQL
    if (activeCenterTab.type === 'er' && activeCenterTab.id === tabId) {
      setActiveCenterTab({ type: 'sql' });
    }
  };

  // Parse line number from PostgreSQL error messages (e.g. "ERROR: ... at line 3", "LINE 3:")
  const parseErrorLine = (errorMsg: string): number | null => {
    // PostgreSQL "LINE N:" pattern
    const lineMatch = errorMsg.match(/LINE\s+(\d+)/i);
    if (lineMatch) return parseInt(lineMatch[1], 10);
    // "at line N" pattern
    const atLineMatch = errorMsg.match(/at\s+line\s+(\d+)/i);
    if (atLineMatch) return parseInt(atLineMatch[1], 10);
    // "line N" at end
    const endLineMatch = errorMsg.match(/line\s+(\d+)\s*$/im);
    if (endLineMatch) return parseInt(endLineMatch[1], 10);
    return null;
  };

  const handleFixInChat = (sqlQuery: string, errorMsg: string) => {
    if (!isChatOpen) setIsChatOpen(true);
    const context = `Fix this SQL error:\n\n\`\`\`sql\n${sqlQuery}\n\`\`\`\n\nError: ${errorMsg}`;
    setTimeout(() => chatPanelRef.current?.setInputText(context), 50);
  };

  // Silent mutation (UPDATE/INSERT/DELETE) — doesn't update queryResult/lastExecutedQuery
  const handleMutateQuery = async (query: string): Promise<{ success: boolean; message?: string }> => {
    if (isReconnecting) {
      return { success: false, message: 'Database is reconnecting. Please wait...' };
    }
    const connId = sqlTabs.activeTab?.connectionId ?? activeConnection?.id ?? '';
    try {
      const result = await window.electronAPI.executeQuery(connId, query);
      if (!result.success) {
        showError(result.message || 'Mutation failed');
        return { success: false, message: result.message };
      }
      return { success: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      showError(msg);
      return { success: false, message: msg };
    }
  };

  const handleExecuteQuery = async (query: string) => {
    if (isReconnecting) {
      showError('Database is reconnecting. Please wait...');
      return;
    }
    // Use the active tab's connectionId, falling back to activeConnection
    const connId = sqlTabs.activeTab?.connectionId ?? activeConnection?.id ?? '';
    log.debug('Executing query on connection:', connId);
    try {
      setLastExecutedQuery(query);
      const result = await window.electronAPI.executeQuery(connId, query);
      if (result.success) {
        setQueryResult({
          rows: result.rows || [],
          rowCount: result.rowCount || 0,
          fields: (result.fields || []) as Field[],
          message: 'Query executed successfully',
          timestamp: new Date().toISOString(),
        });
        setConnectionError(null);
        setErrorLine(null); // Clear error highlighting on success
      } else {
        const msg = result.message || '';
        // Check if it's a connection error with auto-reconnect
        if (msg.includes('connection lost') || msg.includes('Auto-reconnect')) {
          setIsReconnecting(true);
          showError(t('notify.connectionLost'));
        } else {
          showError(msg);
        }

        setErrorLine(parseErrorLine(msg));

        setQueryResult({
          rows: [],
          rowCount: 0,
          fields: [],
          message: `Error: ${msg}`,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Check if it's a connection error
      if (errorMessage.includes('connection') || errorMessage.includes('Connection')) {
        setIsReconnecting(true);
        showError(t('notify.connectionLost'));
      }

      setErrorLine(parseErrorLine(errorMessage));

      setQueryResult({
        rows: [],
        rowCount: 0,
        fields: [],
        message: `Error: ${errorMessage}`,
        timestamp: new Date().toISOString(),
      });
    }
  };

  // Block rendering while redirecting to prevent white flash on Windows
  if (shouldRedirect) {
    return (
      <Box sx={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: 'background.default' }}>
        <CircularProgress size={32} />
      </Box>
    );
  }

  return (
    <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column', backgroundColor: 'background.default' }}>
      {/* Main Content Area */}
      <Box sx={{ flexGrow: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Main Content */}
        <Box sx={{ flexGrow: 1, mr: 0, transition: 'margin-right 0.3s ease' }}>
            <PanelGroup
              direction="horizontal"
              style={{
                height: '100%',
                width: '100%',
                maxWidth: '100vw' // Ограничиваем максимальную ширину экрана
              }}
              autoSaveId="main-horizontal-panels"
            >
              {/* Left Panel: Database Explorer */}
              {isDatabasePanelOpen && (
                <>
                  <Panel
                    defaultSize={25}
                    minSize={15}
                    maxSize={50}
                    id="database-panel"
                  >
                    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', borderRight: '1px solid', borderColor: DIVIDER_COLOR }}>
                      <Box sx={{ flex: 1, overflow: 'hidden' }}>
                        <ErrorBoundary panelName="Database Panel">
                          <DatabasePanel
                            connections={connections}
                            activeConnection={activeConnection}
                            onAddConnection={handleAddConnection}
                            onConnect={handleConnect}
                            onDisconnect={handleDisconnect}
                            onDeleteConnection={handleDeleteConnection}
                            onEditConnection={handleEditConnection}
                            onRefreshConnection={handleRefreshConnection}
                            onSelectTable={handleSelectTable}
                            onSelectView={handleSelectView}
                            onSelectFunction={handleSelectFunction}
                            onSelectProcedure={handleSelectProcedure}
                            onExplainObject={handleExplainObject}
                            onQueryTable={handleQueryTable}
                            onApplySQL={handleApplySQL}
                            onExecuteSQL={handleMutateQuery}
                            onRefreshData={() => activeConnection?.id && handleRefreshConnection(activeConnection.id)}
                            onOpenERDiagram={handleOpenERDiagram}
                            onSwitchDatabase={handleSwitchDatabase}
                            isRestoringConnections={isRestoringConnections}
                            connectingId={connectingId}
                            connectionErrors={connectionErrors}
                          />
                        </ErrorBoundary>
                      </Box>
                    </Box>
                  </Panel>

                  {/* Resize Handle */}
                  <PanelResizeHandle
                    style={{
                      width: '4px',
                      cursor: 'col-resize',
                      background: DIVIDER_COLOR,
                      transition: 'background 0.15s',
                    }}
                  />
                </>
              )}

              {/* Center Panel: Query Editor + Results */}
              <Panel
                defaultSize={isDatabasePanelOpen ? 50 : 75}
                minSize={30}
                id="center-panel"
              >
                {activeConnection ? (
                  <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                    {/* Center panel tab bar (ER diagram tabs) */}
                    {erDiagramTabs.length > 0 && (
                      <Box sx={{
                        display: 'flex',
                        alignItems: 'center',
                        borderBottom: '1px solid',
                        borderColor: DIVIDER_COLOR,
                        minHeight: 32,
                        bgcolor: 'background.default',
                        overflow: 'auto',
                        flexShrink: 0,
                        '&::-webkit-scrollbar': { height: 4 },
                        '&::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.15)', borderRadius: 2 },
                      }}>
                        {/* SQL tab */}
                        <Box
                          onClick={() => setActiveCenterTab({ type: 'sql' })}
                          sx={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 0.5,
                            px: 1.5,
                            py: 0.5,
                            cursor: 'pointer',
                            borderRight: '1px solid',
                            borderColor: DIVIDER_COLOR,
                            minWidth: 'fit-content',
                            whiteSpace: 'nowrap',
                            bgcolor: activeCenterTab.type === 'sql' ? 'background.paper' : 'transparent',
                            borderBottom: activeCenterTab.type === 'sql' ? '2px solid' : '2px solid transparent',
                            borderBottomColor: activeCenterTab.type === 'sql' ? 'primary.main' : 'transparent',
                            '&:hover': { bgcolor: activeCenterTab.type === 'sql' ? 'background.paper' : 'action.hover' },
                          }}
                        >
                          <Typography variant="caption" sx={{
                            fontWeight: activeCenterTab.type === 'sql' ? 600 : 400,
                            color: activeCenterTab.type === 'sql' ? 'text.primary' : 'text.secondary',
                            fontSize: '0.75rem',
                          }}>
                            SQL Editor
                          </Typography>
                        </Box>
                        {/* ER diagram tabs */}
                        {erDiagramTabs.map(tab => (
                          <Box
                            key={tab.id}
                            onClick={() => setActiveCenterTab({ type: 'er', id: tab.id })}
                            sx={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 0.5,
                              px: 1.5,
                              py: 0.5,
                              cursor: 'pointer',
                              borderRight: '1px solid',
                              borderColor: DIVIDER_COLOR,
                              minWidth: 'fit-content',
                              whiteSpace: 'nowrap',
                              bgcolor: activeCenterTab.type === 'er' && activeCenterTab.id === tab.id ? 'background.paper' : 'transparent',
                              borderBottom: activeCenterTab.type === 'er' && activeCenterTab.id === tab.id ? '2px solid' : '2px solid transparent',
                              borderBottomColor: activeCenterTab.type === 'er' && activeCenterTab.id === tab.id ? 'primary.main' : 'transparent',
                              '&:hover': { bgcolor: activeCenterTab.type === 'er' && activeCenterTab.id === tab.id ? 'background.paper' : 'action.hover' },
                            }}
                          >
                            <AccountTreeIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
                            <Typography variant="caption" sx={{
                              fontWeight: activeCenterTab.type === 'er' && activeCenterTab.id === tab.id ? 600 : 400,
                              color: activeCenterTab.type === 'er' && activeCenterTab.id === tab.id ? 'text.primary' : 'text.secondary',
                              fontSize: '0.75rem',
                            }}>
                              ER: {tab.connectionName}
                            </Typography>
                            <IconButton
                              size="small"
                              onClick={(e) => { e.stopPropagation(); handleCloseERTab(tab.id); }}
                              sx={{
                                p: '1px',
                                opacity: activeCenterTab.type === 'er' && activeCenterTab.id === tab.id ? 0.7 : 0,
                                '&:hover': { opacity: 1 },
                                '.MuiBox-root:hover > &': { opacity: 0.5 },
                              }}
                              aria-label={`Close ER: ${tab.connectionName}`}
                            >
                              <CloseIcon sx={{ fontSize: 14 }} />
                            </IconButton>
                          </Box>
                        ))}
                      </Box>
                    )}
                    {/* Center panel content */}
                    {activeCenterTab.type === 'sql' ? (
                      <PanelGroup
                        direction="vertical"
                        style={{
                          flex: 1,
                          isolation: 'isolate',
                        }}
                        autoSaveId="center-vertical-panels"
                      >
                        {/* SQL Editor */}
                        <Panel
                          defaultSize={50}
                          minSize={20}
                          id="sql-editor-panel"
                        >
                          <Box sx={{ height: '100%', borderBottom: '1px solid', borderColor: DIVIDER_COLOR }}>
                            <ErrorBoundary panelName="SQL Editor">
                              <SQLEditor
                                ref={sqlEditorRef}
                                onExecuteQuery={handleExecuteQuery}
                                onImproveQuery={handleImproveQuery}
                                isImproving={isImproving}
                                tabs={sqlTabs.tabs}
                                activeTab={sqlTabs.activeTab}
                                activeTabId={sqlTabs.activeTabId}
                                onTabChange={sqlTabs.setActiveTab}
                                onCreateTab={() => activeConnection && sqlTabs.createTab(activeConnection.id)}
                                onCloseTab={sqlTabs.closeTab}
                                onRenameTab={(tabId, title) => sqlTabs.renameTab(tabId, title)}
                                onContentChange={sqlTabs.updateTabContent}
                                databaseInfo={activeConnection?.databases?.[0] ?? null}
                                errorLine={errorLine}
                                activeConnection={activeConnection}
                                connections={connections}
                                connectionErrors={connectionErrors}
                                onSwitchConnection={handleConnect}
                              />
                            </ErrorBoundary>
                          </Box>
                        </Panel>

                        {/* Resize Handle */}
                        <PanelResizeHandle
                          style={{
                            height: '4px',
                            cursor: 'row-resize',
                            background: DIVIDER_COLOR,
                            transition: 'background 0.15s',
                          }}
                        />

                        {/* Query Results */}
                        <Panel
                          defaultSize={50}
                          minSize={20}
                          id="query-results-panel"
                        >
                          <Box sx={{ height: '100%' }}>
                            <ErrorBoundary panelName="Query Results">
                              <QueryResults result={queryResult} executedQuery={lastExecutedQuery} onExecuteQuery={handleExecuteQuery} onMutateQuery={handleMutateQuery} onFixInChat={handleFixInChat} />
                            </ErrorBoundary>
                          </Box>
                        </Panel>
                      </PanelGroup>
                    ) : (
                      /* ER Diagram tab content */
                      (() => {
                        const erTab = erDiagramTabs.find(t => t.id === activeCenterTab.id);
                        const erConn = erTab ? connections.find(c => c.id === erTab.connectionId) : null;
                        return (
                          <Box sx={{ flex: 1, overflow: 'hidden' }}>
                            <ErrorBoundary panelName="ER Diagram">
                              <ERDiagram
                                tables={erConn?.databases?.[0]?.tables ?? []}
                                constraints={erConn?.databases?.[0]?.constraints ?? []}
                                onViewTableInfo={(tableName) => erTab && handleERViewTableInfo(tableName, erTab.connectionId)}
                              />
                            </ErrorBoundary>
                          </Box>
                        );
                      })()
                    )}
                  </Box>
                ) : (
                  <Box sx={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                      Connect to a database to start working
                    </Typography>
                  </Box>
                )}
              </Panel>

              {/* Chat Panel */}
              {isChatOpen && (
                <>
                  {/* Resize Handle */}
                  <PanelResizeHandle
                    style={{
                      width: '4px',
                      cursor: 'col-resize',
                      background: DIVIDER_COLOR,
                      transition: 'background 0.15s',
                    }}
                  />

                  {/* Right Panel: Chat */}
                  <Panel
                    defaultSize={30}
                    minSize={20}
                    maxSize={50}
                    id="chat-panel"
                  >
                    <ErrorBoundary panelName="Chat Panel">
                      <ChatPanel
                        ref={chatPanelRef}
                        isOpen={isChatOpen}
                        onClose={() => setIsChatOpen(false)}
                        onExecuteQuery={handleExecuteQuery}
                        onApplySQL={handleApplySQL}
                        isDatabaseConnected={activeConnection !== null}
                        onOpenSettings={() => setIsSettingsOpen(true)}
                        activeConnection={activeConnection}
                        connections={connections}
                        connectionErrors={connectionErrors}
                        onSwitchConnection={handleConnect}
                      />
                    </ErrorBoundary>
                  </Panel>
                </>
              )}
            </PanelGroup>
        </Box>
      </Box>

      {/* Status Bar */}
      <StatusBar
        isDatabaseConnected={activeConnection !== null}
        databaseName={activeConnection?.connectionName || activeConnection?.host}
        isReconnecting={isReconnecting}
        isDBConnecting={connectingId !== null}
      />

      {/* Edit Connection Dialog */}
      <EditConnectionDialog
        open={editDialogOpen}
        connection={connectionToEdit}
        onClose={handleCloseEditDialog}
        onUpdate={handleUpdateConnection}
      />

      {/* Settings Panel (Drawer) */}
      <SettingsPanel
        open={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
      />

      {/* ER Diagram Element Details Modal */}
      <ElementDetailsModal
        open={erDetailsModalOpen}
        onClose={() => { setErDetailsModalOpen(false); setErDetailsElement(null); }}
        element={erDetailsElement}
        elementType="table"
        onApplySQL={handleApplySQL}
        onExecuteSQL={handleMutateQuery}
        onRefreshData={() => activeConnection?.id && handleRefreshConnection(activeConnection.id)}
        onExplainInChat={handleExplainObject}
      />
    </Box>
  );
}
