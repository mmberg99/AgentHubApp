/**
 * The two listeners.
 *
 *   127.0.0.1:8781  INGESTION   POST /events              notifier -> relay
 *   127.0.0.1:8782  PWA API     POST /push/register       PWA -> relay
 *                               GET  /history
 *                               GET  /health
 *
 * They are separate http servers with separate route tables. The ingestion
 * router has no knowledge of the PWA routes and the PWA router has no knowledge
 * of /events, so "the notifier endpoint is not reachable from the tailnet" does
 * not depend on getting a path comparison right — the route simply does not
 * exist on the port Tailscale is pointed at.
 *
 * Nothing here executes, spawns, reads or writes anything derived from event
 * content. Events are inert data: validated, queued, pushed.
 *
 * The channel is one-way. No route returns a command, and none exists that
 * could carry one toward Windows.
 */

import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

import { API_PORT, BIND_HOST, INGEST_PORT, INGEST_TOKEN, MAX_BODY_BYTES, MAX_MESSAGE_BODY_BYTES } from './config.mjs';
import { conversations, parseConversationMessage } from './conversations.mjs';
import { EventHistory } from './history.mjs';
import { isFreshTransition, shouldPush } from './notificationPolicy.mjs';
import { deliverToAll, isConfigured } from './push.mjs';
import { findByCapabilityToken, loadSubscriptions, upsertSubscription } from './storage.mjs';
import { parseAgentNotificationEvent } from './validateAgentEvent.mjs';

export const history = new EventHistory();

/* ----------------------------------------------------------------- helpers */

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  // A 413 is answered while the client may still be uploading, so the
  // connection is closed rather than left to finish a body nobody will read.
  if (status === 413) res.setHeader('connection', 'close');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // This is a private API for one app; nothing should cache or embed it.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}

/** Reads a JSON body with a hard byte ceiling, destroying the socket if exceeded. */
function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve) => {
    let size = 0;
    let settled = false;
    const chunks = [];

    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        // Stop accumulating an oversized stream, but do NOT destroy the socket
        // here: the caller still has to write a 413, and a destroyed socket
        // would leave the client with no response at all.
        chunks.length = 0;
        settle({ ok: false, error: 'payload too large', tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        settle({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch {
        settle({ ok: false, error: 'body is not valid JSON' });
      }
    });

    req.on('error', () => settle({ ok: false, error: 'request error' }));
    req.on('aborted', () => settle({ ok: false, error: 'request aborted' }));
  });
}

function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/** Constant-time string comparison; false on any length mismatch. */
function secretEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Normalises the request path.
 *
 * VERIFIED EMPIRICALLY (Tailscale 1.102.4): `serve --set-path /api` STRIPS the
 * prefix before proxying, so a request to https://host/api/health arrives here
 * as /health. Probed with /api/api/health, which returned 200 — only possible
 * if exactly one /api was removed upstream.
 *
 * The /api spelling is still accepted. It costs one line and keeps the relay
 * correct if it is ever mounted without a prefix, reached directly on 8782, or
 * if Tailscale changes this behaviour in a later release.
 */
function normalisePath(pathname) {
  const clean = pathname.replace(/\/+$/, '') || '/';
  return clean.startsWith('/api/') ? clean.slice(4) : clean === '/api' ? '/' : clean;
}

/* --------------------------------------------------------- ingestion :8781 */

/**
 * POST /events — the only route on this port.
 *
 * Bearer token required. Loopback is not a trust boundary on Windows: any local
 * process can reach 127.0.0.1, so without the token any program on this machine
 * could put fabricated agent notifications on a phone's lock screen.
 */
async function handleIngest(req, res) {
  const url = new URL(req.url, `http://${BIND_HOST}`);
  const path = normalisePath(url.pathname);

  if (req.method !== 'POST' || (path !== '/events' && path !== '/messages')) {
    sendJson(res, 404, { ok: false, error: 'not found' });
    return;
  }

  if (!secretEquals(bearerToken(req) ?? '', INGEST_TOKEN)) {
    sendJson(res, 401, { ok: false, error: 'unauthorized' });
    return;
  }

  if (path === '/messages') {
    await handleMessage(req, res);
    return;
  }

  const body = await readJsonBody(req);
  if (!body.ok) {
    sendJson(res, body.tooLarge ? 413 : 400, { ok: false, error: body.error });
    return;
  }

  const parsed = parseAgentNotificationEvent(body.value);
  if (!parsed.ok) {
    // Reasons only. The rejected payload is untrusted and is never echoed.
    sendJson(res, 422, { ok: false, error: 'validation failed', reasons: parsed.errors });
    return;
  }

  // Decide the push BEFORE recording, so the previous type is the real
  // predecessor and not the event itself.
  const previousType = history.previousTypeFor(parsed.event);

  const isNew = history.add(parsed.event);
  if (!isNew) {
    // A retrying notifier must not produce a second notification.
    sendJson(res, 202, { ok: true, duplicate: true, pushed: false });
    return;
  }

  // Two gates: the type must be push-worthy (state-keeping events such as
  // started/running/idle are recorded but silent), and a `completed` must be
  // a fresh transition (one push per completion, never a repeat).
  const pushed = shouldPush(parsed.event.type) && isFreshTransition(parsed.event.type, previousType);

  const subscriptions = loadSubscriptions();
  let delivery = { sent: 0, failed: 0, pruned: 0 };
  if (pushed && isConfigured() && subscriptions.length > 0) {
    delivery = await deliverToAll(parsed.event, subscriptions);
  }

  // Small status only, as specified. Nothing about the event is reflected back.
  // `pushed` is the policy decision; `sent` is how many devices were reached.
  sendJson(res, 202, { ok: true, pushed, sent: delivery.sent });
}

