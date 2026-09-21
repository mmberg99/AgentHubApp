#!/usr/bin/env node
/**
 * AgentHub local development bridge.
 *
 *   Windows notifier --(LAN HTTP POST + bearer token)--> this process
 *   AgentHub app     --(loopback HTTP GET, no token)---> this process
 *
 * Scope and limits, deliberately:
 *   - Local trusted network only. Never port-forward this or expose it publicly.
 *   - One-way. There is no route that sends anything toward Windows, and
 *     nothing here ever executes, spawns, reads or writes based on event
 *     contents. Events are inert data that is queued and handed to the app.
 *   - Memory only. No database, no disk persistence. Restarting clears the queue.
 *
 * Node built-ins only — no dependencies to install.
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

const PORT = Number(process.env.AGENTHUB_BRIDGE_PORT ?? 8787);
/** 0.0.0.0 so the Windows machine can reach it over the LAN. */
const HOST = process.env.AGENTHUB_BRIDGE_HOST ?? '0.0.0.0';
const TOKEN = process.env.AGENTHUB_BRIDGE_TOKEN ?? '';
const MIN_TOKEN_LENGTH = 16;

/** Conservative cap: a valid event is a few hundred bytes. */
const MAX_BODY_BYTES = 8 * 1024;
/** Bounded queue; oldest entries are dropped once full. */
const MAX_QUEUE = 200;
/** How many recent event ids to remember for duplicate suppression. */
const MAX_SEEN_IDS = 1000;

if (TOKEN.length < MIN_TOKEN_LENGTH) {
  console.error(
    `[bridge] refusing to start: AGENTHUB_BRIDGE_TOKEN must be set to at least ` +
      `${MIN_TOKEN_LENGTH} characters.\n` +
      `[bridge] generate one with:  node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`,
  );
  process.exit(1);
}

// Compare hashes so the check is constant-time regardless of input length.
// The token itself is never logged, echoed or written anywhere.
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest();

/* -------------------------------------------------------------------------- */
/* Protocol validation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Mirrors `src/protocol/validateAgentEvent.ts`. That TypeScript module is the
 * canonical spec — keep the two in sync when the protocol changes.
 *
 * This is a first line of defence only: the app revalidates every payload with
 * the canonical validator before anything reaches application state, so a gap
 * here cannot inject bad data into the UI.
 */
const EVENT_TYPES = new Set([
  'started',
  'running',
  'completed',
  'needs_approval',
  'needs_input',
  'failed',
]);
const PROVIDERS = new Set(['claude', 'openai', 'custom']);
const LIMITS = {
  eventId: 128,
  agentId: 128,
  agentName: 80,
  taskId: 128,
  title: 120,
  message: 500,
};

function clean(value) {
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
}

function readString(source, key, errors, { required, max, truncate }) {
  const raw = source[key];
  if (raw === undefined || raw === null) {
    if (required) errors.push(`"${key}" is required`);
    return undefined;
  }
  if (typeof raw !== 'string') {
    errors.push(`"${key}" must be a string`);
    return undefined;
  }
  const value = clean(raw);
  if (value.length === 0) {
    if (required) errors.push(`"${key}" must not be empty`);
    return undefined;
  }
  if (value.length > max) {
    if (truncate) return `${value.slice(0, max - 1)}…`;
    errors.push(`"${key}" exceeds ${max} characters`);
    return undefined;
  }
  return value;
}

/** Allow-list validation: the result is rebuilt field by field. */
function validateEvent(input) {
  const errors = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['payload must be a JSON object'] };
  }

  if (input.version !== 1) errors.push('"version" must be 1');

  const eventId = readString(input, 'eventId', errors, { required: true, max: LIMITS.eventId });
  const agentId = readString(input, 'agentId', errors, { required: true, max: LIMITS.agentId });
  const agentName = readString(input, 'agentName', errors, {
    required: true,
    max: LIMITS.agentName,
    truncate: true,
  });
  const title = readString(input, 'title', errors, {
    required: true,
    max: LIMITS.title,
    truncate: true,
  });
  const message = readString(input, 'message', errors, {
    required: true,
    max: LIMITS.message,
    truncate: true,
  });
  const taskId = readString(input, 'taskId', errors, { required: false, max: LIMITS.taskId });

  if (typeof input.type !== 'string' || !EVENT_TYPES.has(input.type)) {
    errors.push(`"type" must be one of: ${[...EVENT_TYPES].join(', ')}`);
  }

  let provider;
  if (input.provider !== undefined && input.provider !== null) {
    if (typeof input.provider !== 'string' || !PROVIDERS.has(input.provider)) {
      errors.push(`"provider" must be one of: ${[...PROVIDERS].join(', ')}`);
    } else {
      provider = input.provider;
    }
  }

  let timestamp;
  if (typeof input.timestamp !== 'string') {
    errors.push('"timestamp" must be an ISO 8601 string');
  } else {
    const parsed = new Date(input.timestamp);
    if (Number.isNaN(parsed.getTime())) errors.push('"timestamp" is not a valid date');
    else timestamp = parsed.toISOString();
  }

  if (errors.length > 0) return { ok: false, errors };

  const event = {
    version: 1,
    eventId,
    agentId,
    agentName,
    type: input.type,
    title,
    message,
    timestamp,
  };
  if (taskId) event.taskId = taskId;
  if (provider) event.provider = provider;

  return { ok: true, event };
}

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Identifies this process. Sequence numbers restart from 0 whenever the bridge
 * restarts, so the app compares this id to detect a restart and resync from the
 * beginning of the new queue instead of silently skipping events.
 */
