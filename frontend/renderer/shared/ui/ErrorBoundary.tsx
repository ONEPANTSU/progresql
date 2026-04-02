import React, { Component, ErrorInfo, ReactNode } from 'react';
import { Box, Typography, Button } from '@mui/material';
import { Refresh as RetryIcon, ErrorOutline as ErrorIcon } from '@mui/icons-material';
import { useTranslation } from '@/shared/i18n/LanguageContext';

interface ErrorFallbackProps {
  panelName?: string;
  error: Error | null;
  onRetry: () => void;
}

function ErrorFallback({ panelName, error, onRetry }: ErrorFallbackProps) {
  const { t } = useTranslation();

  return (
    <Box
      role="alert"
      aria-label={`${panelName || 'Component'} error`}
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        p: 3,
        textAlign: 'center',
        backgroundColor: 'background.paper',
      }}
    >
      <ErrorIcon sx={{ fontSize: 48, color: 'error.main', mb: 2 }} />
      <Typography variant="h6" gutterBottom>
        {panelName ? t('error.crashed', { panel: panelName }) : t('error.somethingWrong')}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2, maxWidth: 300 }}>
        {error?.message || t('error.unexpected')}
      </Typography>
      <Button
        variant="outlined"
        startIcon={<RetryIcon />}
        onClick={onRetry}
      >
        {t('error.retry')}
      </Button>
    </Box>
  );
}

interface ErrorBoundaryProps {
  children: ReactNode;
  panelName?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error(`[ErrorBoundary] ${this.props.panelName || 'Component'} crashed:`, error, errorInfo);
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <ErrorFallback
          panelName={this.props.panelName}
          error={this.state.error}
          onRetry={this.handleRetry}
        />
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
