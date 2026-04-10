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
  Button,
  Snackbar,
  Alert,
  LinearProgress,
} from '@mui/material';
import {
  Close as CloseIcon,
  ReceiptLong as ReceiptLongIcon,
  Undo as UndoIcon,
} from '@mui/icons-material';
import { useTranslation } from '@/shared/i18n/LanguageContext';
import { getAuthToken } from '@/features/auth/auth';
import { loadBackendUrl } from '@/shared/lib/secureSettingsStorage';

interface Payment {
  id: string;
  invoice_id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: string;
  plan: string;
  payment_type: string;
  created_at: string;
  paid_at: string;
  refundable: boolean;
  refund_reason: string;
}

interface PaymentHistoryResponse {
  payments: Payment[];
  total: number;
}

interface PaymentHistoryProps {
  open: boolean;
  onClose: () => void;
}

const PAGE_SIZE = 20;

function formatDate(dateStr: string, lang: string): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatPaymentType(type: string, plan: string, lang: string): string {
  if (type === 'balance_topup') {
    return lang === 'ru' ? 'Пополнение баланса' : 'Balance Top-Up';
  }
  if (plan === 'pro') {
    return lang === 'ru' ? 'Подписка Pro' : 'Pro Subscription';
  }
  return lang === 'ru' ? 'Платёж' : 'Payment';
}

/**
 * Format an amount with the matching currency symbol.
 * Backend uses ISO codes (RUB/USD) but may send lowercase too.
 */
function formatAmount(amount: number, currency: string, lang: string): string {
  const currencyUpper = (currency || 'RUB').toUpperCase();
  const formatted = amount.toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  if (currencyUpper === 'USD') return `$${formatted}`;
  return `${formatted}\u00A0\u20BD`;
}

function getStatusColor(status: string): { bg: string; color: string } {
  switch (status) {
    case 'confirmed':
    case 'paid':
      return { bg: 'rgba(34,197,94,0.12)', color: '#22c55e' };
    case 'created':
    case 'pending':
      return { bg: 'rgba(245,158,11,0.12)', color: '#f59e0b' };
    case 'failed':
    case 'cancelled':
      return { bg: 'rgba(239,68,68,0.12)', color: '#ef4444' };
    case 'refunded':
      return { bg: 'rgba(156,163,175,0.12)', color: '#9ca3af' };
    default:
      return { bg: 'rgba(156,163,175,0.12)', color: '#9ca3af' };
  }
}

function formatStatusLabel(status: string, lang: string): string {
  const labels: Record<string, { ru: string; en: string }> = {
    confirmed: { ru: 'Оплачен', en: 'Confirmed' },
    paid: { ru: 'Оплачен', en: 'Paid' },
    created: { ru: 'Создан', en: 'Created' },
    pending: { ru: 'Ожидание', en: 'Pending' },
    failed: { ru: 'Ошибка', en: 'Failed' },
    cancelled: { ru: 'Отменён', en: 'Cancelled' },
    refunded: { ru: 'Возвращён', en: 'Refunded' },
  };
  const l = labels[status];
  return l ? (lang === 'ru' ? l.ru : l.en) : status;
}

