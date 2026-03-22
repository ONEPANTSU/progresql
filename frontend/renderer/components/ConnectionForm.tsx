import React, { useState } from 'react';
import {
  Box,
  TextField,
  Button,
  Typography,
  Alert,
  Paper,
  Grid,
} from '@mui/material';
import { DatabaseConnection } from '../types';
import { createLogger } from '../utils/logger';
import { useTranslation } from '../contexts/LanguageContext';

const log = createLogger('ConnectionForm');

interface ConnectionFormProps {
  onConnect: (config: Omit<DatabaseConnection, 'id' | 'isActive'>) => void;
  isDialog?: boolean;
  initialData?: Omit<DatabaseConnection, 'id' | 'isActive'>;
  isEditMode?: boolean;
}

export default function ConnectionForm({ onConnect, initialData, isEditMode = false }: ConnectionFormProps) {
  const { t } = useTranslation();
  const [formData, setFormData] = useState<Omit<DatabaseConnection, 'id' | 'isActive'>>(
    initialData || {
      host: 'localhost',
      port: 5432,
      username: 'postgres',
      password: '',
      database: 'postgres',
      connectionName: 'My Database',
    }
  );

  const [errors, setErrors] = useState<Partial<DatabaseConnection>>({});
  const [isConnecting, setIsConnecting] = useState(false);

  const validateForm = (): boolean => {
    const newErrors: Partial<DatabaseConnection> = {};

    if (!formData.host.trim()) {
      newErrors.host = 'Host is required';
    }

    // Ensure port is a number before validation
    const portNumber = Number(formData.port);
    if (
      !formData.port ||
      isNaN(portNumber) ||
      portNumber <= 0 ||
      portNumber > 65535
    ) {
      // Assign error to a separate error field, not to port (which is number)
      (newErrors as any).portError = 'Port must be between 1 and 65535';
    }

    if (!formData.username.trim()) {
      newErrors.username = 'Username is required';
    }

    if (!formData.database.trim()) {
      newErrors.database = 'Database name is required';
    }

    if (!formData.connectionName.trim()) {
      newErrors.connectionName = 'Connection name is required';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    log.debug('Form submitted');

    if (!validateForm()) {
      log.debug('Validation failed');
      return;
    }

    setIsConnecting(true);
    try {
      await onConnect(formData);
      log.debug('onConnect completed');
    } catch (error) {
      log.error('Error in handleSubmit:', error);
    } finally {
      setIsConnecting(false);
    }
  };

  const handleInputChange = (field: keyof DatabaseConnection, value: string | number) => {
    setFormData(prev => ({ ...prev, [field]: value }));

    // Clear error when user starts typing
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: undefined }));
    }
  };

  return (
    <Box component="form" onSubmit={handleSubmit} sx={{ mt: 2 }}>
      <Grid container spacing={3}>
        <Grid item xs={12}>
          <TextField
            fullWidth
            label={t('connection.name')}
            value={formData.connectionName}
            onChange={(e) => handleInputChange('connectionName', e.target.value)}
            error={!!errors.connectionName}
            helperText={errors.connectionName}
            placeholder="e.g., My Database"
            variant="outlined"
          />
        </Grid>

        <Grid item xs={12} sm={6}>
          <TextField
            fullWidth
            label={t('connection.host')}
            value={formData.host}
            onChange={(e) => handleInputChange('host', e.target.value)}
            error={!!errors.host}
            helperText={errors.host}
            placeholder="localhost"
            variant="outlined"
          />
        </Grid>

        <Grid item xs={12} sm={6}>
          <TextField
            fullWidth
            label={t('connection.port')}
            type="number"
            value={formData.port}
            onChange={(e) => handleInputChange('port', parseInt(e.target.value) || 0)}
            error={!!(errors as any).portError}
            helperText={(errors as any).portError}
            placeholder="5432"
            variant="outlined"
            inputProps={{ min: 1, max: 65535 }}
          />
        </Grid>

        <Grid item xs={12} sm={6}>
          <TextField
            fullWidth
            label={t('connection.username')}
            value={formData.username}
            onChange={(e) => handleInputChange('username', e.target.value)}
            error={!!errors.username}
            helperText={errors.username}
            placeholder="postgres"
            variant="outlined"
          />
        </Grid>

        <Grid item xs={12} sm={6}>
          <TextField
            fullWidth
            label={t('connection.password')}
            type="password"
            value={formData.password}
            onChange={(e) => handleInputChange('password', e.target.value)}
            placeholder={t('connection.passwordPlaceholder')}
            variant="outlined"
          />
        </Grid>

        <Grid item xs={12}>
          <TextField
            fullWidth
            label={t('connection.database')}
            value={formData.database}
            onChange={(e) => handleInputChange('database', e.target.value)}
            error={!!errors.database}
            helperText={errors.database}
            placeholder="postgres"
            variant="outlined"
          />
        </Grid>

        <Grid item xs={12}>
          <Button
            type="submit"
            fullWidth
            variant="contained"
            size="large"
            disabled={isConnecting}
            sx={{
              mt: 2,
              background: 'linear-gradient(135deg, #6366f1, #8b5cf6, #7c3aed)',
              '&:hover': { background: 'linear-gradient(135deg, #4f46e5, #7c3aed, #6d28d9)' },
              '&.Mui-disabled': { background: 'linear-gradient(135deg, #a5b4fc, #c4b5fd)', color: 'rgba(255,255,255,0.7)' },
            }}
          >
{isConnecting ? (isEditMode ? t('connection.updating') : t('connection.connecting')) : (isEditMode ? t('connection.update') : t('connection.connect'))}
          </Button>
        </Grid>
      </Grid>
    </Box>
  );
}
