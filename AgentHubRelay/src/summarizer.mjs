/**
 * Message summarisation: deciding what is worth summarising, getting it done
 * exactly once, and making sure a failure never matters.
 *
 * WHICH BACKEND. Selected by `SUMMARY_BACKEND`. Today it is the local Claude
 * CLI, running on this machine's existing Claude subscription, so no API key
 * exists anywhere in AgentHub. The Anthropic API provider is kept whole and
 * tested beside it and is one setting away. Everything below is the same
 * either way: the same instructions, the same schema, the same validation, the
 * same cache, the same fallback.
 *
 * WHAT LEAVES THIS MACHINE. Exactly one thing per request: the text of the
 * single captured message being summarised, plus the fixed instructions. No
 * identifier travels with it — not the messageId, taskId, subtaskId, project
 * name or timestamp — so a backend cannot tell which task a message belongs to
 * or that two messages are related. Nothing else in AgentHub is read here: no
 * cwd, no session or agent ids, no transcripts, no tool input or output, no
 * environment, no relay token, no VAPID material, no Tailscale detail.
 *
 * THE MESSAGE IS DATA. A captured message can contain anything, including text
 * addressed to a model ("ignore previous instructions", "fetch this URL",
 * "reveal your key"). Containment is structural, not a matter of wording: the
 * backend is given no usable tool, the reply is constrained by a JSON schema
 * and re-validated here, and the result is stored as display strings and
 * nothing more. This relay never executes, fetches or forwards anything
 * derived from a summary.
 *
 * FAILURE IS NEVER FATAL. No login, a usage limit, a timeout, a malformed
 * reply, a containment check that fails: every one of them ends with no
 * summary stored and the conversation served exactly as it would have been,
 * with the app falling back to its own local preview. Summarisation is never
 * on the path of capture, retrieval, notification or push.
 *
 * NOTHING IS EVER REWRITTEN. A summary is presentation metadata kept in its
 * own file. No message, id, timestamp, ordering or parent/child relationship
 * is touched by anything here.
 */

import {
  SUMMARY_BACKEND,
  SUMMARY_CODE_LINES,
  SUMMARY_CONCURRENCY,
  SUMMARY_MAX_ATTEMPTS,
  SUMMARY_MIN_CHARS,
  SUMMARY_MIN_LINES,
  SUMMARY_RETRY_AFTER_MS,
  SUMMARY_VERSION,
} from './config.mjs';
import { getFreshSummary, hashSource, saveMessageSummary } from './messageSummaries.mjs';
import * as anthropicApi from './providers/anthropicApi.mjs';
import * as claudeCli from './providers/claudeCli.mjs';
import { SummaryError } from './providers/summaryCard.mjs';

export { SUMMARY_SCHEMA, SYSTEM_PROMPT } from './providers/summaryPrompt.mjs';
export { SummaryError, validateCard } from './providers/summaryCard.mjs';

/* -------------------------------------------------------------- providers */

const PROVIDERS = {
  'claude-cli': claudeCli,
  'anthropic-api': anthropicApi,
};

/** The selected backend module. An unknown name is a configuration error. */
export function activeProvider(name = SUMMARY_BACKEND) {
  const provider = PROVIDERS[name];
  if (!provider) throw new SummaryError(`unknown summary backend "${name}"`, false);
  return provider;
}

/** True when the selected backend could produce a summary right now. */
export function isSummarizationAvailable(name = SUMMARY_BACKEND) {
  try {
    return activeProvider(name).isConfigured();
  } catch {
    return false;
  }
}

/*
 * Kept exported at their original names so the Anthropic path stays usable and
 * directly testable while the CLI backend is the one in service.
 */
export const SUMMARY_PROVIDER = anthropicApi.PROVIDER_NAME;
export const {
  loadCredential,
  hasCredential,
  redact,
  buildRequestBody,
  parseSummaryResponse,
} = anthropicApi;

/** One call to whichever backend is selected. */
export async function requestSummary(text, options = {}) {
  return activeProvider(options.backend).requestSummary(text, options);
}

/* ------------------------------------------------------------- worth it? */

/** True when a message is long enough that a card is worth a request. */
export function shouldSummarize(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length >= SUMMARY_MIN_CHARS) return true;

  const lines = trimmed.split('\n');
  if (lines.length >= SUMMARY_MIN_LINES) return true;

  // A short message that is mostly a code block is still worth collapsing.
  let inFence = false;
  let fenced = 0;
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) fenced += 1;
  }
  return fenced > SUMMARY_CODE_LINES;
}

/* ----------------------------------------------------------------- queue */

/** One generation per messageId, however many callers ask at once. */
const inFlight = new Map();
/** messageId -> epoch ms before which we do not try again after a failure. */
const cooldown = new Map();
let running = 0;
const waiting = [];

function acquire() {
  if (running < SUMMARY_CONCURRENCY) {
    running += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else running -= 1;
}

/** Test seam: forget in-flight work and failure cooldowns. */
export function resetSummarizerState() {
  inFlight.clear();
  cooldown.clear();
  running = 0;
  waiting.length = 0;
}

async function generate(taskId, message, options) {
  const sourceTextHash = hashSource(message.text);
  const cached = getFreshSummary(taskId, message.messageId, sourceTextHash);
  if (cached) return cached;

  await acquire();
  try {
    // Another caller may have finished while this one queued.
    const again = getFreshSummary(taskId, message.messageId, sourceTextHash);
    if (again) return again;

    const card = await requestSummary(message.text, options);
    const record = {
      messageId: message.messageId,
      sourceTextHash,
      summaryVersion: SUMMARY_VERSION,
      provider: card.provider,
      model: card.model,
      generatedAt: new Date().toISOString(),
      title: card.title,
      style: card.style,
      paragraph: card.paragraph,
      bullets: card.bullets,
    };
    await saveMessageSummary(taskId, record);
    cooldown.delete(message.messageId);
    return record;
  } finally {
    release();
  }
}

/**
 * Ensure a summary exists for one message. Safe to call from anywhere and as
 * often as you like: a cached card costs nothing, concurrent callers share one
 * generation, and every failure resolves to null instead of throwing.
 */
export async function ensureSummary(taskId, message, options = {}) {
  if (!message || typeof message.text !== 'string') return null;
  if (!shouldSummarize(message.text)) return null;

  const sourceTextHash = hashSource(message.text);
  const cached = getFreshSummary(taskId, message.messageId, sourceTextHash);
  if (cached) return cached;

  const until = cooldown.get(message.messageId);
  if (until && Date.now() < until) return null;

  const key = `${taskId}\u0000${message.messageId}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const attempt = (async () => {
    const maxAttempts = options.maxAttempts ?? SUMMARY_MAX_ATTEMPTS;
    for (let i = 1; i <= maxAttempts; i += 1) {
      try {
        return await generate(taskId, message, options);
      } catch (error) {
        // The CLI backend reports every failure as final on purpose: a usage
        // limit or a login problem costs allowance to rediscover and a retry
        // cannot fix either.
        const retryable = error?.retryable === true;
        if (!retryable || i === maxAttempts) {
          // Remembered so a broken message is not retried on every open.
          cooldown.set(message.messageId, Date.now() + (options.retryAfterMs ?? SUMMARY_RETRY_AFTER_MS));
          return null;
        }
        await new Promise((r) => setTimeout(r, (options.backoffMs ?? 500) * i));
      }
    }
    return null;
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, attempt);
  return attempt;
}

/** Fire and forget: used where a response must never wait on the provider. */
export function ensureSummaryInBackground(taskId, message, options = {}) {
  void ensureSummary(taskId, message, options).catch(() => null);
}