export default function PaymentHistory({ open, onClose }: PaymentHistoryProps) {
  const { language } = useTranslation();
  const [loading, setLoading] = React.useState(true);
  const [payments, setPayments] = React.useState<Payment[]>([]);
  const [total, setTotal] = React.useState(0);
  const [offset, setOffset] = React.useState(0);

  // Refund state
  const [refundTarget, setRefundTarget] = React.useState<Payment | null>(null);
  const [refundLoading, setRefundLoading] = React.useState(false);
  const [snackbar, setSnackbar] = React.useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'success',
  });

  const fetchPayments = React.useCallback(async (newOffset: number, append: boolean = false) => {
    setLoading(true);
    try {
      const baseUrl = loadBackendUrl('https://progresql.com');
      const token = getAuthToken();
      const res = await fetch(`${baseUrl}/api/v3/payments/history?limit=${PAGE_SIZE}&offset=${newOffset}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error('Failed to fetch payment history');
      const data: PaymentHistoryResponse = await res.json();
      setPayments((prev) => (append ? [...prev, ...data.payments] : data.payments));
      setTotal(data.total);
      setOffset(newOffset);
    } catch (err) {
      console.error('Failed to fetch payment history:', err);
      setSnackbar({
        open: true,
        message: language === 'ru' ? 'Не удалось загрузить историю платежей' : 'Failed to load payment history',
        severity: 'error',
      });
    } finally {
      setLoading(false);
    }
  }, [language]);

  React.useEffect(() => {
    if (open) {
      setPayments([]);
      setOffset(0);
      fetchPayments(0);
    }
  }, [open, fetchPayments]);

  const handleLoadMore = () => {
    const newOffset = offset + PAGE_SIZE;
    fetchPayments(newOffset, true);
  };

  const handleRefundClick = (payment: Payment) => {
    setRefundTarget(payment);
  };

  const handleRefundConfirm = async () => {
    if (!refundTarget) return;
    setRefundLoading(true);
    try {
      const baseUrl = loadBackendUrl('https://progresql.com');
      const token = getAuthToken();
      const res = await fetch(`${baseUrl}/api/v3/payments/refund`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ payment_id: refundTarget.id }),
      });

      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.error || 'Refund failed');
      }

      const refundAmt = body?.refund_amount;
      const deducted = body?.deducted;
      let msg = language === 'ru' ? 'Возврат успешно оформлен' : 'Refund processed successfully';
      if (deducted > 0) {
        msg += language === 'ru'
          ? `. Возвращено ${refundAmt?.toFixed(2)}₽ (удержано ${deducted?.toFixed(2)}₽ за использование AI)`
          : `. Refunded ${refundAmt?.toFixed(2)}₽ (${deducted?.toFixed(2)}₽ deducted for AI usage)`;
      }
      setSnackbar({ open: true, message: msg, severity: 'success' });
      setRefundTarget(null);
      // Refresh list from the beginning
      setPayments([]);
      setOffset(0);
      fetchPayments(0);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Refund failed';
      setSnackbar({ open: true, message, severity: 'error' });
    } finally {
      setRefundLoading(false);
    }
  };

  const handleRefundCancel = () => {
    setRefundTarget(null);
  };

  const hasMore = payments.length < total;

  return (
    <>
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
          <ReceiptLongIcon sx={{ color: '#6366f1' }} />
          <Typography variant="h6" sx={{ fontWeight: 700, flexGrow: 1 }}>
            {language === 'ru' ? 'История платежей' : 'Payment History'}
          </Typography>
          <IconButton size="small" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </DialogTitle>

        <DialogContent sx={{ px: 3, pb: 3 }}>
          {loading && payments.length === 0 ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
              <CircularProgress />
            </Box>
          ) : payments.length > 0 ? (
            <>
              {loading && <LinearProgress sx={{ mb: 1 }} />}
              <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2 }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700, fontSize: '0.75rem' }}>
                        {language === 'ru' ? 'Дата' : 'Date'}
                      </TableCell>
                      <TableCell sx={{ fontWeight: 700, fontSize: '0.75rem' }}>
                        {language === 'ru' ? 'Тип' : 'Type'}
                      </TableCell>
                      <TableCell align="right" sx={{ fontWeight: 700, fontSize: '0.75rem' }}>
                        {language === 'ru' ? 'Сумма' : 'Amount'}
                      </TableCell>
                      <TableCell sx={{ fontWeight: 700, fontSize: '0.75rem' }}>
                        {language === 'ru' ? 'Статус' : 'Status'}
                      </TableCell>
                      <TableCell sx={{ fontWeight: 700, fontSize: '0.75rem' }} />
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {payments.map((p) => {
                      const statusStyle = getStatusColor(p.status);
                      return (
                        <TableRow key={p.id} hover>
                          <TableCell sx={{ fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
                            {formatDate(p.paid_at || p.created_at, language)}
                          </TableCell>
                          <TableCell sx={{ fontSize: '0.8rem', fontWeight: 500 }}>
                            {formatPaymentType(p.payment_type, p.plan, language)}
                          </TableCell>
                          <TableCell align="right" sx={{ fontSize: '0.8rem', fontFamily: 'monospace', fontWeight: 600 }}>
                            {formatAmount(p.amount, p.currency, language)}
                          </TableCell>
                          <TableCell>
                            <Chip
                              label={formatStatusLabel(p.status, language)}
                              size="small"
                              sx={{
                                fontSize: '0.6rem',
                                height: 18,
                                fontWeight: 600,
                                bgcolor: statusStyle.bg,
                                color: statusStyle.color,
                              }}
                            />
                          </TableCell>
                          <TableCell sx={{ whiteSpace: 'nowrap' }}>
                            {p.refundable && (
                              <Button
                                size="small"
                                startIcon={<UndoIcon sx={{ fontSize: 12 }} />}
                                onClick={() => handleRefundClick(p)}
                                sx={{
                                  textTransform: 'none',
                                  fontSize: '0.7rem',
                                  fontWeight: 600,
                                  color: '#6366f1',
                                  minWidth: 'auto',
                                  px: 1,
                                  py: 0.25,
                                  '&:hover': { bgcolor: 'rgba(99,102,241,0.06)' },
                                }}
                              >
                                {language === 'ru' ? 'Возврат' : 'Refund'}
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer>

              {hasMore && (
                <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
                  <Button
                    variant="outlined"
                    size="small"
                    onClick={handleLoadMore}
                    disabled={loading}
                    sx={{
                      textTransform: 'none',
                      fontWeight: 600,
                      fontSize: '0.8rem',
                      borderColor: 'rgba(99,102,241,0.3)',
                      color: '#6366f1',
                      '&:hover': { borderColor: '#6366f1', bgcolor: 'rgba(99,102,241,0.06)' },
                    }}
                  >
                    {loading
                      ? (language === 'ru' ? 'Загрузка...' : 'Loading...')
                      : (language === 'ru' ? 'Загрузить ещё' : 'Load More')}
                  </Button>
                </Box>
              )}

              <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', textAlign: 'center', mt: 1 }}>
                {language === 'ru'
                  ? `Показано ${payments.length} из ${total}`
                  : `Showing ${payments.length} of ${total}`}
              </Typography>
            </>
          ) : !loading ? (
            <Paper variant="outlined" sx={{ p: 3, textAlign: 'center', borderRadius: 2 }}>
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                {language === 'ru' ? 'Пока нет платежей' : 'No payments yet'}
              </Typography>
            </Paper>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Refund Confirmation Dialog */}
      <Dialog
        open={!!refundTarget}
        onClose={handleRefundCancel}
        maxWidth="xs"
        fullWidth
        PaperProps={{
          sx: { borderRadius: 3 },
        }}
      >
        <DialogTitle sx={{ fontWeight: 700, pb: 0.5 }}>
          {language === 'ru' ? 'Подтверждение возврата' : 'Confirm Refund'}
        </DialogTitle>
        <DialogContent sx={{ pb: 2 }}>
          {refundTarget && (
            <>
              <Typography variant="body2" sx={{ mb: 1.5 }}>
                {language === 'ru'
                  ? `Вы уверены, что хотите оформить возврат на сумму ${formatAmount(refundTarget.amount, refundTarget.currency, language)}?`
                  : `Are you sure you want to refund ${formatAmount(refundTarget.amount, refundTarget.currency, language)}?`}
              </Typography>
              <Alert severity="warning" sx={{ mb: 2, fontSize: '0.8rem' }}>
                {refundTarget.payment_type === 'balance_topup'
                  ? (language === 'ru'
                      ? 'Сумма будет списана с баланса и возвращена на карту'
                      : 'The amount will be deducted from your balance and returned to your card')
                  : (language === 'ru'
                      ? 'Подписка будет отменена и переведена на тариф Free. Из суммы возврата будут удержаны фактические расходы на AI-токены (ст. 32 ЗоЗПП).'
                      : 'Your subscription will be cancelled and downgraded to Free. Actual AI token costs will be deducted from the refund amount.')}
              </Alert>
              <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={handleRefundCancel}
                  disabled={refundLoading}
                  sx={{ textTransform: 'none', fontWeight: 600 }}
                >
                  {language === 'ru' ? 'Отмена' : 'Cancel'}
                </Button>
                <Button
                  variant="contained"
                  size="small"
                  onClick={handleRefundConfirm}
                  disabled={refundLoading}
                  color="error"
                  sx={{ textTransform: 'none', fontWeight: 600 }}
                >
                  {refundLoading
                    ? (language === 'ru' ? 'Обработка...' : 'Processing...')
                    : (language === 'ru' ? 'Оформить возврат' : 'Confirm Refund')}
                </Button>
              </Box>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Snackbar */}
      <Snackbar
        open={snackbar.open}
        autoHideDuration={4000}
        onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity={snackbar.severity}
          variant="filled"
          sx={{ width: '100%', fontSize: '0.8125rem' }}
          onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
        >
          {snackbar.message}
        </Alert>
      </Snackbar>
    </>
  );
}
