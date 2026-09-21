import type { AgentNotificationEvent } from '../../protocol';
import type { LockScreenNotification } from './notificationPolicy';

/**
 * PUSH PAYLOAD CONTRACT — standards-based Web Push.
 *
 * The Windows relay transmits the SAME `AgentNotificationEvent` used by every
 * other transport, nested under `data.agentEvent`. There is no push-specific
 * event schema, and the app's existing validator remains the trust boundary:
 * the payload is untrusted input that must pass `parseAgentNotificationEvent`
 * before anything reaches the store.
 *
 * `title`/`body` are display-only, derived by `toLockScreenNotification`. The
 * app never reads them — it reads `data.agentEvent` — so a tampered title can
 * change what a notification looks like but can never affect app state. The
 * service worker additionally re-checks the body against the policy allow-list.
 *
 * TRANSPORT
 *   RFC 8291 encrypted, RFC 8292 (VAPID) signed, delivered to the subscription
 *   endpoint the browser chose (`web.push.apple.com` on iOS). The destination
 *   lives in the PushSubscription held by the relay, so — unlike the previous
 *   Expo design — there is no `to` field in the message body itself.
 */

/**
 * Apple's Web Push service rejects payloads larger than 4 KB.
 *
 * Protocol field caps keep a well-formed event near ~800 bytes; this guards
 * against a notifier that grows the schema.
 */
export const MAX_PUSH_PAYLOAD_BYTES = 4096;

export interface AgentEventPushData {
  /** The one and only place app state is derived from. */
  agentEvent: AgentNotificationEvent;
}

/**
 * The JSON body the relay encrypts and sends.
 *
 * Deliberately minimal: no `to`, no sound, no priority. Web Push carries the
 * destination in the subscription and leaves presentation to the service
 * worker, which is where `showNotification` is called.
 */
export interface AgentEventPushMessage extends LockScreenNotification {
  data: AgentEventPushData;
}

/**
 * Pulls the candidate event out of a received push payload's `data`.
 *
 * Returns `unknown` on purpose. This function performs NO validation: it only
 * narrows where to look. The caller must pass the result to
 * `parseAgentNotificationEvent`, so a malformed or hostile payload is rejected
 * by exactly the same code path as a bridge event.
 */
export function extractAgentEventPayload(data: unknown): unknown {
  if (typeof data !== 'object' || data === null) return undefined;
  return (data as { agentEvent?: unknown }).agentEvent;
}

/**
 * Byte size of a prospective message, for the relay to check before sending.
 */
export function estimatePayloadBytes(message: AgentEventPushMessage): number {
  // Counted by hand rather than with Buffer or TextEncoder, so the helper works
  // unchanged in the app and in the Node relay.
  return utf8ByteLength(JSON.stringify(message));
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // Surrogate pair: one 4-byte character, so skip its low half.
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

export function isWithinPayloadLimit(message: AgentEventPushMessage): boolean {
  return estimatePayloadBytes(message) <= MAX_PUSH_PAYLOAD_BYTES;
}
