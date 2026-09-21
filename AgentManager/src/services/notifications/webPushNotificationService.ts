import { Platform } from 'react-native';

import { getServiceWorkerRegistration } from '../pwa';
import { RELAY_API_BASE, VAPID_PUBLIC_KEY } from './pushConfig';
import type {
  DeviceRegistration,
  EventSource,
  NotificationService,
  NotificationStatus,
  PermissionStatus,
  RawEventListener,
  StatusListener,
} from './types';

/**
 * Standards-based Web Push transport.
 *
 *   Windows relay --(RFC 8291 / VAPID)--> Apple --> service worker
 *                                                     |
 *                    postMessage (open app) ----------+
 *                    GET /api/history (launch/resume)
 *                                                     v
 *                          this service -> NotificationBridge
 *                          -> parseAgentNotificationEvent  <- trust boundary
 *                          -> ingestRemoteEvent
 *
 * Two delivery paths, one pipeline. A push received while the app is open
 * arrives by `postMessage`; anything that happened while the app was closed is
 * fetched from the relay's bounded history on launch/resume. Both emit the raw
 * payload as `unknown`, so the app's validator runs identically on each and
 * neither can bypass it.
 *
 * Replay is safe by construction: the store dedupes on `remote_<eventId>`, so
 * an event delivered by push AND returned by history is applied exactly once.
 *
 * SECRETS
 *   Only the VAPID PUBLIC key is present here — it is transmitted to the push
 *   service on every subscription and is public by design. The capability token
 *   returned by the relay is minted per device, stored in localStorage, and
 *   never logged. No shared secret is compiled into the bundle.
 */

/** Per-device, per-origin. Never leaves this browser except as a Bearer header. */
const TOKEN_KEY = 'agenthub.push.historyToken';
const CURSOR_KEY = 'agenthub.push.cursor';
const INSTANCE_KEY = 'agenthub.push.instanceId';

const UNREGISTERED: DeviceRegistration = {
  registered: false,
  token: null,
  registeredAt: null,
  simulated: false,
};

/* ------------------------------------------------------------- local store */

/**
 * localStorage access that cannot throw.
 *
 * Private windows, blocked site data and thumbnail capture can all make these
 * accessors fail, and a failure here must degrade to "not enabled" rather than
 * crash the Settings screen.
 */
function readLocal(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable; the session still works, it just will not resume */
  }
}

/**
 * VAPID keys are urlsafe-base64; PushManager wants raw bytes.
 *
 * Backed by an explicit ArrayBuffer so the result is `Uint8Array<ArrayBuffer>`
 * rather than `Uint8Array<ArrayBufferLike>`: `applicationServerKey` requires a
 * BufferSource that cannot be shared memory.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalised = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalised);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

function arrayBufferToBase64Url(buffer: ArrayBuffer | null): string {
  if (!buffer) return '';
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ------------------------------------------------------------------ service */

class WebPushNotificationService implements NotificationService {
  readonly id = 'web-push';
  /** Real remote transport, not make-believe. */
  readonly simulated = false;

  private listeners = new Set<RawEventListener>();
  private statusListeners = new Set<StatusListener>();
  private messageBound = false;
  private syncing = false;

  private status: NotificationStatus = {
    serviceId: 'web-push',
    simulated: false,
    transport: 'web-push',
    connectionState: 'unavailable',
    endpoint: RELAY_API_BASE,
    lastError: null,
    lastContactAt: null,
    enabled: true,
    permission: 'undetermined',
    registration: UNREGISTERED,
    lastEventAt: null,
    lastEventTitle: null,
    lastRealEventAt: null,
    lastRealEventTitle: null,
    realEventCount: 0,
    rejectedCount: 0,
  };

