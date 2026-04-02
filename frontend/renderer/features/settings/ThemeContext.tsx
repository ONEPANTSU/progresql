import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { createTheme, ThemeProvider as MuiThemeProvider } from '@mui/material/styles';

export type ThemeMode = 'light' | 'dark' | 'system';

interface ThemeContextType {
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  actualTheme: 'light' | 'dark';
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const sharedTypography = {
  fontFamily: '"Inter", "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  body1: {
    fontSize: '0.875rem',
    lineHeight: 1.5,
  },
  body2: {
    fontSize: '0.8125rem',
    lineHeight: 1.5,
  },
  subtitle1: {
    fontWeight: 600,
    fontSize: '0.875rem',
  },
  subtitle2: {
    fontWeight: 600,
    fontSize: '0.8125rem',
  },
  h4: {
    fontWeight: 700,
    fontSize: '1.25rem',
  },
  h5: {
    fontWeight: 600,
    fontSize: '1.125rem',
  },
  h6: {
    fontWeight: 600,
    fontSize: '0.9375rem',
  },
  caption: {
    fontSize: '0.6875rem',
  },
  button: {
    fontWeight: 500,
    fontSize: '0.8125rem',
  },
};

const lightTheme = createTheme({
  palette: {
    mode: 'light',
    primary: {
      main: '#6366f1',
      light: '#818cf8',
      dark: '#4f46e5',
    },
    secondary: {
      main: '#6b7280',
    },
    background: {
      default: '#f0f2f5',
      paper: '#ffffff',
    },
    text: {
      primary: '#1a1d23',
      secondary: '#6b7280',
    },
    grey: {
      50: '#f9fafb',
      100: '#f0f2f5',
      200: '#e5e7eb',
      300: '#d1d5db',
      400: '#9ca3af',
      500: '#6b7280',
      600: '#4b5563',
      700: '#374151',
      800: '#1f2937',
      900: '#111827',
    },
    divider: '#e5e7eb',
    error: {
      main: '#dc2626',
    },
    warning: {
      main: '#d97706',
    },
    success: {
      main: '#16a34a',
    },
    info: {
      main: '#6366f1',
    },
  },
  typography: sharedTypography,
  shape: {
    borderRadius: 6,
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        '*': {
          '&::-webkit-scrollbar': {
            width: '8px',
            height: '8px',
          },
          '&::-webkit-scrollbar-track': {
            background: 'transparent',
          },
          '&::-webkit-scrollbar-thumb': {
            background: '#c1c5cd',
            borderRadius: '4px',
            '&:hover': {
              background: '#9ca3af',
            },
          },
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
          borderRadius: 6,
        },
      },
    },
    MuiAppBar: {
      styleOverrides: {
        root: {
          backgroundColor: '#ffffff',
          color: '#1a1d23',
          boxShadow: 'none',
          borderBottom: '1px solid #e5e7eb',
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: 'none' as const,
          fontWeight: 500,
          borderRadius: 4,
        },
        contained: {
          boxShadow: '0 1px 2px rgba(0,0,0,0.08)',
          '&:hover': {
            boxShadow: '0 2px 4px rgba(0,0,0,0.12)',
          },
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          borderRadius: 6,
          boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
          border: '1px solid #e5e7eb',
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: 4,
          fontWeight: 500,
        },
        sizeSmall: {
          height: 22,
        },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          borderRadius: 4,
        },
      },
    },
    MuiTextField: {
      styleOverrides: {
        root: {
          '& .MuiOutlinedInput-root': {
            borderRadius: 4,
          },
        },
      },
    },
    MuiDrawer: {
      styleOverrides: {
        paper: {
          borderLeft: '1px solid #e5e7eb',
        },
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          backgroundColor: '#1f2937',
          color: '#f9fafb',
          fontSize: '0.75rem',
          borderRadius: 4,
          padding: '4px 8px',
        },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        root: {
          borderColor: '#e5e7eb',
          fontSize: '0.8125rem',
          paddingTop: 6,
          paddingBottom: 6,
        },
      },
    },
    MuiDivider: {
      styleOverrides: {
        root: {
          borderColor: '#e5e7eb',
        },
      },
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          borderRadius: 4,
          '&:hover': {
            backgroundColor: '#f0f2f5',
          },
        },
      },
    },
  },
});

