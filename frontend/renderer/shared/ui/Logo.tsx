import React from 'react';
import { Box } from '@mui/material';
import { createLogger } from '@/shared/lib/logger';

const log = createLogger('Logo');

interface LogoProps {
  size?: number;
}

export default function Logo({ size = 48 }: LogoProps) {
  const [imageError, setImageError] = React.useState(false);
  const [iconSrc, setIconSrc] = React.useState<string>(() => {
    try {
      const api = (window as any).electronAPI;
      if (api?.getAssetPath) {
        return api.getAssetPath('icon.png');
      }
    } catch (e) {}
    return './assets/icon.png';
  });

  React.useEffect(() => {
    try {
      const api = (window as any).electronAPI;
      if (api?.getAssetPath) {
        setIconSrc(api.getAssetPath('icon.png'));
        log.debug('Using absolute asset path');
      }
    } catch (e) {
      log.debug('electronAPI not available, using relative path');
    }
  }, []);

  if (imageError) {
    return (
      <Box
        sx={{
          width: size,
          height: size,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
          borderRadius: 1,
          color: 'white',
          fontWeight: 'bold',
          fontSize: `${size * 0.3}px`,
        }}
      >
        P
      </Box>
    );
  }

  return (
    <Box
      sx={{
        width: size,
        height: size,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <img
        src={iconSrc}
        alt="ProgreSQL Logo"
        width={size}
        height={size}
        style={{
          borderRadius: '8px',
        }}
        onError={() => {
          log.debug('Image failed to load, showing fallback');
          setImageError(true);
        }}
      />
    </Box>
  );
}
