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
 * Reads agent events from the local development bridge on this Mac.
 *
 *   bridge (node) -> this service -> NotificationBridge -> validation -> store
 *
 * Design notes:
 *   - Read-only. This service only ever issues GET requests; there is no code
 *     path that sends anything toward Windows.
 *   - No token. The bridge's read endpoint is loopback-restricted, so the
 *     shared secret stays on the Windows side and out of the app bundle.
 *   - Untrusted input. Events are handed to listeners as raw `unknown` and are
 *     validated downstream by the canonical protocol validator, exactly like
 *     simulated events.
 */

export interface LocalBridgeConfig {
  baseUrl: string;
  /** Poll interval in milliseconds. Conservative by default. */
  intervalMs: number;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** Upper bound for the backoff delay after repeated failures. */
  maxBackoffMs: number;
}

export const DEFAULT_BRIDGE_CONFIG: LocalBridgeConfig = {
  // Loopback: reachable from the Mac dev preview and the iOS Simulator.
  baseUrl: 'http://127.0.0.1:8787',
  intervalMs: 5000,
  timeoutMs: 4000,
  // A stopped bridge is polled ever more slowly, up to once a minute.
  maxBackoffMs: 60000,
};

const UNREGISTERED: DeviceRegistration = {
  registered: false,
  token: null,
  registeredAt: null,
  simulated: true,
};

