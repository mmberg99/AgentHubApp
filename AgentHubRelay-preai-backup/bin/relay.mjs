#!/usr/bin/env node
/**
 * Relay entry point.
 *
 * Refuses to start without an ingestion token: a relay listening on loopback
 * with no authentication would let any local process push notifications to the
 * phone, which is exactly the thing the token exists to prevent.
 *
 * Starts without VAPID keys, deliberately — that way the ingestion path and
 * history can be exercised before any key material exists. Pushes are skipped
 * and the condition is printed at startup.
 */

import { API_PORT, BIND_HOST, INGEST_PORT, INGEST_TOKEN, MIN_TOKEN_LENGTH, STATE_DIR } from '../src/config.mjs';
import { configureVapid } from '../src/push.mjs';
import { ensureStateDir, loadSubscriptions, loadVapid } from '../src/storage.mjs';
import { start } from '../src/server.mjs';

if (INGEST_TOKEN.length < MIN_TOKEN_LENGTH) {
  console.error(
    `[relay] refusing to start: AGENTHUB_BRIDGE_TOKEN must be set to at least ` +
      `${MIN_TOKEN_LENGTH} characters. The ingestion endpoint is unauthenticated without it.`,
  );
  process.exit(1);
}

ensureStateDir();

const vapid = loadVapid();
if (vapid) {
  configureVapid(vapid);
} else {
  console.warn('[relay] no VAPID keys found; pushes are DISABLED.');
  console.warn('[relay] generate them with:  npm run generate-vapid');
}

const { ingest, api } = await start();

console.log(`[relay] ingestion  http://${BIND_HOST}:${INGEST_PORT}/events   (loopback only, token required)`);
console.log(`[relay] pwa api    http://${BIND_HOST}:${API_PORT}/            (/push/register, /history, /health)`);
console.log(`[relay] state      ${STATE_DIR}`);
console.log(`[relay] push       ${vapid ? 'enabled' : 'DISABLED (no VAPID keys)'}`);
console.log(`[relay] subscriptions registered: ${loadSubscriptions().length}`);

function shutdown(signal) {
  console.log(`[relay] ${signal} received, shutting down.`);
  ingest.close();
  api.close();
  // Give in-flight requests a moment, then exit regardless.
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
