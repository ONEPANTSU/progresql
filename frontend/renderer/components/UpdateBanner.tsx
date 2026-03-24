import React, { useState, useEffect } from 'react';
import { Box, Typography, Button, IconButton } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import RocketLaunchIcon from '@mui/icons-material/RocketLaunch';
import { useTranslation } from '../contexts/LanguageContext';

/**
 * Non-intrusive update notification banner.
 * Checks GitHub releases on mount (once per app launch) and shows
 * a styled bar at the top if a newer version is available.
 */
export default function UpdateBanner() {
  const { t } = useTranslation();
  const [updateInfo, setUpdateInfo] = useState<{
    latestVersion: string;
    downloadUrl: string;
  } | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api?.checkForUpdates) return;

    let cancelled = false;

    api.checkForUpdates().then((result: { hasUpdate: boolean; latestVersion: string; downloadUrl: string }) => {
      if (cancelled) return;
      if (result.hasUpdate) {
        setUpdateInfo({
          latestVersion: result.latestVersion,
          downloadUrl: result.downloadUrl,
        });
      }
    }).catch(() => {
      // Silently ignore update check failures
    });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!updateInfo || dismissed) return null;

  const handleDownload = () => {
    const api = (window as any).electronAPI;
    if (api?.openExternal) {
      api.openExternal(updateInfo.downloadUrl);
    }
  };

  return (
    <Box
      role="alert"
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
        px: 2,
        py: 0.75,
        background: 'linear-gradient(135deg, rgba(124, 58, 237, 0.15), rgba(99, 102, 241, 0.12), rgba(59, 130, 246, 0.1))',
        borderBottom: '1px solid rgba(124, 58, 237, 0.3)',
        minHeight: 40,
        flexShrink: 0,
        position: 'relative',
        overflow: 'hidden',
        '&::before': {
          content: '""',
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: 3,
          background: 'linear-gradient(180deg, #7c3aed, #6366f1, #3b82f6)',
        },
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
          height: 28,
          borderRadius: '8px',
          background: 'linear-gradient(135deg, rgba(124, 58, 237, 0.25), rgba(99, 102, 241, 0.2))',
          flexShrink: 0,
        }}
      >
        <RocketLaunchIcon
          sx={{ fontSize: 16, color: '#a78bfa' }}
        />
      </Box>
      <Typography
        variant="body2"
        sx={{
          color: 'rgba(255, 255, 255, 0.9)',
          fontSize: '0.82rem',
          lineHeight: 1.4,
          fontWeight: 500,
          '& span': {
            color: '#a78bfa',
            fontWeight: 700,
          },
        }}
      >
        {t('update.available', { version: '' })}
        <span>v{updateInfo.latestVersion}</span>
      </Typography>
      <Button
        size="small"
        variant="contained"
        onClick={handleDownload}
        sx={{
          textTransform: 'none',
          fontSize: '0.75rem',
          py: 0.4,
          px: 2,
          minHeight: 28,
          borderRadius: '6px',
          fontWeight: 600,
          background: 'linear-gradient(135deg, #7c3aed, #6366f1)',
          boxShadow: '0 2px 8px rgba(124, 58, 237, 0.3)',
          '&:hover': {
            background: 'linear-gradient(135deg, #8b5cf6, #818cf8)',
            boxShadow: '0 4px 12px rgba(124, 58, 237, 0.4)',
          },
        }}
      >
        {t('update.download')}
      </Button>
      <IconButton
        size="small"
        onClick={() => setDismissed(true)}
        aria-label={t('update.dismiss')}
        sx={{
          color: 'rgba(255, 255, 255, 0.4)',
          p: 0.5,
          '&:hover': {
            color: 'rgba(255, 255, 255, 0.7)',
            backgroundColor: 'rgba(255, 255, 255, 0.05)',
          },
        }}
      >
        <CloseIcon sx={{ fontSize: 16 }} />
      </IconButton>
    </Box>
  );
}