function endpointLabel(baseUrl: string): string {
  return baseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

class LocalBridgeNotificationService implements NotificationService {
  readonly id = 'local-bridge';
  /** No cloud push exists; this is a local development transport. */
  readonly simulated = false;

  private config: LocalBridgeConfig = DEFAULT_BRIDGE_CONFIG;
  private listeners = new Set<RawEventListener>();
  private statusListeners = new Set<StatusListener>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Drives exponential backoff while the bridge is unreachable. */
  private consecutiveFailures = 0;
  /** Bridge sequence number of the newest event already delivered. */
  private cursor = 0;
  /**
   * Which bridge process the cursor belongs to. A restarted bridge resets its
   * sequence to 0, so the cursor must be reset with it or new events would be
   * skipped for as long as the old cursor stayed ahead.
   */
  private bridgeInstanceId: string | null = null;
  private polling = false;

  private status: NotificationStatus = {
    serviceId: 'local-bridge',
    simulated: false,
    transport: 'local-bridge',
    connectionState: 'unavailable',
    endpoint: endpointLabel(DEFAULT_BRIDGE_CONFIG.baseUrl),
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

  configure(config: Partial<LocalBridgeConfig>): void {
    this.config = { ...this.config, ...config };
    this.setStatus({ endpoint: endpointLabel(this.config.baseUrl) });
    if (this.timer) {
      this.stopPolling();
      this.startPolling();
    }
  }

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
    // Only poll while something is actually listening.
    if (this.listeners.size === 1) this.startPolling();

    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stopPolling();
    };
  }

  private startPolling(): void {
    if (this.timer) return;
    // Poll immediately, then reschedule from the result of each attempt.
    void this.pollAndReschedule();
  }

  private stopPolling(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Backoff schedule: `intervalMs` while healthy, doubling on each consecutive
   * failure up to `maxBackoffMs`. Avoids hammering a bridge that is stopped,
   * and returns to the normal cadence on the first success.
   */
  private nextDelay(): number {
    if (this.consecutiveFailures === 0) return this.config.intervalMs;
    const grown = this.config.intervalMs * 2 ** Math.min(this.consecutiveFailures, 6);
    return Math.min(grown, this.config.maxBackoffMs);
  }

  private async pollAndReschedule(): Promise<void> {
    await this.poll();
    // A concurrent stop (last listener left, or disabled) must win.
    if (this.listeners.size === 0 || !this.status.enabled) {
      this.stopPolling();
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.pollAndReschedule(), this.nextDelay());
  }

  /** Result of a single HTTP read. Never throws. */
  private async fetchSince(
    since: number,
  ): Promise<
    | { ok: true; cursor: number | null; events: unknown[]; instanceId: string | null }
    | { ok: false; error: string }
  > {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const url = `${this.config.baseUrl.replace(/\/$/, '')}/events?since=${since}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });

      if (!response.ok) return { ok: false, error: `bridge returned ${response.status}` };

      const body: unknown = await response.json();
      if (typeof body !== 'object' || body === null) {
        return { ok: false, error: 'malformed response from bridge' };
      }

      const { cursor, events, instanceId } = body as {
        cursor?: unknown;
        events?: unknown;
        instanceId?: unknown;
      };

      return {
        ok: true,
        cursor: typeof cursor === 'number' && Number.isFinite(cursor) ? cursor : null,
        events: Array.isArray(events) ? events : [],
        instanceId: typeof instanceId === 'string' ? instanceId : null,
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.name === 'AbortError'
            ? 'request timed out'
            : error.message
          : 'unknown error';
      return { ok: false, error: message };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** One polling cycle. Never throws; failures are reported through status. */
  private async poll(): Promise<void> {
    if (!this.status.enabled) return;
    // Skip if the previous request is still in flight.
    if (this.polling) return;
    this.polling = true;

    try {
      let result = await this.fetchSince(this.cursor);

      if (result.ok) {
        // A different instance id, or a sequence that moved backwards, means
        // the bridge restarted. Resync from the start of its new queue; the
        // store deduplicates by eventId, so replays cannot duplicate anything.
        const restarted =
          (result.instanceId !== null &&
            this.bridgeInstanceId !== null &&
            result.instanceId !== this.bridgeInstanceId) ||
          (result.cursor !== null && result.cursor < this.cursor);

        if (restarted) {
          this.cursor = 0;
          result = await this.fetchSince(0);
        }
      }

      if (!result.ok) {
        this.markUnavailable(result.error);
        return;
      }

      this.consecutiveFailures = 0;
      this.bridgeInstanceId = result.instanceId;
      this.setStatus({
        connectionState: 'connected',
        lastError: null,
        lastContactAt: new Date().toISOString(),
      });

      if (result.cursor !== null) this.cursor = result.cursor;

      for (const raw of result.events) {
        this.emit(raw, 'bridge');
      }
    } finally {
      this.polling = false;
    }
  }

  private markUnavailable(reason: string): void {
    this.consecutiveFailures += 1;
    this.setStatus({ connectionState: 'unavailable', lastError: reason });
  }

  /**
   * Records the event for display and hands the raw payload to listeners.
   *
   * Real bridge deliveries update the separate "real event" counters, so
   * Settings can report genuine Windows traffic without simulated events
   * inflating it.
   */
  private emit(raw: unknown, source: EventSource): void {
    const title =
      typeof raw === 'object' && raw !== null && typeof (raw as { title?: unknown }).title === 'string'
        ? (raw as { title: string }).title
        : 'Unknown event';

    const now = new Date().toISOString();
    this.setStatus({
      lastEventAt: now,
      lastEventTitle: title,
      ...(source === 'bridge'
        ? {
            lastRealEventAt: now,
            lastRealEventTitle: title,
            realEventCount: this.status.realEventCount + 1,
          }
        : {}),
    });

    this.listeners.forEach((listener) => listener(raw, source));
  }

  async requestPermissions(): Promise<PermissionStatus> {
    // The local bridge needs no OS permission; real push will.
    this.setStatus({ permission: 'granted' });
    return 'granted';
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.setStatus({ enabled });
    if (enabled) {
      this.consecutiveFailures = 0;
      if (this.listeners.size > 0) this.startPolling();
    } else {
      this.stopPolling();
      this.setStatus({ connectionState: 'unavailable', lastError: 'notifications disabled' });
    }
  }

  async register(): Promise<DeviceRegistration> {
    // No push infrastructure exists, so no registration can be claimed.
    this.setStatus({ registration: UNREGISTERED });
    return UNREGISTERED;
  }

  async unregister(): Promise<void> {
    this.setStatus({ registration: UNREGISTERED });
  }

  /** Keeps the in-app demo controls working alongside the real bridge. */
  deliverSimulated(raw: unknown): void {
    if (!this.status.enabled) return;
    // Explicitly 'simulated' so a development event is never counted or
    // labelled as a real Windows event.
    this.emit(raw, 'simulated');
  }

  reportRejected(): void {
    this.setStatus({ rejectedCount: this.status.rejectedCount + 1 });
  }

  async checkNow(): Promise<void> {
    await this.poll();
  }
}

export const localBridgeNotificationService = new LocalBridgeNotificationService();