const darkTheme = createTheme({
  palette: {
    mode: 'dark',
    primary: {
      main: '#818cf8',
      light: '#a5b4fc',
      dark: '#6366f1',
    },
    secondary: {
      main: '#9ca3af',
    },
    background: {
      default: '#1a1d23',
      paper: '#22262e',
    },
    text: {
      primary: '#e5e7eb',
      secondary: '#9ca3af',
    },
    grey: {
      50: '#1a1d23',
      100: '#22262e',
      200: '#2d333b',
      300: '#3d444e',
      400: '#6b7280',
      500: '#9ca3af',
      600: '#d1d5db',
      700: '#e5e7eb',
      800: '#f0f2f5',
      900: '#f9fafb',
    },
    divider: '#2d333b',
    error: {
      main: '#f87171',
    },
    warning: {
      main: '#fbbf24',
    },
    success: {
      main: '#4ade80',
    },
    info: {
      main: '#818cf8',
    },
  },
  typography: sharedTypography,
  shape: {
    borderRadius: 6,
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        '*': {
          '&::-webkit-scrollbar': {
            width: '8px',
            height: '8px',
          },
          '&::-webkit-scrollbar-track': {
            background: '#1a1d23',
          },
          '&::-webkit-scrollbar-thumb': {
            background: '#3d444e',
            borderRadius: '4px',
            '&:hover': {
              background: '#4b5563',
            },
          },
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
          borderRadius: 6,
        },
      },
    },
    MuiAppBar: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          backgroundColor: '#22262e',
          color: '#e5e7eb',
          boxShadow: 'none',
          borderBottom: '1px solid #2d333b',
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: 'none' as const,
          fontWeight: 500,
          borderRadius: 4,
        },
        contained: {
          boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
          '&:hover': {
            boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
          },
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          borderRadius: 6,
          boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
          border: '1px solid #2d333b',
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: 4,
          fontWeight: 500,
        },
        sizeSmall: {
          height: 22,
        },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          borderRadius: 4,
        },
      },
    },
    MuiTextField: {
      styleOverrides: {
        root: {
          '& .MuiOutlinedInput-root': {
            borderRadius: 4,
          },
        },
      },
    },
    MuiDrawer: {
      styleOverrides: {
        paper: {
          borderLeft: '1px solid #2d333b',
        },
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          backgroundColor: '#1f2937',
          color: '#f9fafb',
          fontSize: '0.75rem',
          borderRadius: 4,
          padding: '4px 8px',
        },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        root: {
          borderColor: '#2d333b',
          fontSize: '0.8125rem',
          paddingTop: 6,
          paddingBottom: 6,
        },
      },
    },
    MuiDivider: {
      styleOverrides: {
        root: {
          borderColor: '#2d333b',
        },
      },
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          borderRadius: 4,
          '&:hover': {
            backgroundColor: '#2d333b',
          },
        },
      },
    },
  },
});

export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  const [themeMode, setThemeMode] = useState<ThemeMode>('system');
  const [actualTheme, setActualTheme] = useState<'light' | 'dark'>('light');

  // Load theme from localStorage on mount
  useEffect(() => {
    if (typeof window === 'undefined' || !window.localStorage) {
      return;
    }
    const savedTheme = localStorage.getItem('theme-mode') as ThemeMode;
    if (savedTheme && ['light', 'dark', 'system'].includes(savedTheme)) {
      setThemeMode(savedTheme);
    }
  }, []);

  // Update actual theme based on mode and system preference
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const updateActualTheme = () => {
      if (themeMode === 'system') {
        const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        setActualTheme(systemPrefersDark ? 'dark' : 'light');
      } else {
        setActualTheme(themeMode);
      }
    };

    updateActualTheme();

    // Listen for system theme changes
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      if (themeMode === 'system') {
        updateActualTheme();
      }
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [themeMode]);

  // Save theme to localStorage
  const handleSetThemeMode = (mode: ThemeMode) => {
    setThemeMode(mode);
    if (typeof window !== 'undefined' && window.localStorage) {
      localStorage.setItem('theme-mode', mode);
    }
  };

  const currentTheme = actualTheme === 'dark' ? darkTheme : lightTheme;

  return (
    <ThemeContext.Provider value={{ themeMode, setThemeMode: handleSetThemeMode, actualTheme }}>
      <MuiThemeProvider theme={currentTheme}>
        {children}
      </MuiThemeProvider>
    </ThemeContext.Provider>
  );
};

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};
