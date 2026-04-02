import React, { createContext, useContext, useReducer, useCallback, useEffect, useRef } from 'react';
import { Snackbar, AlertColor, Box, Typography, Slide } from '@mui/material';

interface Notification {
  id: string;
  message: string;
  severity: AlertColor;
  duration?: number;
}

interface NotificationContextValue {
  showNotification: (message: string, severity?: AlertColor, duration?: number) => void;
  showSuccess: (message: string) => void;
  showError: (message: string) => void;
  showInfo: (message: string) => void;
  showWarning: (message: string) => void;
}

interface NotificationState {
  queue: Notification[];
  current: Notification | null;
}

type NotificationAction =
  | { type: 'ENQUEUE'; notification: Notification }
  | { type: 'DISMISS' }
  | { type: 'SHOW_NEXT' };

function notificationReducer(state: NotificationState, action: NotificationAction): NotificationState {
  switch (action.type) {
    case 'ENQUEUE': {
      if (state.current === null) {
        return { ...state, current: action.notification };
      }
      return { ...state, queue: [...state.queue, action.notification] };
    }
    case 'DISMISS': {
      return { ...state, current: null };
    }
    case 'SHOW_NEXT': {
      if (state.queue.length === 0) {
        return state;
      }
      const [next, ...rest] = state.queue;
      return { current: next, queue: rest };
    }
    default:
      return state;
  }
}

const NotificationContext = createContext<NotificationContextValue | undefined>(undefined);

let idCounter = 0;

export const NotificationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, dispatch] = useReducer(notificationReducer, { queue: [], current: null });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (state.current === null && state.queue.length > 0) {
      timerRef.current = setTimeout(() => {
        dispatch({ type: 'SHOW_NEXT' });
        timerRef.current = null;
      }, 100);
    }
  }, [state.current, state.queue.length]);

  const showNotification = useCallback((message: string, severity: AlertColor = 'info', duration: number = 3000) => {
    const id = `notif-${++idCounter}`;
    // Defer dispatch to avoid "Cannot update a component while rendering a different component" warning.
    // Without this, calling showNotification from a useEffect that fires during React's commit
    // phase can synchronously update NotificationProvider while another component is rendering.
    queueMicrotask(() => {
      dispatch({ type: 'ENQUEUE', notification: { id, message, severity, duration } });
    });
  }, []);

  const showSuccess = useCallback((message: string) => {
    showNotification(message, 'success');
  }, [showNotification]);

  const showError = useCallback((message: string) => {
    showNotification(message, 'error', 4000);
  }, [showNotification]);

  const showInfo = useCallback((message: string) => {
    showNotification(message, 'info');
  }, [showNotification]);

  const showWarning = useCallback((message: string) => {
    showNotification(message, 'warning');
  }, [showNotification]);

  const handleClose = useCallback(() => {
    dispatch({ type: 'DISMISS' });
  }, []);

  return (
    <NotificationContext.Provider value={{
      showNotification,
      showSuccess,
      showError,
      showInfo,
      showWarning,
    }}>
      {children}

      <Snackbar
        open={!!state.current}
        autoHideDuration={state.current?.duration}
        onClose={handleClose}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        TransitionComponent={Slide}
        TransitionProps={{
          direction: 'left',
        } as any}
        sx={{
          mt: 2,
          '& .MuiSnackbarContent-root': {
            bgcolor: 'transparent',
            boxShadow: 'none',
            p: 0,
          }
        }}
      >
        {state.current ? (
          <Box
            sx={{
              bgcolor: 'background.paper',
              backdropFilter: 'blur(10px)',
              borderRadius: 2,
              p: 2,
              minWidth: 300,
              maxWidth: 400,
              boxShadow: '0 8px 32px rgba(0, 0, 0, 0.2)',
              border: '1px solid',
              borderColor: 'divider',
              animation: 'slideIn 0.3s ease-out',
              '@keyframes slideIn': {
                from: {
                  transform: 'translateX(100%)',
                  opacity: 0,
                },
                to: {
                  transform: 'translateX(0)',
                  opacity: 1,
                },
              },
            }}
          >
            <Typography
              variant="body2"
              sx={{
                color: 'text.primary',
                fontWeight: 500,
                lineHeight: 1.4,
              }}
            >
              {state.current.message}
            </Typography>
          </Box>
        ) : <div />}
      </Snackbar>
    </NotificationContext.Provider>
  );
};

export const useNotifications = (): NotificationContextValue => {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error('useNotifications must be used within a NotificationProvider');
  }
  return context;
};
