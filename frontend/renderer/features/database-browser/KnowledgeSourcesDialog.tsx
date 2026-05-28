import React, { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  Grid,
  IconButton,
  InputLabel,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import {
  Close as CloseIcon,
  CloudSync as SyncIcon,
  Delete as DeleteIcon,
  FactCheck as TestIcon,
  LibraryBooks as KnowledgeIcon,
  Save as SaveIcon,
} from '@mui/icons-material';
import { DatabaseServer, KnowledgeSource, KnowledgeSourceScope } from '@/shared/types';

interface KnowledgeSourcesDialogProps {
  open: boolean;
  connection: DatabaseServer | null;
  onClose: () => void;
  onUpdateSources: (connectionId: string, sources: KnowledgeSource[]) => void;
}

const defaultPermissions = {
  readDocumentation: true,
  useInSqlGeneration: true,
  showCitations: true,
  suggestDocumentationUpdates: false,
  allowManualWriteBack: false,
};

function createEmptySource(): KnowledgeSource {
  return {
    id: `ks-${Date.now()}`,
    type: 'confluence',
    name: 'DBA Documentation',
    enabled: true,
    confluence: {
      baseUrl: '',
      deployment: 'cloud',
      authType: 'api_token',
      email: '',
      token: '',
    },
    scope: { mode: 'spaces', spaceKeys: [] },
    permissions: defaultPermissions,
    limits: {
      maxPages: 200,
      maxPageSizeBytes: 500_000,
      maxChunks: 1000,
    },
    index: { documents: [], chunks: [] },
  };
}

function scopeToFields(scope: KnowledgeSourceScope) {
  if (scope.mode === 'spaces') return { scopeMode: scope.mode, scopeValue: scope.spaceKeys.join(', ') };
  if (scope.mode === 'page_tree') return { scopeMode: scope.mode, scopeValue: scope.rootPageIdOrUrl };
  if (scope.mode === 'cql') return { scopeMode: scope.mode, scopeValue: scope.cql };
  return { scopeMode: scope.mode, scopeValue: scope.pageUrls.join('\n') };
}

function fieldsToScope(mode: KnowledgeSourceScope['mode'], value: string): KnowledgeSourceScope {
  if (mode === 'spaces') {
    return { mode, spaceKeys: value.split(',').map(v => v.trim()).filter(Boolean) };
  }
  if (mode === 'page_tree') return { mode, rootPageIdOrUrl: value.trim() };
  if (mode === 'cql') return { mode, cql: value.trim() };
  return { mode, pageUrls: value.split('\n').map(v => v.trim()).filter(Boolean) };
}

export default function KnowledgeSourcesDialog({
  open,
  connection,
  onClose,
  onUpdateSources,
}: KnowledgeSourcesDialogProps) {
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<{ severity: 'success' | 'error' | 'info'; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  React.useEffect(() => {
    if (!open || !connection) return;
    const next = connection.knowledgeSources || [];
    setSources(next);
    setSelectedId(next[0]?.id || null);
    setStatus(null);
  }, [open, connection]);

  const selected = useMemo(
    () => sources.find(source => source.id === selectedId) || null,
    [sources, selectedId],
  );
  const scopeFields = selected ? scopeToFields(selected.scope) : { scopeMode: 'spaces' as const, scopeValue: '' };

  const updateSelected = (patch: Partial<KnowledgeSource>) => {
    if (!selected) return;
    setSources(prev => prev.map(source => source.id === selected.id ? { ...source, ...patch } : source));
  };

  const updateConfluence = (patch: Partial<NonNullable<KnowledgeSource['confluence']>>) => {
    if (!selected) return;
    updateSelected({ confluence: { ...selected.confluence!, ...patch } });
  };

  const handleAdd = () => {
    const source = createEmptySource();
    setSources(prev => [...prev, source]);
    setSelectedId(source.id);
    setStatus(null);
  };

  const handleDelete = () => {
    if (!selected) return;
    const next = sources.filter(source => source.id !== selected.id);
    setSources(next);
    setSelectedId(next[0]?.id || null);
  };

  const handleSave = () => {
    if (!connection) return;
    onUpdateSources(connection.id, sources);
    onClose();
  };

  const handleTestConnection = async () => {
    if (!selected) return;
    setBusy(true);
    setStatus(null);
    try {
      const result = await window.electronAPI.testKnowledgeSource(selected);
      setStatus(result.success
        ? { severity: 'success', message: result.message || 'Connection successful.' }
        : { severity: 'error', message: result.message || 'Connection failed.' });
    } catch (error) {
      setStatus({ severity: 'error', message: error instanceof Error ? error.message : 'Connection failed.' });
    } finally {
      setBusy(false);
    }
  };

  const handleSync = async () => {
    if (!selected) return;
    setBusy(true);
    setStatus({ severity: 'info', message: 'Syncing matched pages...' });
    try {
      const result = await window.electronAPI.syncKnowledgeSource(selected);
      if (!result.success || !result.index) {
        setStatus({ severity: 'error', message: result.message || 'Sync failed.' });
        return;
      }
      setSources(prev => prev.map(source =>
        source.id === selected.id
          ? { ...source, index: result.index }
          : source
      ));
      setStatus({
        severity: 'success',
        message: `Synced ${result.index.documents.length} page(s), ${result.index.chunks.length} chunk(s).`,
      });
    } catch (error) {
      setStatus({ severity: 'error', message: error instanceof Error ? error.message : 'Sync failed.' });
    } finally {
      setBusy(false);
    }
  };

  const handlePreview = async () => {
    if (!selected) return;
    setBusy(true);
    setStatus({ severity: 'info', message: 'Previewing matched pages...' });
    try {
      const result = await window.electronAPI.previewKnowledgeSource(selected);
      setStatus(result.success
        ? { severity: 'success', message: `Matched ${result.documents?.length || 0} page(s).` }
        : { severity: 'error', message: result.message || 'Preview failed.' });
    } catch (error) {
      setStatus({ severity: 'error', message: error instanceof Error ? error.message : 'Preview failed.' });
    } finally {
      setBusy(false);
    }
  };

  if (!connection) return null;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        Knowledge Sources: {connection.connectionName}
        <IconButton onClick={onClose} size="small"><CloseIcon /></IconButton>
      </DialogTitle>
      <DialogContent sx={{ pt: 2 }}>
        <Grid container spacing={2}>
          <Grid item xs={12} md={4}>
            <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
              <Button startIcon={<KnowledgeIcon />} variant="contained" onClick={handleAdd} fullWidth>
                Add
              </Button>
            </Stack>
            <List dense sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, minHeight: 260 }}>
              {sources.map(source => (
                <ListItemButton
                  key={source.id}
                  selected={source.id === selectedId}
                  onClick={() => setSelectedId(source.id)}
                >
                  <ListItemText
                    primary={source.name || 'Untitled source'}
                    secondary={`${source.type === 'confluence' ? 'Confluence' : source.type} · ${source.enabled ? 'Enabled' : 'Disabled'}`}
                  />
                </ListItemButton>
              ))}
              {sources.length === 0 && (
                <ListItem>
                  <ListItemText primary="No sources yet" secondary="Add Confluence documentation for this connection." />
                </ListItem>
              )}
            </List>
          </Grid>
          <Grid item xs={12} md={8}>
            {!selected ? (
              <Alert severity="info">Add a source to configure documentation for this database connection.</Alert>
            ) : (
              <Stack spacing={2}>
                {status && <Alert severity={status.severity}>{status.message}</Alert>}
                <FormControl fullWidth>
                  <InputLabel>Source type</InputLabel>
                  <Select label="Source type" value={selected.type} onChange={(e) => updateSelected({ type: e.target.value as any })}>
                    <MenuItem value="confluence">Confluence</MenuItem>
                    <MenuItem value="notion" disabled>Notion - coming soon</MenuItem>
                    <MenuItem value="git_markdown" disabled>Git / Markdown - coming soon</MenuItem>
                    <MenuItem value="dbt_docs" disabled>dbt docs - coming soon</MenuItem>
                    <MenuItem value="openmetadata" disabled>OpenMetadata - coming soon</MenuItem>
                  </Select>
                </FormControl>
                <TextField label="Name" value={selected.name} onChange={(e) => updateSelected({ name: e.target.value })} fullWidth />
                <FormControlLabel
                  control={<Checkbox checked={selected.enabled} onChange={(e) => updateSelected({ enabled: e.target.checked })} />}
                  label="Enable for this connection"
                />
                <Divider />
                <TextField label="Base URL" placeholder="https://company.atlassian.net/wiki" value={selected.confluence?.baseUrl || ''} onChange={(e) => updateConfluence({ baseUrl: e.target.value })} fullWidth />
                <FormControl>
                  <Typography variant="subtitle2">Deployment</Typography>
                  <RadioGroup row value={selected.confluence?.deployment || 'cloud'} onChange={(e) => updateConfluence({ deployment: e.target.value as any })}>
                    <FormControlLabel value="cloud" control={<Radio />} label="Confluence Cloud" />
                    <FormControlLabel value="data_center" control={<Radio />} label="Data Center / Server" />
                  </RadioGroup>
                </FormControl>
                <FormControl>
                  <Typography variant="subtitle2">Auth</Typography>
                  <RadioGroup row value={selected.confluence?.authType || 'api_token'} onChange={(e) => updateConfluence({ authType: e.target.value as any })}>
                    <FormControlLabel value="api_token" control={<Radio />} label="API token" />
                    <FormControlLabel value="pat" control={<Radio />} label="Personal Access Token" />
                  </RadioGroup>
                </FormControl>
                {selected.confluence?.deployment === 'cloud' && selected.confluence?.authType === 'api_token' && (
                  <TextField label="Email" type="email" value={selected.confluence?.email || ''} onChange={(e) => updateConfluence({ email: e.target.value })} fullWidth />
                )}
                <TextField label="Token" type="password" value={selected.confluence?.token || ''} onChange={(e) => updateConfluence({ token: e.target.value })} fullWidth />
                <Divider />
                <FormControl fullWidth>
                  <InputLabel>Scope</InputLabel>
                  <Select
                    label="Scope"
                    value={scopeFields.scopeMode}
                    onChange={(e) => updateSelected({ scope: fieldsToScope(e.target.value as KnowledgeSourceScope['mode'], '') })}
                  >
                    <MenuItem value="spaces">Specific spaces</MenuItem>
                    <MenuItem value="page_tree">Page tree</MenuItem>
                    <MenuItem value="cql">CQL filter</MenuItem>
                    <MenuItem value="manual_pages" disabled>Manual pages - coming soon</MenuItem>
                  </Select>
                </FormControl>
                <TextField
                  label={scopeFields.scopeMode === 'spaces' ? 'Space keys' : scopeFields.scopeMode === 'page_tree' ? 'Root page URL or ID' : 'CQL'}
                  placeholder={scopeFields.scopeMode === 'spaces' ? 'DBA, DATA' : scopeFields.scopeMode === 'cql' ? 'type = page AND space = "DBA" AND label = "database"' : '123456789 or https://...'}
                  value={scopeFields.scopeValue}
                  onChange={(e) => updateSelected({ scope: fieldsToScope(scopeFields.scopeMode, e.target.value) })}
                  fullWidth
                  multiline={scopeFields.scopeMode === 'cql'}
                />
                <Divider />
                <Typography variant="subtitle2">Permissions</Typography>
                <Grid container>
                  <Grid item xs={12} sm={6}>
                    <FormControlLabel disabled control={<Checkbox checked />} label="Read documentation" />
                    <FormControlLabel control={<Checkbox checked={selected.permissions.useInSqlGeneration} onChange={(e) => updateSelected({ permissions: { ...selected.permissions, useInSqlGeneration: e.target.checked } })} />} label="Use in SQL generation" />
                    <FormControlLabel control={<Checkbox checked={selected.permissions.showCitations} onChange={(e) => updateSelected({ permissions: { ...selected.permissions, showCitations: e.target.checked } })} />} label="Show citations in answers" />
                  </Grid>
                  <Grid item xs={12} sm={6}>
                    <FormControlLabel disabled control={<Checkbox checked={false} />} label="Suggest documentation updates" />
                    <FormControlLabel disabled control={<Checkbox checked={false} />} label="Allow manual write-back" />
                  </Grid>
                </Grid>
                <Stack direction="row" spacing={1}>
                  <Button startIcon={<TestIcon />} variant="outlined" onClick={handleTestConnection} disabled={busy}>Test connection</Button>
                  <Button startIcon={<KnowledgeIcon />} variant="outlined" onClick={handlePreview} disabled={busy}>Preview matched pages</Button>
                  <Button startIcon={<SyncIcon />} variant="outlined" onClick={handleSync} disabled={busy}>Sync now</Button>
                  <Button startIcon={<DeleteIcon />} color="error" variant="outlined" onClick={handleDelete} disabled={busy}>Delete</Button>
                </Stack>
              </Stack>
            )}
          </Grid>
        </Grid>
      </DialogContent>
      <DialogActions sx={{ p: 2 }}>
        <Button onClick={onClose}>Cancel</Button>
        <Button startIcon={<SaveIcon />} variant="contained" onClick={handleSave}>Save</Button>
      </DialogActions>
    </Dialog>
  );
}
