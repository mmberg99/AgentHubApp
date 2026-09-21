/*
 * AgentHub service worker — minimal foundation.
 *
 * SCOPE OF THIS VERSION
 *   Lifecycle only. It exists so the app is installable to the iOS Home Screen
 *   and so a push handler has somewhere to live later.
 *
 *   It deliberately does NOT cache application bundles. Expo's Metro web export
 *   emits hashed bundle filenames and an index.html that points at them, so a
 *   naive precache would happily serve a stale index referencing bundles that
 *   no longer exist — a broken app that is hard to recover from on a phone.
 *   A correct caching strategy needs the export's real asset manifest, which is
 *   a later, deliberate piece of work.
 *
 *   No push, no notifications, no network interception, no cloud dependency.
 */

const SW_VERSION = 'agenthub-sw-v1';

self.addEventListener('install', (event) => {
  // Nothing to precache yet; activate the new worker immediately.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Remove any caches left by a previous version of this worker.
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name.startsWith('agenthub-') && name !== SW_VERSION)
             .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

/*
 * ---------------------------------------------------------------------------
 * WEB PUSH
 * ---------------------------------------------------------------------------
 *
 * Events arrive from the Windows relay via Apple's push service. This worker
 * displays them and forwards them to any open page. It NEVER writes application
 * state: the page hands the raw payload to NotificationBridge, which runs
 * parseAgentNotificationEvent exactly as it does for every other transport.
 * Validation stays in one place.
 *
 * Every push shows a visible notification. WebKit requires a user-visible
 * result for each delivered push and may revoke the subscription otherwise, so
 * there is no silent path here — even an unparseable payload produces a
 * deliberately generic notification.
 *
 * The relay already constrains the text: it derives title/body from
 * toLockScreenNotification(), which emits fixed strings per event type. This
 * worker re-applies that constraint rather than trusting the wire, so a
 * tampered or malformed payload cannot put arbitrary prose on a lock screen.
 */

/** The only bodies allowed on a lock screen. Mirrors notificationPolicy.ts. */
const ALLOWED_BODIES = [
  'Task started',
  'Working on a task',
  'Idle',
  'Task completed',
  'Needs your approval',
  'Needs your input',
  'Task failed',
  // Subagent (child) activity. Same fixed vocabulary, never free text.
  'Subtask started',
  'Subtask running',
  'Subtask waiting',
  'Subtask completed',
  'Subtask failed',
];

const FALLBACK_TITLE = 'AgentHub';
const FALLBACK_BODY = 'Agent update';

/** Shallow shape check only. The app performs the authoritative validation. */
function looksLikeAgentEvent(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    value.version === 1 &&
    typeof value.eventId === 'string' &&
    typeof value.type === 'string'
  );
}

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let payload = null;
      try {
        payload = event.data ? event.data.json() : null;
      } catch {
        payload = null;
      }

      const agentEvent =
        payload && looksLikeAgentEvent(payload.data && payload.data.agentEvent)
          ? payload.data.agentEvent
          : null;

      // Re-apply the lock-screen policy. Anything not on the allow-list is
      // replaced, so the wire can never dictate arbitrary notification text.
      const rawTitle = payload && typeof payload.title === 'string' ? payload.title : '';
      const rawBody = payload && typeof payload.body === 'string' ? payload.body : '';
      const title = rawTitle.length > 0 && rawTitle.length <= 40 ? rawTitle : FALLBACK_TITLE;
      const body = ALLOWED_BODIES.includes(rawBody) ? rawBody : FALLBACK_BODY;

      // Only identity travels in notification.data — enough for the app to find
      // the event again on tap. Never the message prose.
      // `taskId` is the PARENT task even for a subagent's notification, so a
      // tap always opens the task the user recognises. Both are opaque hashes.
      const data = agentEvent
        ? {
            eventId: agentEvent.eventId,
            agentId: agentEvent.agentId,
            type: agentEvent.type,
            taskId: typeof agentEvent.taskId === 'string' ? agentEvent.taskId : undefined,
          }
        : {};

      await self.registration.showNotification(title, {
        body,
        data,
        // Coalesces repeats of the same event on iOS. The app dedupes by
        // eventId regardless, so double delivery is already harmless.
        tag: agentEvent ? agentEvent.eventId : undefined,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
      });

      // Hand the RAW event to any open page so Activity updates immediately.
      if (agentEvent) {
        const clients = await self.clients.matchAll({
          type: 'window',
          includeUncontrolled: true,
        });
        for (const client of clients) {
          client.postMessage({ type: 'agenthub:agent-event', raw: agentEvent });
        }
      }

      // Best effort; unsupported on some browsers and never fatal.
      if (self.navigator && typeof self.navigator.setAppBadge === 'function') {
        try {
          await self.navigator.setAppBadge();
        } catch {
          /* badge is cosmetic */
        }
      }
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      for (const client of clients) {
        if ('focus' in client) {
          // Pass the identity along so an already-open app can react.
          client.postMessage({ type: 'agenthub:notification-click', data });
          return client.focus();
        }
      }

      // Nothing open: launch at the root, naming the task in the query so Home
      // can open it once the startup history sync has delivered it. The root
      // (not /task/<id>) because the static host has no SPA fallback.
      const target =
        typeof data.taskId === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(data.taskId)
          ? `/?task=${encodeURIComponent(data.taskId)}`
          : '/';
      return self.clients.openWindow(target);
    })(),
  );
});
