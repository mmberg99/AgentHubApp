/**
 * Web Push delivery.
 *
 *   relay --(RFC 8291 encrypted, RFC 8292 VAPID-signed)--> web.push.apple.com
 *                                                      --> iPhone service worker
 *
 * Outbound HTTPS only. No inbound port is opened anywhere for this to work,
 * which is the whole reason Web Push replaces the LAN bridge: Apple's push
 * service is the one doing the reaching-in, over a connection the phone itself
 * established.
 *
 * Payload shape matches the contract in AgentManager's `pushPayload.ts`:
 * `data.agentEvent` carries the SAME AgentNotificationEvent used everywhere
 * else. There is no push-specific event schema, and the app re-validates it.
 *
 * `title`/`body` are display-only and are derived exclusively by
 * `toLockScreenNotification`. They are asserted against the policy before every
 * send, so a future edit that tried to interpolate event prose into a lock
 * screen would fail loudly here instead of silently leaking.
 */

import webpush from 'web-push';

import { MAX_PUSH_PAYLOAD_BYTES } from './config.mjs';
import { isPolicyApprovedBody, toLockScreenNotification } from './notificationPolicy.mjs';
import { removeSubscription } from './storage.mjs';

let configured = false;

export function configureVapid({ publicKey, privateKey, subject }) {
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
}

export function isConfigured() {
  return configured;
}

/**
 * Build the push body for one event.
 *
 * Exported so tests can assert the lock-screen policy and the size ceiling
 * without performing a network call.
 */
export function buildPushPayload(event) {
  const { title, body } = toLockScreenNotification(event);

  // Belt and braces: the policy module is the only producer of these strings,
  // and this proves it at the moment of use.
  if (!isPolicyApprovedBody(body)) {
    throw new Error('refusing to send: notification body is not policy-approved');
  }
  if (title.includes(event.message) && event.message.length > 0) {
    throw new Error('refusing to send: event message leaked into notification title');
  }

  return JSON.stringify({ title, body, data: { agentEvent: event } });
}

/**
 * Deliver one event to every registered subscription.
 *
 * A 404 or 410 from the push service is the documented signal that a
 * subscription is permanently gone (app deleted, Home Screen icon removed), so
 * that record is pruned. Any other failure is reported but kept, because it is
 * probably transient.
 *
 * Never throws: a push failure must not take the relay down or fail the
 * notifier's request.
 */
export async function deliverToAll(event, subscriptions) {
  const payload = buildPushPayload(event);

  if (Buffer.byteLength(payload, 'utf8') > MAX_PUSH_PAYLOAD_BYTES) {
    return { sent: 0, failed: 0, pruned: 0, error: 'payload exceeds push size limit' };
  }

  let sent = 0;
  let failed = 0;
  let pruned = 0;

  for (const record of subscriptions) {
    const subscription = {
      endpoint: record.endpoint,
      keys: { p256dh: record.p256dh, auth: record.auth },
    };

    try {
      await webpush.sendNotification(subscription, payload, { TTL: 60 });
      sent += 1;
    } catch (error) {
      const status = error?.statusCode;
      if (status === 404 || status === 410) {
        await removeSubscription(record.endpoint);
        pruned += 1;
      } else {
        failed += 1;
      }
      // Status code only. A push service error body can echo request details,
      // and this process handles a private key -- nothing verbose gets logged.
      console.error(`[relay] push failed (status ${status ?? 'unknown'})`);
    }
  }

  return { sent, failed, pruned };
}