/**
 * POST /messages — one user-visible conversation message (prompt or visible
 * assistant response) from the notifier. Same token, same loopback listener.
 * Larger body ceiling than status events; strict allow-list validation; the
 * text is stored durably and NEVER pushed. The reply reflects nothing back.
 */
async function handleMessage(req, res) {
  const body = await readJsonBody(req, MAX_MESSAGE_BODY_BYTES);
  if (!body.ok) {
    sendJson(res, body.tooLarge ? 413 : 400, { ok: false, error: body.error });
    return;
  }
  const parsed = parseConversationMessage(body.value);
  if (!parsed.ok) {
    sendJson(res, 422, { ok: false, error: 'validation failed', reasons: parsed.errors });
    return;
  }
  const result = await conversations.add(parsed.message);
  sendJson(res, 202, { ok: true, stored: result.stored, duplicate: result.duplicate });
}

/* ------------------------------------------------------------- pwa api :8782 */

/** POST /push/register — store a subscription, mint its capability token. */
async function handleRegister(req, res) {
  const body = await readJsonBody(req);
  if (!body.ok) {
    sendJson(res, body.tooLarge ? 413 : 400, { ok: false, error: body.error });
    return;
  }

  const value = body.value;
  const endpoint = value?.endpoint;
  const p256dh = value?.keys?.p256dh;
  const auth = value?.keys?.auth;

  // Allow-list of exactly three fields; everything else in the payload is
  // discarded and never stored. No User-Agent, no IP, no device name.
  const valid =
    typeof endpoint === 'string' &&
    endpoint.length > 0 &&
    endpoint.length <= 2048 &&
    /^https:\/\//.test(endpoint) &&
    typeof p256dh === 'string' &&
    p256dh.length > 0 &&
    p256dh.length <= 256 &&
    typeof auth === 'string' &&
    auth.length > 0 &&
    auth.length <= 256;

  if (!valid) {
    sendJson(res, 400, { ok: false, error: 'malformed subscription' });
    return;
  }

  const token = await upsertSubscription({ endpoint, p256dh, auth });

  // The token is returned exactly once, to the device that just registered.
  // Only its SHA-256 hash is kept, so the relay can never reveal it again.
  sendJson(res, 200, { ok: true, historyToken: token });
}

/** GET /history?since=N — requires that device's capability token. */
function handleHistory(req, res, url) {
  const token = bearerToken(req);
  const record = findByCapabilityToken(token ?? '');

  if (!record) {
    sendJson(res, 401, { ok: false, error: 'unauthorized' });
    return;
  }

  const since = Number.parseInt(url.searchParams.get('since') ?? '0', 10);
  // Only the event stream is returned. No subscription is ever enumerated
  // through any route, including this one.
  sendJson(res, 200, history.since(since));
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${BIND_HOST}`);
  const path = normalisePath(url.pathname);

  if (path === '/push/register' && req.method === 'POST') {
    await handleRegister(req, res);
    return;
  }
  if (path === '/history' && req.method === 'GET') {
    handleHistory(req, res, url);
    return;
  }
  if (path === '/health' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, instanceId: history.instanceId, push: isConfigured() });
    return;
  }
  // Conversation READS only, behind the same per-device capability token as
  // /history. There is no write route here: the phone cannot inject text.
  if (path === '/conversations' && req.method === 'GET') {
    if (!findByCapabilityToken(bearerToken(req) ?? '')) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    sendJson(res, 200, { ok: true, conversations: conversations.summaries() });
    return;
  }
  const conversationMatch = /^\/conversation\/([A-Za-z0-9:_-]{1,128})$/.exec(path);
  if (conversationMatch && req.method === 'GET') {
    if (!findByCapabilityToken(bearerToken(req) ?? '')) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    const conv = conversations.get(conversationMatch[1]);
    if (!conv) {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }
    sendJson(res, 200, { ok: true, conversation: conv });
    return;
  }

  // /events and /messages are deliberately absent from this router.
  sendJson(res, 404, { ok: false, error: 'not found' });
}

/* -------------------------------------------------------------- lifecycle */

function guard(handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' });
    });
  };
}

export function createServers() {
  const ingest = createServer(guard(handleIngest));
  const api = createServer(guard(handleApi));
  // Slowloris hygiene; these are tiny local requests.
  ingest.headersTimeout = 5000;
  ingest.requestTimeout = 10000;
  api.headersTimeout = 5000;
  api.requestTimeout = 10000;
  return { ingest, api };
}

export function start() {
  const { ingest, api } = createServers();
  return new Promise((resolve) => {
    ingest.listen(INGEST_PORT, BIND_HOST, () => {
      api.listen(API_PORT, BIND_HOST, () => {
        resolve({ ingest, api });
      });
    });
  });
}
