/**
 * Summarisation through the Anthropic Messages API.
 *
 * NOT IN USE. AgentHub currently summarises through the local Claude CLI on
 * the machine's existing subscription; this provider is kept whole, tested and
 * one setting away, so switching is a configuration change rather than a
 * rewrite. It does nothing at all unless a credential file exists, and no
 * credential is configured.
 *
 * WHAT WOULD LEAVE THIS MACHINE. Exactly one thing per request: the text of
 * the single captured message being summarised, wrapped in a delimiter, plus
 * the shared instructions. No identifier travels with it.
 *
 * THE MESSAGE IS DATA. Containment is structural: the request carries NO
 * `tools` key, so there is nothing to call — no shell, no filesystem, no MCP,
 * no browsing. The reply is schema-constrained and re-validated here.
 */

import { randomBytes } from 'node:crypto';

import {
  SUMMARIZER_FILE,
  SUMMARY_API_URL,
  SUMMARY_API_VERSION,
  SUMMARY_MAX_TOKENS,
  SUMMARY_MODEL,
  SUMMARY_TIMEOUT_MS,
} from '../config.mjs';
import { readJson } from '../storage.mjs';
import { SummaryError, validateCard } from './summaryCard.mjs';
import { SUMMARY_SCHEMA, SYSTEM_PROMPT, wrapMessage } from './summaryPrompt.mjs';

/** Recorded on every card this provider produces. */
export const PROVIDER_NAME = 'anthropic';

/**
 * The provider key, read fresh from its own owner-only file. Returns null when
 * absent or malformed, which simply means this provider is unavailable.
 */
export function loadCredential() {
  const raw = readJson(SUMMARIZER_FILE, null);
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.apiKey !== 'string' || raw.apiKey.trim().length === 0) return null;
  return {
    provider: typeof raw.provider === 'string' ? raw.provider : PROVIDER_NAME,
    model: typeof raw.model === 'string' ? raw.model : SUMMARY_MODEL,
    apiKey: raw.apiKey.trim(),
  };
}

export function hasCredential() {
  return loadCredential() !== null;
}

export function isConfigured() {
  return hasCredential();
}

/** Last line of defence: a key must never reach a log, an error or a response. */
export function redact(text, apiKey) {
  if (typeof text !== 'string') return text;
  if (typeof apiKey !== 'string' || apiKey.length < 8) return text;
  return text.split(apiKey).join('[redacted]');
}

/** The exact request body. The absence of a `tools` key is deliberate. */
export function buildRequestBody(text, nonce, model = SUMMARY_MODEL) {
  return {
    model,
    max_tokens: SUMMARY_MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: wrapMessage(text, nonce) }],
    output_config: { format: { type: 'json_schema', schema: SUMMARY_SCHEMA } },
  };
}

/** Pulls the structured card out of a Messages API response. */
export function parseSummaryResponse(body) {
  if (typeof body !== 'object' || body === null) throw new SummaryError('malformed response', false);
  if (body.stop_reason === 'refusal') throw new SummaryError('provider refused', false);
  if (body.stop_reason === 'max_tokens') throw new SummaryError('response truncated', false);
  if (!Array.isArray(body.content)) throw new SummaryError('malformed response', false);

  const block = body.content.find((b) => b && b.type === 'text' && typeof b.text === 'string');
  if (!block) throw new SummaryError('no text block', false);

  let parsed;
  try {
    parsed = JSON.parse(block.text);
  } catch {
    throw new SummaryError('invalid json', false);
  }
  return validateCard(parsed);
}

/**
 * One provider call. Returns the parsed card, or throws a SummaryError whose
 * `retryable` flag says whether waiting could help. The key is never part of
 * a thrown message.
 */
export async function requestSummary(text, options = {}) {
  const credential = options.credential ?? loadCredential();
  if (!credential) throw new SummaryError('no credential configured', false);
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const model = options.model ?? credential.model ?? SUMMARY_MODEL;
  const nonce = randomBytes(8).toString('hex');

  let response;
  try {
    response = await doFetch(SUMMARY_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': credential.apiKey,
        'anthropic-version': SUMMARY_API_VERSION,
      },
      body: JSON.stringify(buildRequestBody(text, nonce, model)),
      signal: AbortSignal.timeout(options.timeoutMs ?? SUMMARY_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error?.name === 'TimeoutError' ? 'timeout' : 'network error';
    throw new SummaryError(name, true);
  }

  if (!response.ok) {
    const status = response.status;
    // 429 and 5xx are worth another try; a 400 or 401 will fail identically.
    throw new SummaryError(`provider returned ${status}`, status === 429 || status >= 500);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new SummaryError('unreadable response', false);
  }
  const card = parseSummaryResponse(body);
  return { ...card, model, provider: credential.provider };
}
