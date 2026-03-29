import { useEffect, useRef } from 'react';
import { useAgent } from '../contexts/AgentContext';
import { useNotifications } from '../contexts/NotificationContext';
import { useTranslation } from '../contexts/LanguageContext';
import { ServerNotification } from '../services/agent/AgentService';

/**
 * Bridge component that watches AgentContext.lastNotification
 * and surfaces server push notifications as in-app toasts
 * via NotificationContext.
 *
 * Must be rendered inside both AgentProvider and NotificationProvider.
 */
export default function NotificationBridge() {
  const { lastNotification } = useAgent();
  const { showWarning, showError, showInfo } = useNotifications();
  const { t } = useTranslation();

  // Track which notification we already handled to avoid duplicate toasts
  const handledRef = useRef<ServerNotification | null>(null);

  useEffect(() => {
    if (!lastNotification) return;
    // Skip if we already handled this exact notification object
    if (handledRef.current === lastNotification) return;
    handledRef.current = lastNotification;

    const { type, payload } = lastNotification;

    switch (type) {
      case 'quota.warning': {
        const percent = String(payload.percent ?? '');
        showWarning(t('notify.ws.quotaWarning', { percent }));
        break;
      }
      case 'quota.exhausted': {
        showError(t('notify.ws.quotaExhausted'));
        break;
      }
      case 'model.fallback': {
        const from_model = String(payload.from_model ?? '');
        const to_model = String(payload.to_model ?? '');
        showInfo(t('notify.ws.modelFallback', { from_model, to_model }));
        break;
      }
      case 'balance.low': {
        const amount = String(payload.amount ?? '');
        showWarning(t('notify.ws.balanceLow', { amount }));
        break;
      }
      default:
        break;
    }
  }, [lastNotification, showWarning, showError, showInfo, t]);

  return null;
}
