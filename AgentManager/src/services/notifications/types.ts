/**
 * Notification transport abstraction.
 *
 * The UI talks to this interface only — never to Expo, APNs or any other
 * vendor API directly. Swapping the mock for a real push implementation should
 * therefore touch exactly one file (the registry in `notificationService.ts`).
 */

import type { EventSource } from '../../types';

export type { EventSource };

export type PermissionStatus = 'undetermined' | 'granted' | 'denied';

/** Which transport is actually carrying events right now. */
export type TransportKind = 'none' | 'simulated' | 'local-bridge' | 'expo-push' | 'web-push';

/**
 * Honest description of the live connection, surfaced directly in Settings.
 *
 * 'simulated'   - nothing is connected; events come from the in-app controls.
 * 'connected'   - a real transport answered on the last attempt.
 * 'unavailable' - a real transport is configured but not reachable.
 */
export type ConnectionState = 'simulated' | 'connected' | 'unavailable';

export interface DeviceRegistration {
  registered: boolean;
  /**
   * Push token, or null when none exists. For simulated registrations this is
   * a clearly fake placeholder — never a real APNs/Expo token.
   */
  token: string | null;
  registeredAt: string | null;
  /** True when this registration is local make-believe, not a real device token. */
  simulated: boolean;
}

export interface NotificationStatus {
  serviceId: string;
  /** True when no real push infrastructure is connected. */
  simulated: boolean;
  transport: TransportKind;
  connectionState: ConnectionState;
  /** Human-readable endpoint, e.g. "127.0.0.1:8787". Null when none. */
  endpoint: string | null;
  /** Why the last connection attempt failed, for display. Null when healthy. */
  lastError: string | null;
  /** ISO timestamp of the last successful contact with the transport. */
  lastContactAt: string | null;
  enabled: boolean;
  permission: PermissionStatus;
  registration: DeviceRegistration;
  /** ISO timestamp of the most recent event delivered through this service. */
  lastEventAt: string | null;
  /** Title of that event, for display in Settings. */
  lastEventTitle: string | null;
  /**
   * The most recent REAL event (one that arrived over a transport), kept apart
   * from simulated ones so Settings can never conflate the two.
   */
  lastRealEventAt: string | null;
  lastRealEventTitle: string | null;
  /** Real events received since the app started. Excludes simulated events. */
  realEventCount: number;
  /** Count of payloads rejected by protocol validation. */
  rejectedCount: number;
}

/**
 * Listener receives the RAW, untrusted payload plus the transport that carried
 * it. Validation happens downstream in the store so that every path —
 * simulated, local bridge, or future push — is validated identically and none
 * can bypass it.
 *
 * `source` exists so a real event can never be rendered as simulated, or the
 * reverse.
 */
export type RawEventListener = (raw: unknown, source: EventSource) => void;

export type StatusListener = (status: NotificationStatus) => void;

export interface NotificationService {
  readonly id: string;
  /** True when this implementation cannot receive real remote events. */
  readonly simulated: boolean;

  getStatus(): NotificationStatus;
  subscribeStatus(listener: StatusListener): () => void;

  /** Subscribe to inbound events. Returns an unsubscribe function. */
  subscribe(listener: RawEventListener): () => void;

  requestPermissions(): Promise<PermissionStatus>;
  setEnabled(enabled: boolean): Promise<void>;
  register(): Promise<DeviceRegistration>;
  unregister(): Promise<void>;

  /**
   * Inject an event locally, for development and testing.
   *
   * Accepts `unknown` deliberately: test payloads travel the same validation
   * path as real ones, so a malformed simulated event fails exactly as a
   * malformed remote event would.
   */
  deliverSimulated(raw: unknown): void;

  /** Notifies the service that a delivered payload failed validation. */
  reportRejected(): void;

  /**
   * Forces an immediate connection attempt, where the transport supports one.
   * Simulated transports resolve immediately without doing anything.
   */
  checkNow(): Promise<void>;
}
