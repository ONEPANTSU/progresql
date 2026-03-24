import React, { useState, useEffect } from 'react';
import { Box, Typography, Button, IconButton } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import { useTranslation } from '../contexts/LanguageContext';

/**
 * Non-intrusive update notification banner.
 * Checks GitHub releases on mount (once per app launch) and shows
 * a slim bar at the top if a newer version is available.
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
        gap: 1.5,
        px: 2,
        py: 0.5,
        backgroundColor: '#1a1a2e',
        borderBottom: '1px solid rgba(99, 102, 241, 0.3)',
        minHeight: 36,
        flexShrink: 0,
      }}
    >
      <SystemUpdateAltIcon
        sx={{ fontSize: 16, color: 'rgba(99, 102, 241, 0.9)' }}
      />
      <Typography
        variant="body2"
        sx={{
          color: 'rgba(255, 255, 255, 0.85)',
          fontSize: '0.8rem',
          lineHeight: 1.4,
        }}
      >
        {t('update.available', { version: updateInfo.latestVersion })}
      </Typography>
      <Button
        size="small"
        variant="contained"
        onClick={handleDownload}
        sx={{
          textTransform: 'none',
          fontSize: '0.75rem',
          py: 0.25,
          px: 1.5,
          minHeight: 26,
          backgroundColor: 'rgba(99, 102, 241, 0.85)',
          '&:hover': {
            backgroundColor: 'rgba(99, 102, 241, 1)',
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
          color: 'rgba(255, 255, 255, 0.5)',
          p: 0.5,
          '&:hover': {
            color: 'rgba(255, 255, 255, 0.8)',
          },
        }}
      >
        <CloseIcon sx={{ fontSize: 16 }} />
      </IconButton>
    </Box>
  );
}
