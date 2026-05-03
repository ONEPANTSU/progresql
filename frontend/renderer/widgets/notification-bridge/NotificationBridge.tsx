import { useEffect, useRef } from 'react';
import { useAgent } from '@/features/agent-chat/AgentContext';
import { useNotifications } from '@/features/notifications/NotificationContext';
import { useTranslation } from '@/shared/i18n/LanguageContext';
import { ServerNotification } from '@/features/agent-chat/AgentService';

/**
 * Bridge component that watches AgentContext.lastNotification
 * and surfaces server push notifications as in-app toasts
 * via NotificationContext.
 *
 * Must be rendered inside both AgentProvider and NotificationProvider.
 */
export default function NotificationBridge() {
  const { lastNotification } = useAgent();
  const { showWarning, showError } = useNotifications();
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
      case 'balance.low': {
        const amount = String(payload.amount ?? '');
        showWarning(t('notify.ws.balanceLow', { amount }));
        break;
      }
      default:
        break;
    }
  }, [lastNotification, showWarning, showError, t]);

  return null;
}
