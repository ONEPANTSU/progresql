import React, { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
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

const gradientButtonSx = {
  background: 'linear-gradient(135deg, #6366f1, #8b5cf6, #7c3aed)',
  boxShadow: '0 10px 26px rgba(99, 102, 241, 0.28)',
  color: '#fff',
  '&:hover': {
    background: 'linear-gradient(135deg, #4f46e5, #7c3aed, #6d28d9)',
    boxShadow: '0 12px 30px rgba(99, 102, 241, 0.34)',
  },
  '&.Mui-disabled': {
    background: 'rgba(148, 163, 184, 0.18)',
    color: 'text.disabled',
    boxShadow: 'none',
  },
} as const;

const compactFieldSx = {
  '& .MuiOutlinedInput-root': {
    borderRadius: 1,
    minHeight: 46,
  },
  '& .MuiInputLabel-root': {
    fontSize: '0.8125rem',
  },
} as const;

const sectionTitleSx = {
  fontSize: '0.72rem',
  fontWeight: 700,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'text.secondary',
} as const;

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
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="lg"
      fullWidth
      PaperProps={{
        sx: {
          height: { xs: '94vh', md: '82vh' },
          maxHeight: 760,
          overflow: 'hidden',
          borderRadius: 2,
        },
      }}
    >
      <DialogTitle sx={{ px: 2, py: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
          <KnowledgeIcon sx={{ fontSize: 20, color: 'primary.main' }} />
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 700, lineHeight: 1.2 }}>
              Knowledge Sources
            </Typography>
            <Typography variant="caption" color="text.secondary" noWrap>
              {connection.connectionName}
            </Typography>
          </Box>
          <IconButton onClick={onClose} size="small" aria-label="Close knowledge sources">
            <CloseIcon />
          </IconButton>
        </Box>
      </DialogTitle>

      <DialogContent sx={{ p: 0, display: 'flex', minHeight: 0 }}>
        <Box
          sx={{
            width: { xs: 230, md: 280 },
            flexShrink: 0,
            borderRight: '1px solid',
            borderColor: 'divider',
            p: 1.5,
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
            bgcolor: 'rgba(255,255,255,0.015)',
          }}
        >
          <Button startIcon={<KnowledgeIcon />} variant="contained" onClick={handleAdd} fullWidth sx={gradientButtonSx}>
            Add source
          </Button>
          <List dense disablePadding sx={{ overflowY: 'auto', flex: 1, pr: 0.5 }}>
            {sources.map(source => {
              const syncedPages = source.index?.documents.length || 0;
              return (
                <ListItemButton
                  key={source.id}
                  selected={source.id === selectedId}
                  onClick={() => setSelectedId(source.id)}
                  sx={{
                    mb: 0.75,
                    borderRadius: 1,
                    minHeight: 58,
                    alignItems: 'flex-start',
                    border: '1px solid',
                    borderColor: source.id === selectedId ? 'primary.main' : 'transparent',
                    bgcolor: source.id === selectedId ? 'rgba(99,102,241,0.16)' : 'transparent',
                    '&:hover': { bgcolor: 'action.hover' },
                  }}
                >
                  <ListItemText
                    primary={source.name || 'Untitled source'}
                    secondary={`${source.type === 'confluence' ? 'Confluence' : source.type} · ${source.enabled ? 'Enabled' : 'Disabled'}${syncedPages ? ` · ${syncedPages} pages` : ''}`}
                    primaryTypographyProps={{ sx: { fontSize: '0.84rem', fontWeight: 600, lineHeight: 1.25 } }}
                    secondaryTypographyProps={{ sx: { fontSize: '0.72rem', lineHeight: 1.25, mt: 0.25 } }}
                  />
                </ListItemButton>
              );
            })}
            {sources.length === 0 && (
              <Box sx={{ px: 1, py: 2, border: '1px dashed', borderColor: 'divider', borderRadius: 1 }}>
                <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>No sources yet</Typography>
                <Typography variant="caption" color="text.secondary">
                  Add Confluence docs scoped to this database.
                </Typography>
              </Box>
            )}
          </List>
        </Box>

        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: { xs: 2, md: 2.5 }, py: 2 }}>
            {!selected ? (
              <Box sx={{ maxWidth: 540 }}>
                <Alert severity="info" sx={{ mb: 2 }}>
                  Add a source to configure documentation for this database connection.
                </Alert>
                <Button startIcon={<KnowledgeIcon />} variant="contained" onClick={handleAdd} sx={gradientButtonSx}>
                  Add Confluence source
                </Button>
              </Box>
            ) : (
              <Stack spacing={2.25}>
                {status && <Alert severity={status.severity}>{status.message}</Alert>}

                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
                  <Box>
                    <Typography sx={sectionTitleSx}>Source</Typography>
                    <Stack direction="row" spacing={1} sx={{ mt: 0.75 }}>
                      <Chip size="small" label="Confluence" color="primary" variant="outlined" />
                      <Chip size="small" label={selected.enabled ? 'Enabled' : 'Disabled'} variant="outlined" />
                    </Stack>
                  </Box>
                  <FormControlLabel
                    sx={{ mr: 0 }}
                    control={<Checkbox checked={selected.enabled} onChange={(e) => updateSelected({ enabled: e.target.checked })} />}
                    label="Enable"
                  />
                </Box>

                <Grid container spacing={1.5}>
                  <Grid item xs={12} md={5}>
                    <FormControl fullWidth sx={compactFieldSx}>
                      <InputLabel>Source type</InputLabel>
                      <Select label="Source type" value={selected.type} onChange={(e) => updateSelected({ type: e.target.value as any })}>
                        <MenuItem value="confluence">Confluence</MenuItem>
                        <MenuItem value="notion" disabled>Notion - coming soon</MenuItem>
                        <MenuItem value="git_markdown" disabled>Git / Markdown - coming soon</MenuItem>
                        <MenuItem value="dbt_docs" disabled>dbt docs - coming soon</MenuItem>
                        <MenuItem value="openmetadata" disabled>OpenMetadata - coming soon</MenuItem>
                      </Select>
                    </FormControl>
                  </Grid>
                  <Grid item xs={12} md={7}>
                    <TextField label="Name" value={selected.name} onChange={(e) => updateSelected({ name: e.target.value })} fullWidth sx={compactFieldSx} />
                  </Grid>
                </Grid>

                <Divider />
                <Typography sx={sectionTitleSx}>Connection</Typography>
                <TextField label="Base URL" placeholder="https://company.atlassian.net/wiki" value={selected.confluence?.baseUrl || ''} onChange={(e) => updateConfluence({ baseUrl: e.target.value })} fullWidth sx={compactFieldSx} />
                <Grid container spacing={1.5}>
                  <Grid item xs={12} md={6}>
                    <FormControl fullWidth>
                      <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5 }}>Deployment</Typography>
                      <RadioGroup row value={selected.confluence?.deployment || 'cloud'} onChange={(e) => updateConfluence({ deployment: e.target.value as any })}>
                        <FormControlLabel value="cloud" control={<Radio size="small" />} label="Cloud" />
                        <FormControlLabel value="data_center" control={<Radio size="small" />} label="Data Center / Server" />
                      </RadioGroup>
                    </FormControl>
                  </Grid>
                  <Grid item xs={12} md={6}>
                    <FormControl fullWidth>
                      <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5 }}>Auth</Typography>
                      <RadioGroup row value={selected.confluence?.authType || 'api_token'} onChange={(e) => updateConfluence({ authType: e.target.value as any })}>
                        <FormControlLabel value="api_token" control={<Radio size="small" />} label="API token" />
                        <FormControlLabel value="pat" control={<Radio size="small" />} label="PAT" />
                      </RadioGroup>
                    </FormControl>
                  </Grid>
                </Grid>
                <Grid container spacing={1.5}>
                  {selected.confluence?.deployment === 'cloud' && selected.confluence?.authType === 'api_token' && (
                    <Grid item xs={12} md={6}>
                      <TextField label="Email" type="email" value={selected.confluence?.email || ''} onChange={(e) => updateConfluence({ email: e.target.value })} fullWidth sx={compactFieldSx} />
                    </Grid>
                  )}
                  <Grid item xs={12} md={selected.confluence?.deployment === 'cloud' && selected.confluence?.authType === 'api_token' ? 6 : 12}>
                    <TextField label="Token" type="password" value={selected.confluence?.token || ''} onChange={(e) => updateConfluence({ token: e.target.value })} fullWidth sx={compactFieldSx} />
                  </Grid>
                </Grid>

                <Divider />
                <Typography sx={sectionTitleSx}>Scope</Typography>
                <Grid container spacing={1.5}>
                  <Grid item xs={12} md={5}>
                    <FormControl fullWidth sx={compactFieldSx}>
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
                  </Grid>
                  <Grid item xs={12} md={7}>
                    <TextField
                      label={scopeFields.scopeMode === 'spaces' ? 'Space keys' : scopeFields.scopeMode === 'page_tree' ? 'Root page URL or ID' : 'CQL'}
                      placeholder={scopeFields.scopeMode === 'spaces' ? 'DBA, DATA' : scopeFields.scopeMode === 'cql' ? 'type = page AND space = "DBA" AND label = "database"' : '123456789 or https://...'}
                      value={scopeFields.scopeValue}
                      onChange={(e) => updateSelected({ scope: fieldsToScope(scopeFields.scopeMode, e.target.value) })}
                      fullWidth
                      multiline={scopeFields.scopeMode === 'cql'}
                      minRows={scopeFields.scopeMode === 'cql' ? 2 : undefined}
                      sx={compactFieldSx}
                    />
                  </Grid>
                </Grid>

                <Divider />
                <Typography sx={sectionTitleSx}>Permissions</Typography>
                <Grid container spacing={0.5}>
                  <Grid item xs={12} sm={6}>
                    <FormControlLabel disabled control={<Checkbox size="small" checked />} label="Read documentation" />
                    <FormControlLabel control={<Checkbox size="small" checked={selected.permissions.useInSqlGeneration} onChange={(e) => updateSelected({ permissions: { ...selected.permissions, useInSqlGeneration: e.target.checked } })} />} label="Use in SQL generation" />
                    <FormControlLabel control={<Checkbox size="small" checked={selected.permissions.showCitations} onChange={(e) => updateSelected({ permissions: { ...selected.permissions, showCitations: e.target.checked } })} />} label="Show citations in answers" />
                  </Grid>
                  <Grid item xs={12} sm={6}>
                    <FormControlLabel disabled control={<Checkbox size="small" checked={false} />} label="Suggest documentation updates" />
                    <FormControlLabel disabled control={<Checkbox size="small" checked={false} />} label="Allow manual write-back" />
                  </Grid>
                </Grid>
              </Stack>
            )}
          </Box>

          <DialogActions sx={{ px: 2, py: 1.25, borderTop: '1px solid', borderColor: 'divider', justifyContent: 'space-between' }}>
            <Stack direction="row" spacing={1}>
              {selected && (
                <>
                  <Button startIcon={<TestIcon />} variant="outlined" onClick={handleTestConnection} disabled={busy}>Test</Button>
                  <Button startIcon={<KnowledgeIcon />} variant="outlined" onClick={handlePreview} disabled={busy}>Preview</Button>
                  <Button startIcon={<SyncIcon />} variant="outlined" onClick={handleSync} disabled={busy}>Sync</Button>
                  <Button startIcon={<DeleteIcon />} color="error" variant="outlined" onClick={handleDelete} disabled={busy}>Delete</Button>
                </>
              )}
            </Stack>
            <Stack direction="row" spacing={1}>
              <Button onClick={onClose}>Cancel</Button>
              <Button startIcon={<SaveIcon />} variant="contained" onClick={handleSave} sx={gradientButtonSx}>Save</Button>
            </Stack>
          </DialogActions>
        </Box>
      </DialogContent>
    </Dialog>
  );
}