  constructor() {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      this.status = { ...this.status, permission: this.readPermission() };
      if (this.hasToken()) {
        this.status = {
          ...this.status,
          registration: { registered: true, token: null, registeredAt: null, simulated: false },
        };
      }
    }
  }

  /* ------------------------------------------------------------- plumbing */

  getStatus(): NotificationStatus {
    return this.status;
  }

  private setStatus(patch: Partial<NotificationStatus>): void {
    this.status = { ...this.status, ...patch };
    this.statusListeners.forEach((listener) => listener(this.status));
  }

  subscribeStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  subscribe(listener: RawEventListener): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      this.bindServiceWorkerMessages();
      this.bindResume();
      void this.syncHistory();
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(raw: unknown, source: EventSource): void {
    const title =
      typeof raw === 'object' && raw !== null && typeof (raw as { title?: unknown }).title === 'string'
        ? (raw as { title: string }).title
        : 'Unknown event';

    const now = new Date().toISOString();
    this.setStatus({
      lastEventAt: now,
      lastEventTitle: title,
      ...(source !== 'simulated'
        ? {
            lastRealEventAt: now,
            lastRealEventTitle: title,
            realEventCount: this.status.realEventCount + 1,
          }
        : {}),
    });

    this.listeners.forEach((listener) => listener(raw, source));
  }

  /** Pushes that land while the app is open arrive here from the worker. */
  private bindServiceWorkerMessages(): void {
    if (this.messageBound) return;
    if (Platform.OS !== 'web') return;
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
      const data = event.data;
      if (typeof data !== 'object' || data === null) return;
      if ((data as { type?: unknown }).type !== 'agenthub:agent-event') return;
      // Raw and untrusted, exactly like a bridge payload.
      this.emit((data as { raw?: unknown }).raw, 'push');
    });

    this.messageBound = true;
  }

  /** Anything missed while the app was closed is pulled on resume. */
  private bindResume(): void {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.syncHistory();
    });
  }

  /* -------------------------------------------------------------- history */

  private hasToken(): boolean {
    return (readLocal(TOKEN_KEY) ?? '').length > 0;
  }

  /**
   * The per-device capability token, for the read-only conversation routes
   * that share /history's authentication. Null when not registered. Never
   * displayed; only ever sent as a bearer header to the relay's /api.
   */
  capabilityToken(): string | null {
    const token = readLocal(TOKEN_KEY);
    return token && token.length > 0 ? token : null;
  }

  /**
   * Fetch events newer than the stored cursor.
   *
   * Relay restart handling mirrors the local bridge: a changed `instanceId` or
   * a cursor that moved backwards means this cursor belongs to a previous
   * process, so it resyncs from 0. The store's eventId dedupe makes the replay
   * harmless.
   */
  async syncHistory(): Promise<void> {
    if (Platform.OS !== 'web') return;
    if (this.syncing) return;

    const token = readLocal(TOKEN_KEY);
    if (!token) return;

    this.syncing = true;
    try {
      let cursor = Number.parseInt(readLocal(CURSOR_KEY) ?? '0', 10);
      if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;

      let result = await this.fetchHistory(token, cursor);

      if (result.ok) {
        const knownInstance = readLocal(INSTANCE_KEY);
        const restarted =
          (knownInstance !== null && result.instanceId !== knownInstance) ||
          result.cursor < cursor;
        if (restarted) {
          cursor = 0;
          result = await this.fetchHistory(token, 0);
        }
      }

      if (!result.ok) {
        this.setStatus({ connectionState: 'unavailable', lastError: result.error });
        return;
      }

      this.setStatus({
        connectionState: 'connected',
        lastError: null,
        lastContactAt: new Date().toISOString(),
      });

      writeLocal(INSTANCE_KEY, result.instanceId);
      writeLocal(CURSOR_KEY, String(result.cursor));

      for (const raw of result.events) {
        this.emit(raw, 'push');
      }
    } finally {
      this.syncing = false;
    }
  }

  private async fetchHistory(
    token: string,
    since: number,
  ): Promise<
    | { ok: true; instanceId: string; cursor: number; events: unknown[] }
    | { ok: false; error: string }
  > {
    try {
      const response = await fetch(`${RELAY_API_BASE}/history?since=${since}`, {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      });

      if (response.status === 401) {
        // The relay no longer knows this device — its subscription was pruned.
        // Clear local state so Settings honestly shows "not enabled".
        writeLocal(TOKEN_KEY, null);
        writeLocal(CURSOR_KEY, null);
        writeLocal(INSTANCE_KEY, null);
        this.setStatus({ registration: UNREGISTERED });
        return { ok: false, error: 'registration expired; enable notifications again' };
      }
      if (!response.ok) return { ok: false, error: `relay returned ${response.status}` };

      const body: unknown = await response.json();
      if (typeof body !== 'object' || body === null) {
        return { ok: false, error: 'malformed response from relay' };
      }

      const { instanceId, cursor, events } = body as {
        instanceId?: unknown;
        cursor?: unknown;
        events?: unknown;
      };

      return {
        ok: true,
        instanceId: typeof instanceId === 'string' ? instanceId : '',
        cursor: typeof cursor === 'number' && Number.isFinite(cursor) ? cursor : since,
        events: Array.isArray(events) ? events : [],
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'network error' };
    }
  }

  /* ----------------------------------------------------------- enablement */

  private readPermission(): PermissionStatus {
    if (typeof Notification === 'undefined') return 'undetermined';
    if (Notification.permission === 'granted') return 'granted';
    if (Notification.permission === 'denied') return 'denied';
    return 'undetermined';
  }

  /**
   * Requests OS notification permission.
   *
   * MUST be called from a direct user gesture — WebKit rejects it otherwise,
   * and requesting unprompted is hostile regardless. Nothing in this module
   * calls it automatically; only the Settings button does.
   */
  async requestPermissions(): Promise<PermissionStatus> {
    if (Platform.OS !== 'web' || typeof Notification === 'undefined') {
      this.setStatus({ permission: 'denied' });
      return 'denied';
    }

    try {
      const result = await Notification.requestPermission();
      const permission: PermissionStatus =
        result === 'granted' ? 'granted' : result === 'denied' ? 'denied' : 'undetermined';
      this.setStatus({ permission });
      return permission;
    } catch {
      this.setStatus({ permission: 'denied' });
      return 'denied';
    }
  }

  /**
   * Subscribes with PushManager and registers the subscription with the relay.
   *
   * Only the three fields the relay needs are sent: endpoint, p256dh, auth.
   * The relay replies with a capability token scoped to history access for this
   * device, which is stored locally and never logged.
   */
  async register(): Promise<DeviceRegistration> {
    if (Platform.OS !== 'web') return UNREGISTERED;

    if (VAPID_PUBLIC_KEY.length === 0) {
      this.setStatus({ lastError: 'no VAPID public key configured in this build' });
      return UNREGISTERED;
    }

    const registration = await getServiceWorkerRegistration();
    if (!registration || !('pushManager' in registration)) {
      this.setStatus({ lastError: 'service worker unavailable' });
      return UNREGISTERED;
    }

    try {
      // Reuse an existing subscription when the browser already has one.
      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        }));

      const p256dh = arrayBufferToBase64Url(subscription.getKey('p256dh'));
      const auth = arrayBufferToBase64Url(subscription.getKey('auth'));

      const response = await fetch(`${RELAY_API_BASE}/push/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: subscription.endpoint, keys: { p256dh, auth } }),
      });

      if (!response.ok) {
        this.setStatus({ lastError: `relay rejected registration (${response.status})` });
        return UNREGISTERED;
      }

      const body = (await response.json()) as { historyToken?: unknown };
      if (typeof body.historyToken !== 'string' || body.historyToken.length === 0) {
        this.setStatus({ lastError: 'relay did not return a history token' });
        return UNREGISTERED;
      }

      writeLocal(TOKEN_KEY, body.historyToken);
      // A fresh registration starts from the beginning of the relay's history.
      writeLocal(CURSOR_KEY, '0');
      writeLocal(INSTANCE_KEY, null);

      const result: DeviceRegistration = {
        registered: true,
        // Deliberately not the push endpoint or the token: neither belongs in
        // a status object that Settings renders.
        token: null,
        registeredAt: new Date().toISOString(),
        simulated: false,
      };

      this.setStatus({
        registration: result,
        lastError: null,
        connectionState: 'connected',
        lastContactAt: new Date().toISOString(),
      });

      void this.syncHistory();
      return result;
    } catch (error) {
      this.setStatus({
        lastError: error instanceof Error ? error.message : 'subscription failed',
      });
      return UNREGISTERED;
    }
  }

  async unregister(): Promise<void> {
    writeLocal(TOKEN_KEY, null);
    writeLocal(CURSOR_KEY, null);
    writeLocal(INSTANCE_KEY, null);
    try {
      const registration = await getServiceWorkerRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      await subscription?.unsubscribe();
    } catch {
      /* the local token is already gone, which is what matters */
    }
    this.setStatus({ registration: UNREGISTERED, connectionState: 'unavailable' });
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.setStatus({ enabled });
  }

  /** Keeps the in-app demo controls working alongside real push. */
  deliverSimulated(raw: unknown): void {
    if (!this.status.enabled) return;
    this.emit(raw, 'simulated');
  }

  reportRejected(): void {
    this.setStatus({ rejectedCount: this.status.rejectedCount + 1 });
  }

  async checkNow(): Promise<void> {
    await this.syncHistory();
  }
}

export const webPushNotificationService = new WebPushNotificationService();