const INSTANCE_ID = randomUUID();

let sequence = 0;
/** @type {{ seq: number, event: object }[]} */
const queue = [];
/** Insertion-ordered set of recently accepted event ids. */
const seenIds = new Set();
const stats = { accepted: 0, rejected: 0, unauthorized: 0, duplicates: 0, startedAt: Date.now() };

function enqueue(event) {
  sequence += 1;
  queue.push({ seq: sequence, event });
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);

  seenIds.add(event.eventId);
  if (seenIds.size > MAX_SEEN_IDS) {
    // Sets preserve insertion order, so the first key is the oldest.
    seenIds.delete(seenIds.values().next().value);
  }
  return sequence;
}

/* -------------------------------------------------------------------------- */
/* HTTP helpers                                                               */
/* -------------------------------------------------------------------------- */

function send(res, statusCode, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

function isLoopback(req) {
  const addr = req.socket.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function isAuthorized(req) {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const provided = createHash('sha256').update(match[1].trim()).digest();
  return timingSafeEqual(provided, TOKEN_HASH);
}

/** Narrow CORS so the browser-based dev preview can read the queue. */
function corsHeadersFor(req) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return {};
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return {};
  return { 'access-control-allow-origin': origin, vary: 'Origin' };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop reading, but leave the socket alive long enough to answer 413.
        req.pause();
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* -------------------------------------------------------------------------- */
/* Routes                                                                     */
/* -------------------------------------------------------------------------- */

async function handlePost(req, res) {
  if (!isAuthorized(req)) {
    stats.unauthorized += 1;
    console.warn(`[bridge] 401 unauthorized POST from ${req.socket.remoteAddress}`);
    return send(res, 401, { ok: false });
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (error) {
    const statusCode = error?.statusCode === 413 ? 413 : 400;
    if (statusCode === 413) {
      // Drop the rest of the oversized upload once the response is flushed.
      res.on('finish', () => req.destroy());
    }
    return send(res, statusCode, { ok: false });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    stats.rejected += 1;
    return send(res, 400, { ok: false, error: 'invalid JSON' });
  }

  const result = validateEvent(parsed);
  if (!result.ok) {
    stats.rejected += 1;
    // Log the reasons, never the payload contents.
    console.warn(`[bridge] 422 rejected event: ${result.errors.join('; ')}`);
    return send(res, 422, { ok: false, errors: result.errors });
  }

  if (seenIds.has(result.event.eventId)) {
    stats.duplicates += 1;
    return send(res, 200, { ok: true, duplicate: true });
  }

  const seq = enqueue(result.event);
  stats.accepted += 1;
  // Log only routing metadata — never title or message, which are user content.
  console.log(`[bridge] 202 accepted seq=${seq} type=${result.event.type} id=${result.event.eventId}`);
  return send(res, 202, { ok: true });
}

function handleGetEvents(req, res, url) {
  const sinceRaw = url.searchParams.get('since');
  const since = Number.parseInt(sinceRaw ?? '0', 10);
  const from = Number.isFinite(since) && since >= 0 ? since : 0;

  const pending = queue.filter((entry) => entry.seq > from);
  send(
    res,
    200,
    {
      ok: true,
      instanceId: INSTANCE_ID,
      cursor: sequence,
      events: pending.map((entry) => entry.event),
    },
    corsHeadersFor(req),
  );
}

function handleHealth(req, res) {
  send(
    res,
    200,
    {
      ok: true,
      instanceId: INSTANCE_ID,
      uptimeSeconds: Math.round((Date.now() - stats.startedAt) / 1000),
      queued: queue.length,
      cursor: sequence,
      accepted: stats.accepted,
      rejected: stats.rejected,
      unauthorized: stats.unauthorized,
      duplicates: stats.duplicates,
    },
    corsHeadersFor(req),
  );
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'OPTIONS') {
    return send(res, 204, {}, {
      ...corsHeadersFor(req),
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
  }

  // Windows-facing ingest. Always requires the bearer token.
  if (url.pathname === '/events' && req.method === 'POST') {
    return void handlePost(req, res);
  }

  // Read paths are for the app on this Mac only. Restricting to loopback keeps
  // the queue off the LAN even though the ingest port must be LAN-reachable.
  if (url.pathname === '/events' && req.method === 'GET') {
    if (!isLoopback(req)) return send(res, 403, { ok: false });
    return handleGetEvents(req, res, url);
  }

  if (url.pathname === '/health' && req.method === 'GET') {
    if (!isLoopback(req)) return send(res, 403, { ok: false });
    return handleHealth(req, res);
  }

  if (url.pathname === '/events' || url.pathname === '/health') {
    return send(res, 405, { ok: false });
  }

  return send(res, 404, { ok: false });
});

server.listen(PORT, HOST, () => {
  console.log(`[bridge] listening on http://${HOST}:${PORT}`);
  console.log(`[bridge] app reads  : http://127.0.0.1:${PORT}/events   (loopback only, no token)`);
  console.log(`[bridge] windows posts to: http://<this-mac-lan-ip>:${PORT}/events  (bearer token required)`);
  console.log(`[bridge] token loaded from AGENTHUB_BRIDGE_TOKEN (${TOKEN.length} chars, never logged)`);
  console.log('[bridge] local development only — do not port-forward or expose publicly.');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\n[bridge] shutting down; in-memory queue discarded.');
    server.close(() => process.exit(0));
  });
}
