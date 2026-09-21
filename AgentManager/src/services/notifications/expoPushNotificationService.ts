import { NotImplementedError } from '../../providers';
import type {
  DeviceRegistration,
  NotificationService,
  NotificationStatus,
  PermissionStatus,
  RawEventListener,
  StatusListener,
} from './types';

/**
 * ============================================================================
 * FUTURE IMPLEMENTATION SEAM — NOT FUNCTIONAL, NOT REGISTERED
 * ============================================================================
 *
 * This file deliberately contains NO working push behaviour. It exists to
 * prove, at compile time, that `NotificationService` is sufficient to describe
 * a real push transport, and to record exactly where each piece of the future
 * implementation goes.
 *
 * It is NOT passed to `setNotificationService()`. Every method throws. Nothing
 * imports `expo-notifications` or `expo-device`; those packages are not
 * installed and must not be until approved.
 *
 * WHAT THE REAL IMPLEMENTATION WILL DO, step by step:
 *
 * 1. ENVIRONMENT CHECK
 *    `Device.isDevice` must be true. A simulator can receive push only on
 *    Xcode 14+ / macOS 13+ / iOS 16+, and this project has no installed iOS
 *    runtime, so treat simulators as unsupported and set
 *    `connectionState: 'unavailable'` with a clear reason rather than throwing.
 *
 * 2. PERMISSIONS
 *    `Notifications.getPermissionsAsync()`, then
 *    `Notifications.requestPermissionsAsync()` only if not already granted.
 *    Map the result onto `PermissionStatus`. Denied is a terminal state until
 *    the user changes it in iOS Settings — surface that, never re-prompt in a
 *    loop.
 *
 * 3. TOKEN
 *    Two mutually exclusive options, decided before implementation:
 *      (a) Expo Push Service — `getExpoPushTokenAsync({ projectId })`.
 *          Requires an EAS projectId, therefore an Expo account.
 *      (b) Direct APNs — `getDevicePushTokenAsync()`, returning the native
 *          APNs token. Needs no Expo account; the relay signs its own JWT from
 *          an Apple .p8 key. `expo-notifications` is push-service agnostic.
 *    Whichever is chosen, the token is stored on the RELAY, never shipped to
 *    the Windows notifier.
 *
 * 4. FOREGROUND DELIVERY
 *    `Notifications.setNotificationHandler({...})` decides whether iOS draws a
 *    banner while the app is open, then
 *    `addNotificationReceivedListener(notification => ...)` hands
 *    `notification.request.content.data` to `extractAgentEventPayload` and on
 *    to the existing listeners.
 *
 * 5. TAP / LAUNCH
 *    `addNotificationResponseReceivedListener` covers taps while the app is
 *    running. `getLastNotificationResponseAsync()` must ALSO be called once at
 *    startup, because a tap that cold-launches the app fires before any
 *    listener is attached and would otherwise be lost.
 *
 * 6. VALIDATION AND DEDUPE — already solved, do not reimplement.
 *    Emit the raw payload with source 'push'. `NotificationBridge` passes it to
 *    `parseAgentNotificationEvent`, and the store deduplicates by `eventId`.
 *    Push can legitimately deliver the same notification more than once (and a
 *    foreground receipt plus a later tap are two deliveries of ONE event), so
 *    this dedupe is what makes those cases harmless.
 *
 * 7. MALFORMED PAYLOADS
 *    A rejected payload calls `reportRejected()` and is dropped. The raw JSON
 *    is never logged or displayed.
 */
class ExpoPushNotificationService implements NotificationService {
  readonly id = 'expo-push';
  readonly simulated = false;

  private readonly status: NotificationStatus = {
    serviceId: 'expo-push',
    simulated: false,
    transport: 'expo-push',
    // Honest: no push infrastructure is configured, so nothing is connected.
    connectionState: 'unavailable',
    endpoint: null,
    lastError: 'Push transport is not implemented yet',
    lastContactAt: null,
    enabled: false,
    permission: 'undetermined',
    registration: {
      registered: false,
      token: null,
      registeredAt: null,
      simulated: false,
    },
    lastEventAt: null,
    lastEventTitle: null,
    lastRealEventAt: null,
    lastRealEventTitle: null,
    realEventCount: 0,
    rejectedCount: 0,
  };

  getStatus(): NotificationStatus {
    return this.status;
  }

  subscribeStatus(_listener: StatusListener): () => void {
    throw new NotImplementedError('custom', 'expoPush.subscribeStatus');
  }

  subscribe(_listener: RawEventListener): () => void {
    throw new NotImplementedError('custom', 'expoPush.subscribe');
  }

  requestPermissions(): Promise<PermissionStatus> {
    return Promise.reject(new NotImplementedError('custom', 'expoPush.requestPermissions'));
  }

  setEnabled(_enabled: boolean): Promise<void> {
    return Promise.reject(new NotImplementedError('custom', 'expoPush.setEnabled'));
  }

  register(): Promise<DeviceRegistration> {
    return Promise.reject(new NotImplementedError('custom', 'expoPush.register'));
  }

  unregister(): Promise<void> {
    return Promise.reject(new NotImplementedError('custom', 'expoPush.unregister'));
  }

  deliverSimulated(_raw: unknown): void {
    throw new NotImplementedError('custom', 'expoPush.deliverSimulated');
  }

  reportRejected(): void {
    throw new NotImplementedError('custom', 'expoPush.reportRejected');
  }

  checkNow(): Promise<void> {
    return Promise.reject(new NotImplementedError('custom', 'expoPush.checkNow'));
  }
}

/**
 * Exported for type-checking and future wiring only.
 *
 * Registering this today would break the app: every method throws. The local
 * bridge remains the active service until the push phase is implemented.
 */
export const expoPushNotificationServiceSeam: NotificationService =
  new ExpoPushNotificationService();
