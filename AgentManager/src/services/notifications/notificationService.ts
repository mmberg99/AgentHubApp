import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

import { localBridgeNotificationService } from './localBridgeNotificationService';
import type { NotificationService, NotificationStatus } from './types';
import { webPushNotificationService } from './webPushNotificationService';

/**
 * Single registration point for the active transport.
 *
 * WEB   Standards-based Web Push. Events arrive from the Windows relay through
 *       Apple's push service and the service worker, plus a history sync for
 *       anything that landed while the app was closed. This is the production
 *       path for the installed iPhone PWA.
 *
 * NATIVE The local development bridge, unchanged. It polls a bridge on the LAN
 *       and is only reachable while that machine is awake.
 *
 * Both implement the same interface and both route through
 * `NotificationBridge` -> `parseAgentNotificationEvent` -> `ingestRemoteEvent`,
 * so the validator is the single trust boundary regardless of transport. Both
 * also serve the in-app demo controls through `deliverSimulated`.
 *
 * Swapping at runtime remains possible via `setNotificationService()`; no
 * screen, store or protocol code depends on which one is active.
 */
let active: NotificationService =
  Platform.OS === 'web' ? webPushNotificationService : localBridgeNotificationService;

const serviceListeners = new Set<(service: NotificationService) => void>();

export function getNotificationService(): NotificationService {
  return active;
}

/**
 * Swaps the active transport. Subscribed components re-render, so the swap is
 * safe at any point in the lifecycle — not only before the first render.
 */
export function setNotificationService(service: NotificationService): void {
  if (service === active) return;
  active = service;
  serviceListeners.forEach((listener) => listener(active));
}

export function useNotificationService(): NotificationService {
  const [service, setService] = useState<NotificationService>(active);

  useEffect(() => {
    // Re-read in case the service was swapped between render and subscribe.
    setService(active);
    serviceListeners.add(setService);
    return () => {
      serviceListeners.delete(setService);
    };
  }, []);

  return service;
}

/** Subscribes a component to transport status changes. */
export function useNotificationStatus(): NotificationStatus {
  const service = useNotificationService();
  const [status, setStatus] = useState<NotificationStatus>(() => service.getStatus());

  useEffect(() => {
    // Re-read on mount in case status changed between render and subscribe.
    setStatus(service.getStatus());
    return service.subscribeStatus(setStatus);
  }, [service]);

  return status;
}
