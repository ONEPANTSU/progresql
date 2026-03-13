import React from 'react';
import { Box, Typography } from '@mui/material';
import {
  Circle as CircleIcon,
  Storage as DatabaseIcon,
  Cloud as BackendIcon,
} from '@mui/icons-material';
import { useAgent } from '../contexts/AgentContext';
import { useTranslation } from '../contexts/LanguageContext';

interface StatusBarProps {
  isDatabaseConnected: boolean;
  databaseName?: string;
  isReconnecting?: boolean;
  isDBConnecting?: boolean;
}

export default function StatusBar({ isDatabaseConnected, databaseName, isReconnecting, isDBConnecting }: StatusBarProps) {
  const agent = useAgent();
  const { t } = useTranslation();

  const dbColor = isDBConnecting ? 'warning.main' : isReconnecting ? 'warning.main' : isDatabaseConnected ? 'success.main' : 'error.main';
  const dbLabel = isDBConnecting
    ? t('status.db.connecting')
    : isReconnecting
      ? t('status.db.reconnecting')
      : isDatabaseConnected
        ? databaseName ? t('status.db.connected', { name: databaseName }) : t('status.db.connectedDefault')
        : t('status.db.disconnected');

  const agentConnected = agent.isConnected;
  const isConnecting = agent.connectionState === 'connecting' || agent.connectionState === 'reconnecting';
  const agentColor = isConnecting
    ? 'warning.main'
    : agentConnected
      ? 'success.main'
      : 'error.main';

  let agentLabel = t('status.backend.disconnected');
  if (agentConnected) {
    agentLabel = t('status.backend.connected');
  } else if (agent.connectionState === 'connecting') {
    const phaseLabels: Record<string, string> = {
      authorizing: t('status.backend.authorizing'),
      creating_session: t('status.backend.creatingSession'),
      websocket: t('status.backend.connecting'),
    };
    agentLabel = phaseLabels[agent.connectionPhase] || t('status.backend.connecting');
  } else if (agent.connectionState === 'reconnecting') {
    agentLabel = t('status.backend.reconnecting');
  } else if (agent.isAuthError) {
    agentLabel = t('status.backend.authError');
  }

  const modelLabel = agent.model || t('status.noModel');

  return (
    <Box
      role="status"
      aria-label={t('status.appStatus')}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        px: 1.5,
        py: 0.25,
        borderTop: '1px solid',
        borderColor: 'divider',
        backgroundColor: 'background.paper',
        minHeight: 22,
        flexShrink: 0,
      }}
    >
      {/* Database status */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }} aria-label={dbLabel}>
        <DatabaseIcon sx={{ fontSize: 12, color: 'text.secondary' }} aria-hidden="true" />
        <CircleIcon sx={{ fontSize: 6, color: dbColor }} aria-hidden="true" />
        <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: '0.6875rem', lineHeight: 1 }}>
          {dbLabel}
        </Typography>
      </Box>

      {/* Backend status */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }} aria-label={agentLabel}>
        <BackendIcon sx={{ fontSize: 12, color: 'text.secondary' }} aria-hidden="true" />
        <CircleIcon sx={{ fontSize: 6, color: agentColor }} aria-hidden="true" />
        <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: '0.6875rem', lineHeight: 1 }}>
          {agentLabel}
        </Typography>
      </Box>

      {/* LLM Model */}
      {agent.model && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, ml: 'auto' }}>
          <Typography variant="caption" sx={{ color: 'text.disabled', fontSize: '0.6875rem', lineHeight: 1 }}>
            {t('status.model', { model: modelLabel })}
          </Typography>
        </Box>
      )}
    </Box>
  );
}
