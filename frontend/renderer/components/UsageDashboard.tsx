import React from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  IconButton,
  Box,
  Typography,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Chip,
  CircularProgress,
  Paper,
  Pagination,
  LinearProgress,
} from '@mui/material';
import {
  Close as CloseIcon,
  TrendingUp as TrendingUpIcon,
  Token as TokenIcon,
  AttachMoney as MoneyIcon,
  Functions as FunctionsIcon,
} from '@mui/icons-material';
import { useTranslation } from '../contexts/LanguageContext';
import { fetchUsageHistory, fetchUsage } from '../services/auth';
import { UsageHistoryResponse, UsageInfo } from '../types';
import { useModels, formatModelName } from '../hooks/useModels';
import QuotaIndicator from './QuotaIndicator';

interface UsageDashboardProps {
  open: boolean;
  onClose: () => void;
}

const USD_TO_RUB = 90;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatDate(dateStr: string, lang: string): string {
  const d = new Date(dateStr);
  return d.toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// Stat card component
function StatCard({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <Paper
      elevation={0}
      sx={{
        p: 2,
        flex: 1,
        minWidth: 140,
        border: 1,
        borderColor: 'divider',
        borderRadius: 2,
        display: 'flex',
        flexDirection: 'column',
        gap: 0.5,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
        {icon}
        <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em', fontSize: '0.65rem' }}>
          {label}
        </Typography>
      </Box>
      <Typography variant="h6" sx={{ fontWeight: 700, lineHeight: 1.2 }}>{value}</Typography>
      {sub && <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: '0.7rem' }}>{sub}</Typography>}
    </Paper>
  );
}

export default function UsageDashboard({ open, onClose }: UsageDashboardProps) {
  const { t, language } = useTranslation();
  const [loading, setLoading] = React.useState(true);
  const [history, setHistory] = React.useState<UsageHistoryResponse | null>(null);
  const [usage, setUsage] = React.useState<UsageInfo | null>(null);
  const [page, setPage] = React.useState(1);
  const pageSize = 15;

  const { models: allModels } = useModels();

  const fetchData = React.useCallback(async (pageNum: number) => {
    setLoading(true);
    try {
      const offset = (pageNum - 1) * pageSize;
      const [historyData, usageData] = await Promise.all([
        fetchUsageHistory(pageSize, offset),
        fetchUsage(),
      ]);
      setHistory(historyData);
      setUsage(usageData);
    } catch (err) {
      console.error('Failed to fetch usage data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (open) {
      fetchData(page);
    }
  }, [open, page, fetchData]);

  const totalPages = history ? Math.ceil(history.total / pageSize) : 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      PaperProps={{
        sx: {
          borderRadius: 3,
          maxHeight: '85vh',
        },
      }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pb: 1 }}>
        <TrendingUpIcon sx={{ color: '#6366f1' }} />
        <Typography variant="h6" sx={{ fontWeight: 700, flexGrow: 1 }}>
          {language === 'ru' ? 'Использование и расходы' : 'Usage & Spending'}
        </Typography>
        <IconButton size="small" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      <DialogContent sx={{ px: 3, pb: 3 }}>
        {loading && !history ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        ) : (
          <>
            {/* Current quota */}
            {usage && (
              <Box sx={{ mb: 3, border: 1, borderColor: 'divider', borderRadius: 2 }}>
                <QuotaIndicator usage={usage} />
              </Box>
            )}

            {/* Stats cards */}
            {history?.stats && (
              <Box sx={{ display: 'flex', gap: 1.5, mb: 3, flexWrap: 'wrap' }}>
                <StatCard
                  icon={<FunctionsIcon sx={{ fontSize: 16, color: '#6366f1' }} />}
                  label={language === 'ru' ? 'Запросов' : 'Requests'}
                  value={String(history.stats.total_requests)}
                  sub={language === 'ru' ? 'всего' : 'total'}
                />
                <StatCard
                  icon={<TokenIcon sx={{ fontSize: 16, color: '#f59e0b' }} />}
                  label={language === 'ru' ? 'Токенов' : 'Tokens'}
                  value={formatTokens(history.stats.total_tokens)}
                  sub={`~${formatTokens(history.stats.avg_tokens_per_request)} / ${language === 'ru' ? 'запрос' : 'req'}`}
                />
                <StatCard
                  icon={<MoneyIcon sx={{ fontSize: 16, color: '#10b981' }} />}
                  label={language === 'ru' ? 'Стоимость' : 'Cost'}
                  value={`$${history.stats.total_cost_usd.toFixed(4)}`}
                  sub={`~${(history.stats.total_cost_usd * USD_TO_RUB).toFixed(1)}₽ | ~$${history.stats.avg_cost_per_request_usd.toFixed(4)}/${language === 'ru' ? 'запрос' : 'req'}`}
                />
              </Box>
            )}

            {/* Model pricing table */}
            {allModels.length > 0 && (
              <Box sx={{ mb: 3 }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>
                  {language === 'ru' ? 'Цены моделей (за 1M токенов)' : 'Model Pricing (per 1M tokens)'}
                </Typography>
                <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2 }}>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell sx={{ fontWeight: 700, fontSize: '0.75rem' }}>
                          {language === 'ru' ? 'Модель' : 'Model'}
                        </TableCell>
                        <TableCell sx={{ fontWeight: 700, fontSize: '0.75rem' }}>
                          {language === 'ru' ? 'Тип' : 'Tier'}
                        </TableCell>
                        <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.75rem' }}>
                          Input ($/1M)
                        </TableCell>
                        <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.75rem' }}>
                          Output ($/1M)
                        </TableCell>
                        <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.75rem' }}>
                          Input (₽/1M)
                        </TableCell>
                        <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.75rem' }}>
                          Output (₽/1M)
                        </TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {allModels.map((m) => (
                        <TableRow key={m.id} hover>
                          <TableCell sx={{ fontSize: '0.8rem', fontWeight: 500 }}>
                            {m.name}
                          </TableCell>
                          <TableCell>
                            <Chip
                              label={m.tier === 'premium'
                                ? (language === 'ru' ? 'Прем.' : 'Premium')
                                : (language === 'ru' ? 'Бюдж.' : 'Budget')}
                              size="small"
                              sx={{
                                fontSize: '0.6rem',
                                height: 18,
                                bgcolor: m.tier === 'premium' ? 'rgba(245,158,11,0.12)' : 'rgba(34,197,94,0.12)',
                                color: m.tier === 'premium' ? 'warning.main' : 'success.main',
                                fontWeight: 600,
                              }}
                            />
                          </TableCell>
                          <TableCell align="right" sx={{ fontSize: '0.8rem', fontFamily: 'monospace' }}>
                            ${m.input_price_per_m.toFixed(2)}
                          </TableCell>
                          <TableCell align="right" sx={{ fontSize: '0.8rem', fontFamily: 'monospace' }}>
                            ${m.output_price_per_m.toFixed(2)}
                          </TableCell>
                          <TableCell align="right" sx={{ fontSize: '0.8rem', fontFamily: 'monospace' }}>
                            {(m.input_price_per_m * USD_TO_RUB).toFixed(0)}₽
                          </TableCell>
                          <TableCell align="right" sx={{ fontSize: '0.8rem', fontFamily: 'monospace' }}>
                            {(m.output_price_per_m * USD_TO_RUB).toFixed(0)}₽
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              </Box>
            )}

            {/* Usage history table */}
            <Box>
              <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>
                {language === 'ru' ? 'История запросов' : 'Request History'}
              </Typography>
              {loading && <LinearProgress sx={{ mb: 1 }} />}
              {history && history.records.length > 0 ? (
                <>
                  <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2 }}>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell sx={{ fontWeight: 700, fontSize: '0.75rem' }}>
                            {language === 'ru' ? 'Дата' : 'Date'}
                          </TableCell>
                          <TableCell sx={{ fontWeight: 700, fontSize: '0.75rem' }}>
                            {language === 'ru' ? 'Модель' : 'Model'}
                          </TableCell>
                          <TableCell sx={{ fontWeight: 700, fontSize: '0.75rem' }}>
                            {language === 'ru' ? 'Действие' : 'Action'}
                          </TableCell>
                          <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.75rem' }}>
                            {language === 'ru' ? 'Токены' : 'Tokens'}
                          </TableCell>
                          <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.75rem' }}>
                            {language === 'ru' ? 'Стоимость' : 'Cost'}
                          </TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {history.records.map((r) => (
                          <TableRow key={r.id} hover>
                            <TableCell sx={{ fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
                              {formatDate(r.created_at, language)}
                            </TableCell>
                            <TableCell sx={{ fontSize: '0.8rem', fontWeight: 500 }}>
                              {formatModelName(r.model, allModels)}
                            </TableCell>
                            <TableCell>
                              <Chip
                                label={r.action}
                                size="small"
                                sx={{ fontSize: '0.6rem', height: 18, fontWeight: 500 }}
                              />
                            </TableCell>
                            <TableCell align="right" sx={{ fontSize: '0.75rem', fontFamily: 'monospace' }}>
                              {formatTokens(r.total_tokens)}
                              <Typography component="span" sx={{ color: 'text.secondary', fontSize: '0.6rem', ml: 0.5 }}>
                                ({formatTokens(r.prompt_tokens)}+{formatTokens(r.completion_tokens)})
                              </Typography>
                            </TableCell>
                            <TableCell align="right" sx={{ fontSize: '0.75rem', fontFamily: 'monospace' }}>
                              ${r.cost_usd.toFixed(4)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                  {totalPages > 1 && (
                    <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
                      <Pagination
                        count={totalPages}
                        page={page}
                        onChange={(_, p) => setPage(p)}
                        size="small"
                        color="primary"
                      />
                    </Box>
                  )}
                </>
              ) : !loading ? (
                <Paper variant="outlined" sx={{ p: 3, textAlign: 'center', borderRadius: 2 }}>
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                    {language === 'ru' ? 'Пока нет истории использования' : 'No usage history yet'}
                  </Typography>
                </Paper>
              ) : null}
            </Box>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
