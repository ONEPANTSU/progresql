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
import { useTranslation } from '@/shared/i18n/LanguageContext';
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
  const { t } = useTranslation();
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
  const databaseOptions = useMemo(() => {
    if (!connection) return [];
    const names = new Set<string>();
    if (connection.activeDatabase) names.add(connection.activeDatabase);
    if (connection.database) names.add(connection.database);
    for (const db of connection.availableDatabases || []) names.add(db.name);
    for (const db of connection.databases || []) names.add(db.name);
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [connection]);

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
        ? { severity: 'success', message: result.message || t('knowledge.status.connectionSuccessful') }
        : { severity: 'error', message: result.message || t('knowledge.status.connectionFailed') });
    } catch (error) {
      setStatus({ severity: 'error', message: error instanceof Error ? error.message : t('knowledge.status.connectionFailed') });
    } finally {
      setBusy(false);
    }
  };

  const handleSync = async () => {
    if (!selected) return;
    setBusy(true);
    setStatus({ severity: 'info', message: t('knowledge.status.syncing') });
    try {
      const result = await window.electronAPI.syncKnowledgeSource(selected);
      if (!result.success || !result.index) {
        setStatus({ severity: 'error', message: result.message || t('knowledge.status.syncFailed') });
        return;
      }
      setSources(prev => prev.map(source =>
        source.id === selected.id
          ? { ...source, index: result.index }
          : source
      ));
      setStatus({
        severity: 'success',
        message: t('knowledge.status.synced', { pages: result.index.documents.length, chunks: result.index.chunks.length }),
      });
    } catch (error) {
      setStatus({ severity: 'error', message: error instanceof Error ? error.message : t('knowledge.status.syncFailed') });
    } finally {
      setBusy(false);
    }
  };

  const handlePreview = async () => {
    if (!selected) return;
    setBusy(true);
    setStatus({ severity: 'info', message: t('knowledge.status.previewing') });
    try {
      const result = await window.electronAPI.previewKnowledgeSource(selected);
      setStatus(result.success
        ? { severity: 'success', message: t('knowledge.status.previewMatched', { count: result.documents?.length || 0 }) }
        : { severity: 'error', message: result.message || t('knowledge.status.previewFailed') });
    } catch (error) {
      setStatus({ severity: 'error', message: error instanceof Error ? error.message : t('knowledge.status.previewFailed') });
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
              {t('knowledge.title')}
            </Typography>
            <Typography variant="caption" color="text.secondary" noWrap>
              {connection.connectionName}
            </Typography>
          </Box>
          <IconButton onClick={onClose} size="small" aria-label={t('knowledge.close')}>
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
            {t('knowledge.addSource')}
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
                    minHeight: 40,
                    alignItems: 'center',
                    border: '1px solid',
                    borderColor: source.id === selectedId ? 'primary.main' : 'transparent',
                    bgcolor: source.id === selectedId ? 'rgba(99,102,241,0.16)' : 'transparent',
                    '&:hover': { bgcolor: 'action.hover' },
                  }}
                >
                  <ListItemText
                    primary={source.name || 'Untitled source'}
                    primaryTypographyProps={{ noWrap: true, sx: { fontSize: '0.84rem', fontWeight: 600, lineHeight: 1.25 } }}
                  />
                  {syncedPages > 0 && (
                    <Typography variant="caption" color="text.secondary" sx={{ ml: 1, fontSize: '0.68rem', flexShrink: 0 }}>
                      {syncedPages}
                    </Typography>
                  )}
                </ListItemButton>
              );
            })}
            {sources.length === 0 && (
              <Box sx={{ px: 1, py: 2, border: '1px dashed', borderColor: 'divider', borderRadius: 1 }}>
                <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>{t('knowledge.noSources')}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {t('knowledge.noSourcesHint')}
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
                  {t('knowledge.emptyPrompt')}
                </Alert>
                <Button startIcon={<KnowledgeIcon />} variant="contained" onClick={handleAdd} sx={gradientButtonSx}>
                  {t('knowledge.addConfluenceSource')}
                </Button>
              </Box>
            ) : (
              <Stack spacing={2.25}>
                {status && <Alert severity={status.severity}>{status.message}</Alert>}

                <Typography sx={sectionTitleSx}>{t('knowledge.section.source')}</Typography>
                <Grid container spacing={1.5}>
                  <Grid item xs={12} md={4}>
                    <FormControl fullWidth sx={compactFieldSx}>
                      <InputLabel>{t('knowledge.type')}</InputLabel>
                      <Select label={t('knowledge.type')} value={selected.type} onChange={(e) => updateSelected({ type: e.target.value as any })}>
                        <MenuItem value="confluence">{t('knowledge.type.confluence')}</MenuItem>
                        <MenuItem value="notion" disabled>{t('knowledge.type.notionComingSoon')}</MenuItem>
                        <MenuItem value="git_markdown" disabled>{t('knowledge.type.gitComingSoon')}</MenuItem>
                        <MenuItem value="dbt_docs" disabled>{t('knowledge.type.dbtComingSoon')}</MenuItem>
                        <MenuItem value="openmetadata" disabled>{t('knowledge.type.openMetadataComingSoon')}</MenuItem>
                      </Select>
                    </FormControl>
                  </Grid>
                  <Grid item xs={12} md={4}>
                    <TextField label={t('knowledge.name')} value={selected.name} onChange={(e) => updateSelected({ name: e.target.value })} fullWidth sx={compactFieldSx} />
                  </Grid>
                  <Grid item xs={12} md={4}>
                    <FormControl fullWidth sx={compactFieldSx}>
                      <InputLabel>{t('knowledge.database')}</InputLabel>
                      <Select
                        label={t('knowledge.database')}
                        value={selected.databaseName || ''}
                        onChange={(e) => updateSelected({ databaseName: e.target.value || undefined })}
                      >
                        <MenuItem value="">{t('knowledge.allDatabases')}</MenuItem>
                        {databaseOptions.map(name => (
                          <MenuItem key={name} value={name}>{name}</MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  </Grid>
                  <Grid item xs={12}>
                    <FormControlLabel
                      sx={{ mr: 0 }}
                      control={<Checkbox checked={selected.enabled} onChange={(e) => updateSelected({ enabled: e.target.checked })} />}
                      label={t('knowledge.enabledForScope')}
                    />
                  </Grid>
                </Grid>

                <Divider />
                <Typography sx={sectionTitleSx}>{t('knowledge.section.connection')}</Typography>
                <TextField label={t('knowledge.baseUrl')} placeholder="https://company.atlassian.net/wiki" value={selected.confluence?.baseUrl || ''} onChange={(e) => updateConfluence({ baseUrl: e.target.value })} fullWidth sx={compactFieldSx} />
                <Grid container spacing={1.5}>
                  <Grid item xs={12} md={6}>
                    <FormControl fullWidth>
                      <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5 }}>{t('knowledge.edition')}</Typography>
                      <RadioGroup row value={selected.confluence?.deployment || 'cloud'} onChange={(e) => updateConfluence({ deployment: e.target.value as any })}>
                        <FormControlLabel value="cloud" control={<Radio size="small" />} label={t('knowledge.edition.cloud')} />
                        <FormControlLabel value="data_center" control={<Radio size="small" />} label={t('knowledge.edition.dataCenter')} />
                      </RadioGroup>
                      <Typography variant="caption" color="text.secondary">
                        {t('knowledge.editionHint')}
                      </Typography>
                    </FormControl>
                  </Grid>
                  <Grid item xs={12} md={6}>
                    <FormControl fullWidth>
                      <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5 }}>{t('knowledge.auth')}</Typography>
                      <RadioGroup row value={selected.confluence?.authType || 'api_token'} onChange={(e) => updateConfluence({ authType: e.target.value as any })}>
                        <FormControlLabel value="api_token" control={<Radio size="small" />} label={t('knowledge.auth.apiToken')} />
                        <FormControlLabel value="pat" control={<Radio size="small" />} label={t('knowledge.auth.pat')} />
                      </RadioGroup>
                      <Typography variant="caption" color="text.secondary">
                        {t('knowledge.authHint')}
                      </Typography>
                    </FormControl>
                  </Grid>
                </Grid>
                <Grid container spacing={1.5}>
                  {selected.confluence?.deployment === 'cloud' && selected.confluence?.authType === 'api_token' && (
                    <Grid item xs={12} md={6}>
                      <TextField label={t('knowledge.email')} type="email" value={selected.confluence?.email || ''} onChange={(e) => updateConfluence({ email: e.target.value })} fullWidth sx={compactFieldSx} />
                    </Grid>
                  )}
                  <Grid item xs={12} md={selected.confluence?.deployment === 'cloud' && selected.confluence?.authType === 'api_token' ? 6 : 12}>
                    <TextField label={t('knowledge.token')} type="password" value={selected.confluence?.token || ''} onChange={(e) => updateConfluence({ token: e.target.value })} fullWidth sx={compactFieldSx} />
                  </Grid>
                </Grid>

                <Divider />
                <Typography sx={sectionTitleSx}>{t('knowledge.section.scope')}</Typography>
                <Grid container spacing={1.5}>
                  <Grid item xs={12} md={5}>
                    <FormControl fullWidth sx={compactFieldSx}>
                      <InputLabel>{t('knowledge.section.scope')}</InputLabel>
                      <Select
                        label={t('knowledge.section.scope')}
                        value={scopeFields.scopeMode}
                        onChange={(e) => updateSelected({ scope: fieldsToScope(e.target.value as KnowledgeSourceScope['mode'], '') })}
                      >
                        <MenuItem value="spaces">{t('knowledge.scope.spaces')}</MenuItem>
                        <MenuItem value="page_tree">{t('knowledge.scope.pageTree')}</MenuItem>
                        <MenuItem value="cql">{t('knowledge.scope.cql')}</MenuItem>
                        <MenuItem value="manual_pages" disabled>{t('knowledge.scope.manualComingSoon')}</MenuItem>
                      </Select>
                    </FormControl>
                  </Grid>
                  <Grid item xs={12} md={7}>
                    <TextField
                      label={scopeFields.scopeMode === 'spaces' ? t('knowledge.scope.spaceKeys') : scopeFields.scopeMode === 'page_tree' ? t('knowledge.scope.rootPage') : 'CQL'}
                      placeholder={scopeFields.scopeMode === 'spaces' ? 'DBA, DATA' : scopeFields.scopeMode === 'cql' ? t('knowledge.scope.cqlPlaceholder') : t('knowledge.scope.rootPlaceholder')}
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
                <Typography sx={sectionTitleSx}>{t('knowledge.section.chatUsage')}</Typography>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={{ xs: 0, sm: 3 }}>
                  <FormControlLabel
                    control={<Checkbox size="small" checked={selected.permissions.useInSqlGeneration} onChange={(e) => updateSelected({ permissions: { ...selected.permissions, useInSqlGeneration: e.target.checked } })} />}
                    label={t('knowledge.useInSqlGeneration')}
                  />
                  <FormControlLabel
                    control={<Checkbox size="small" checked={selected.permissions.showCitations} onChange={(e) => updateSelected({ permissions: { ...selected.permissions, showCitations: e.target.checked } })} />}
                    label={t('knowledge.showCitations')}
                  />
                </Stack>
                <FormControlLabel
                  control={<Checkbox size="small" checked={selected.permissions.allowManualWriteBack} onChange={(e) => updateSelected({ permissions: { ...selected.permissions, suggestDocumentationUpdates: e.target.checked, allowManualWriteBack: e.target.checked } })} />}
                  label={t('knowledge.allowManualWriteBack')}
                />
              </Stack>
            )}
          </Box>

          <DialogActions sx={{ px: 2, py: 1.25, borderTop: '1px solid', borderColor: 'divider', justifyContent: 'space-between' }}>
            <Stack direction="row" spacing={1}>
              {selected && (
                <>
                  <Button startIcon={<TestIcon />} variant="outlined" onClick={handleTestConnection} disabled={busy}>{t('knowledge.test')}</Button>
                  <Button startIcon={<KnowledgeIcon />} variant="outlined" onClick={handlePreview} disabled={busy}>{t('knowledge.preview')}</Button>
                  <Button startIcon={<SyncIcon />} variant="contained" onClick={handleSync} disabled={busy} sx={gradientButtonSx}>{t('knowledge.sync')}</Button>
                  <Button startIcon={<DeleteIcon />} color="error" variant="outlined" onClick={handleDelete} disabled={busy}>{t('knowledge.delete')}</Button>
                </>
              )}
            </Stack>
            <Stack direction="row" spacing={1}>
              <Button onClick={onClose}>{t('knowledge.cancel')}</Button>
              <Button startIcon={<SaveIcon />} variant="contained" onClick={handleSave} sx={gradientButtonSx}>{t('knowledge.save')}</Button>
            </Stack>
          </DialogActions>
        </Box>
      </DialogContent>
    </Dialog>
  );
}
