/**
 * Relay configuration.
 *
 * Two listeners, deliberately on two ports with two separate route tables:
 *
 *   127.0.0.1:8781   ingestion   AgentHubNotifier -> relay.  Bearer token.
 *                                NEVER mounted in Tailscale Serve.
 *   127.0.0.1:8782   pwa api     AgentHub PWA -> relay.  Capability token.
 *                                Mounted at https://<host>.ts.net/api
 *
 * Splitting the ports is what makes "the notifier endpoint is unreachable from
 * the tailnet" a property of the network configuration rather than a property
 * of a routing function that somebody could later get wrong.
 *
 * Both listeners bind 127.0.0.1 explicitly. Neither is ever bound to 0.0.0.0:
 * Tailscale reaches them by proxying from the tailnet to loopback, so there is
 * no reason for either socket to accept a packet from the network directly.
 */

import { join } from 'node:path';

/** Ingestion listener. Loopback only, never exposed through Tailscale. */
export const INGEST_PORT = Number(process.env.AGENTHUB_RELAY_INGEST_PORT ?? 8781);

/** PWA-facing listener. Loopback bind; reachable via the Tailscale /api mount. */
export const API_PORT = Number(process.env.AGENTHUB_RELAY_API_PORT ?? 8782);

/** Never 0.0.0.0. See the module comment. */
export const BIND_HOST = '127.0.0.1';

/**
 * Shared secret for the ingestion endpoint, identical to the one the notifier
 * already sends. Loopback is not a trust boundary on Windows: any local process
 * can POST to 127.0.0.1, so the token is what stops arbitrary local software
 * from putting fabricated agent events on a lock screen.
 */
export const INGEST_TOKEN = process.env.AGENTHUB_BRIDGE_TOKEN ?? '';
export const MIN_TOKEN_LENGTH = 16;

/** State directory: outside the repo, outside the PWA, outside the web root. */
export const STATE_DIR =
  process.env.AGENTHUB_RELAY_STATE_DIR ??
  join(process.env.LOCALAPPDATA ?? process.env.HOME ?? '.', 'AgentHub', 'relay');

export const VAPID_FILE = join(STATE_DIR, 'vapid.json');
export const SUBSCRIPTIONS_FILE = join(STATE_DIR, 'subscriptions.json');

/* ------------------------------------------------------------ conversations */

/**
 * Durable, user-visible conversation text (prompts + assistant responses),
 * one JSON file per task. Explicitly approved scope; see conversations.mjs.
 */
export const CONVERSATIONS_DIR = join(STATE_DIR, 'conversations');
/** Longest single message text accepted. The notifier cuts at 20,000 and flags it. */
export const MAX_MESSAGE_TEXT_CHARS = 24_000;
/** Body ceiling for POST /messages: text cap plus JSON/UTF-8 headroom. */
export const MAX_MESSAGE_BODY_BYTES = 128 * 1024;
/* No per-thread message-count limit: every captured turn is kept. Retention is a separate decision. */
/** Newest conversations listed by GET /conversations. */
export const MAX_CONVERSATION_SUMMARIES = 300;
/** Title cap, matches the notifier's derivation cap with headroom. */
export const MAX_CONVERSATION_TITLE_CHARS = 80;

/** A valid event is a few hundred bytes; this is a generous ceiling. */
export const MAX_BODY_BYTES = 8 * 1024;

/** Newest N events kept in memory for history replay. Never written to disk. */
export const MAX_HISTORY = 200;

/** Remembered event ids for duplicate suppression at the relay boundary. */
export const MAX_SEEN_IDS = 1000;

/** Apple's Web Push service rejects payloads above 4 KB. */
export const MAX_PUSH_PAYLOAD_BYTES = 4096;
