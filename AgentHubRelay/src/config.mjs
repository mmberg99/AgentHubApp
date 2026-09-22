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

/* ------------------------------------------------------------ summaries */

/**
 * Message summaries: the collapsed card shown for a long conversation turn.
 *
 * Kept in their own directory so the conversation files stay byte-for-byte
 * what the capture pipeline wrote. A summary is derived presentation data and
 * can be deleted or regenerated at any time without touching a message.
 */
export const SUMMARIES_DIR = join(STATE_DIR, 'summaries');

/**
 * Which backend writes the cards.
 *
 * 'claude-cli' runs the Claude CLI already installed and logged in on this
 * machine, so summaries come out of the existing Claude subscription and
 * AgentHub holds no API credential of any kind. 'anthropic-api' is the same
 * feature over the Messages API with a key; it is kept working and tested, and
 * switching is this one value.
 */
export const SUMMARY_BACKEND = process.env.AGENTHUB_SUMMARY_BACKEND ?? 'claude-cli';

/* --- the Claude CLI backend ------------------------------------------- */

/** Resolved on PATH unless pointed somewhere explicitly. */
export const SUMMARY_CLI_PATH = process.env.AGENTHUB_SUMMARY_CLI_PATH ?? 'claude';
/** A model alias, resolved by the CLI against the account's own entitlements. */
export const SUMMARY_CLI_MODEL = process.env.AGENTHUB_SUMMARY_CLI_MODEL ?? 'haiku';
export const SUMMARY_CLI_EFFORT = process.env.AGENTHUB_SUMMARY_CLI_EFFORT ?? 'low';
/**
 * One turn writes the card; the allowance covers a retry the CLI makes itself
 * when its first structured output does not validate.
 */
export const SUMMARY_CLI_MAX_TURNS = 3;
/**
 * Generous: a process start plus a model call, measured at 4-14 seconds. The
 * caller never waits on this, so a slow run costs nothing but its own time.
 */
export const SUMMARY_CLI_TIMEOUT_MS = 90_000;

/* --- the Anthropic API backend (built, tested, not in use) ------------ */

/**
 * The provider credential. Owner-only ACL, same treatment as vapid.json, and
 * deliberately NOT in the conversations or summaries directories. Only the
 * 'anthropic-api' backend reads it, and no credential is configured.
 */
export const SUMMARIZER_FILE = join(STATE_DIR, 'summarizer.json');

/**
 * Bump when the prompt, schema or post-processing changes in a way that makes
 * existing cards wrong or stale. Cached summaries at an older version are
 * regenerated on next use; nothing is deleted.
 */
export const SUMMARY_VERSION = 1;

/**
 * Claude Haiku 4.5. Verified against the model overview on 2026-09-22: the
 * Claude API ID is the dated snapshot, `claude-haiku-4-5` is its alias, the
 * model is Active with no announced deprecation, and Anthropic commits to at
 * least 60 days' notice before any retirement. Overridable so a different
 * Anthropic model can be selected without touching code.
 */
export const SUMMARY_MODEL = process.env.AGENTHUB_SUMMARY_MODEL ?? 'claude-haiku-4-5-20251001';
export const SUMMARY_API_URL =
  process.env.AGENTHUB_SUMMARY_API_URL ?? 'https://api.anthropic.com/v1/messages';
export const SUMMARY_API_VERSION = '2023-06-01';

/** One request, one short answer. Generous enough for a long bullet list. */
export const SUMMARY_MAX_TOKENS = 700;
export const SUMMARY_TIMEOUT_MS = 20_000;
/** Network and 5xx/429 failures only; a rejected request is never retried. */
export const SUMMARY_MAX_ATTEMPTS = 3;
/** After a failure, wait this long before this message is tried again. */
export const SUMMARY_RETRY_AFTER_MS = 10 * 60 * 1000;
/** At most this many provider calls run at once. */
export const SUMMARY_CONCURRENCY = 2;

/**
 * When a message is worth a card. Mirrors the app's own collapse rule, so a
 * collapsed card always has a summary attempt behind it and a message short
 * enough to read whole never costs a request.
 */
export const SUMMARY_MIN_CHARS = 320;
export const SUMMARY_MIN_LINES = 6;
export const SUMMARY_CODE_LINES = 2;

/**
 * Size bounds on what is stored, not limits on how many points a summary may
 * make: the model chooses the number of bullets, and only runaway output is
 * trimmed.
 */
export const SUMMARY_MAX_TITLE_CHARS = 80;
export const SUMMARY_MAX_BULLET_CHARS = 200;
export const SUMMARY_MAX_PARAGRAPH_CHARS = 600;
export const SUMMARY_MAX_TOTAL_CHARS = 2400;
