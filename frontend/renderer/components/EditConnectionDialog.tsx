import React from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  IconButton,
} from '@mui/material';
import { Close as CloseIcon } from '@mui/icons-material';
import { DatabaseServer } from '../types';
import ConnectionForm from './ConnectionForm';

interface EditConnectionDialogProps {
  open: boolean;
  connection: DatabaseServer | null;
  onClose: () => void;
  onUpdate: (connectionId: string, updatedData: Omit<DatabaseServer, 'id' | 'databases' | 'isActive'>) => void;
}

export default function EditConnectionDialog({
  open,
  connection,
  onClose,
  onUpdate,
}: EditConnectionDialogProps) {
  const handleUpdate = async (updatedData: Omit<DatabaseServer, 'id' | 'databases' | 'isActive'>) => {
    if (connection) {
      onUpdate(connection.id, updatedData);
      onClose();
    }
  };

  if (!connection) return null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      PaperProps={{
        sx: {
          minHeight: '60vh',
        },
      }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        Edit Connection: {connection.connectionName}
        <IconButton onClick={onClose} size="small">
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      
      <DialogContent sx={{ pt: 2 }}>
        <ConnectionForm
          onConnect={handleUpdate}
          initialData={{
            host: connection.host,
            port: connection.port,
            username: connection.username,
            password: connection.password,
            database: connection.database,
            connectionName: connection.connectionName,
          }}
          isEditMode={true}
        />
      </DialogContent>
      
      <DialogActions sx={{ p: 2, pt: 0 }}>
        <Button onClick={onClose} variant="outlined">
          Cancel
        </Button>
      </DialogActions>
    </Dialog>
  );
}
