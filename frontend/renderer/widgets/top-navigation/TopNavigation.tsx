import React, { useState } from 'react';
import {
  AppBar,
  Toolbar,
  Typography,
  Box,
  IconButton,
  Avatar,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  Divider,
  Chip,
} from '@mui/material';
import {
  Dashboard as DashboardIcon,
  Chat as ChatIcon,
  Logout as LogoutIcon,
  AccountCircle as AccountIcon,
  DarkMode as DarkModeIcon,
  LightMode as LightModeIcon,
} from '@mui/icons-material';
import { AuthUser } from '@/shared/types';
import Logo from '@/shared/ui/Logo';
import QuotaIndicator from '@/features/billing/QuotaIndicator';
import { createLogger } from '@/shared/lib/logger';
import { useTheme } from '@/features/settings/ThemeContext';
import { useTranslation } from '@/shared/i18n/LanguageContext';
import { useAgent } from '@/features/agent-chat/AgentContext';

const log = createLogger('TopNavigation');

interface TopNavigationProps {
  currentUser: AuthUser | null;
  isChatOpen: boolean;
  onToggleChat: () => void;
  onLogout: () => void;
  isRestoringConnections?: boolean;
  activeConnection?: string | null;
  connectionError?: string | null;
}

export default function TopNavigation({
  currentUser,
  isChatOpen,
  onToggleChat,
  onLogout,
  isRestoringConnections = false,
  activeConnection,
  connectionError,
}: TopNavigationProps) {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const { actualTheme, setThemeMode } = useTheme();
  const { t } = useTranslation();
  const agent = useAgent();

  const handleToggleTheme = () => {
    setThemeMode(actualTheme === 'dark' ? 'light' : 'dark');
  };

  const handleProfileMenuOpen = (event: React.MouseEvent<HTMLElement>) => {
    log.debug('Profile menu clicked');
    setAnchorEl(event.currentTarget);
  };

  const handleProfileMenuClose = () => {
    setAnchorEl(null);
  };


  return (
    <AppBar
      position="static"
      elevation={0}
      sx={{
        backgroundColor: 'background.paper',
        borderBottom: '1px solid',
        borderColor: 'divider',
      }}
    >
      <Toolbar sx={{ px: 2, py: 0.5, display: 'flex', justifyContent: 'space-between', width: '100%' }}>
        {/* Logo */}
        <Box sx={{ display: 'flex', alignItems: 'center' }}>
          <Box sx={{ mr: 1.5 }}>
            <Logo size={32} />
          </Box>
          <Typography
            variant="subtitle1"
            sx={{
              color: 'text.primary',
              fontWeight: 700,
            }}
          >
            ProgreSQL
          </Typography>
        </Box>


        {/* Right Side Actions */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {/* Status Indicators */}
          {isRestoringConnections && (
            <Chip
              label={t('nav.restoringConnections')}
              size="small"
              sx={{
                backgroundColor: 'primary.light',
                color: 'primary.main',
                fontWeight: 500,
              }}
            />
          )}

          {connectionError && (
            <Chip
              label={t('nav.connectionError')}
              size="small"
              sx={{
                backgroundColor: 'error.light',
                color: 'error.main',
                fontWeight: 500,
              }}
            />
          )}




          {/* Quota Indicator */}
          {currentUser && agent.usage && (
            <QuotaIndicator usage={agent.usage} compact />
          )}

          {/* Theme Toggle */}
          <IconButton
            onClick={handleToggleTheme}
            aria-label={actualTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            title={actualTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            sx={{
              color: 'text.secondary',
              borderRadius: 1,
              transition: 'all 0.2s ease-in-out',
              '&:hover': {
                bgcolor: 'action.hover',
              },
            }}
          >
            {actualTheme === 'dark' ? <LightModeIcon /> : <DarkModeIcon />}
          </IconButton>

          {/* AI Assistant Toggle */}
          <IconButton
            onClick={onToggleChat}
            aria-label={isChatOpen ? 'Close AI assistant' : 'Open AI assistant'}
            sx={{
              color: isChatOpen ? 'primary.main' : 'text.secondary',
              backgroundColor: isChatOpen ? 'primary.light' : 'transparent',
              borderRadius: 1,
              transition: 'all 0.2s ease-in-out',
              '&:hover': {
                bgcolor: 'action.hover',
              }
            }}
          >
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              {/* Chat bubble */}
              <path
                d="M20 2H4C2.9 2 2 2.9 2 4V22L6 18H20C21.1 18 22 17.1 22 16V4C22 2.9 21.1 2 20 2Z"
                fill="currentColor"
                stroke="currentColor"
                strokeWidth="1.5"
              />

              {/* Chat lines */}
              <line
                x1="7"
                y1="8"
                x2="17"
                y2="8"
                stroke="white"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
              <line
                x1="7"
                y1="11"
                x2="15"
                y2="11"
                stroke="white"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
              <line
                x1="7"
                y1="14"
                x2="13"
                y2="14"
                stroke="white"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </IconButton>


          {/* User Profile */}
          {currentUser && (
            <IconButton
              onClick={handleProfileMenuOpen}
              aria-label="User profile menu"
              aria-controls={anchorEl ? 'profile-menu' : undefined}
              aria-haspopup="true"
              aria-expanded={anchorEl ? 'true' : undefined}
              sx={{ p: 0, ml: 1 }}
            >
              <Avatar
                sx={{
                  width: 36,
                  height: 36,
                  backgroundColor: 'primary.main',
                  color: 'white',
                  fontWeight: 600,
                }}
              >
                {currentUser?.name ? currentUser.name[0].toUpperCase() : currentUser?.email[0].toUpperCase()}
              </Avatar>
            </IconButton>
          )}
        </Box>
      </Toolbar>

      {/* Profile Menu */}
      {currentUser && (
        <Menu
          id="profile-menu"
          anchorEl={anchorEl}
          open={Boolean(anchorEl)}
          onClose={handleProfileMenuClose}
          PaperProps={{
            sx: {
              mt: 1,
              minWidth: 200,
              borderRadius: 2,
            },
          }}
        >
          <Box sx={{ px: 2, py: 1 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 600, color: 'text.primary' }}>
              {currentUser?.name || 'User'}
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {currentUser?.email}
            </Typography>
          </Box>
        <Divider />
        <MenuItem onClick={handleProfileMenuClose}>
          <ListItemIcon>
            <AccountIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Profile</ListItemText>
        </MenuItem>
        <Divider />
        <MenuItem onClick={() => { handleProfileMenuClose(); onLogout(); }}>
          <ListItemIcon>
            <LogoutIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Logout</ListItemText>
        </MenuItem>
        </Menu>
      )}

    </AppBar>
  );
}
