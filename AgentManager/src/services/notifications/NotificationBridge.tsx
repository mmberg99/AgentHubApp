import { useEffect } from 'react';

import { useAgentStore } from '../../store';
import { useNotificationService } from './notificationService';

/**
 * Connects the notification transport to application state.
 *
 * Renders nothing. This is the single point where inbound events enter the
 * app, so every event — simulated today, real push later — passes through the
 * same validation inside `ingestRemoteEvent`.
 */
export function NotificationBridge() {
  const service = useNotificationService();
  const { ingestRemoteEvent } = useAgentStore();

  useEffect(() => {
    return service.subscribe((raw, source) => {
      const result = ingestRemoteEvent(raw, source);
      if (!result.ok) {
        // Rejected payloads never reach state; surface the count in Settings.
        service.reportRejected();
        if (__DEV__) {
          // Reasons only. The raw payload is never logged or displayed: it is
          // untrusted and may contain content that must not be surfaced.
          console.warn('[AgentHub] rejected agent event:', result.errors.join('; '));
        }
      }
    });
    // `ingestRemoteEvent` is stable (useCallback with no deps in the store).
  }, [service, ingestRemoteEvent]);

  return null;
}
