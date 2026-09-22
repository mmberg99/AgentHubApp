/**
 * Durable cache for message summaries.
 *
 * SEPARATE FROM CONVERSATIONS. Summaries live in their own directory, one
 * file per task, keyed by messageId. The conversation files this feature
 * previews are never opened for writing and never change shape: a summary is
 * derived presentation data, and deleting this whole directory only means the
 * cards fall back to the local generator until they are made again.
 *
 * VALIDITY. A cached entry is reused only when the messageId, the hash of the
 * message text, and the summary version all still match. Any mismatch means
 * the entry is stale and the card is regenerated; nothing is silently served
 * from a summary of different text.
 *
 * NO CREDENTIAL EVER TOUCHES THIS FILE. The provider key lives in its own
 * file outside this directory and is never part of a record.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  SUMMARIES_DIR,
  SUMMARY_MAX_BULLET_CHARS,
  SUMMARY_MAX_PARAGRAPH_CHARS,
  SUMMARY_MAX_TITLE_CHARS,
  SUMMARY_MAX_TOTAL_CHARS,
  SUMMARY_VERSION,
} from './config.mjs';
import { readJson, writeJsonAtomic } from './storage.mjs';

const ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const clean = (value, max) => String(value).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** Identity of the exact text a summary was made from. */
export function hashSource(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 32);
}

/**
 * Rebuilds a record from known fields only. Returns null when anything is
 * missing or malformed, so a corrupt file degrades to "no summary" rather
 * than showing something wrong.
 */
export function sanitizeSummary(raw) {
  if (typeof raw !== 'object' || raw === null) return null;
  const {
    messageId, sourceTextHash, summaryVersion, provider, model, generatedAt, title, style,
  } = raw;

  if (!ID_PATTERN.test(String(messageId ?? ''))) return null;
  if (typeof sourceTextHash !== 'string' || !/^[a-f0-9]{8,64}$/.test(sourceTextHash)) return null;
  if (!Number.isInteger(summaryVersion) || summaryVersion < 1) return null;
  if (typeof provider !== 'string' || provider.length === 0 || provider.length > 40) return null;
  if (typeof model !== 'string' || model.length === 0 || model.length > 80) return null;
  if (typeof generatedAt !== 'string' || Number.isNaN(Date.parse(generatedAt))) return null;
  if (style !== 'bullets' && style !== 'paragraph') return null;

  const cleanTitle = clean(typeof title === 'string' ? title : '', SUMMARY_MAX_TITLE_CHARS);
  if (cleanTitle.length === 0) return null;

  const bullets = Array.isArray(raw.bullets)
    ? raw.bullets
        .filter((b) => typeof b === 'string')
        .map((b) => clean(b, SUMMARY_MAX_BULLET_CHARS))
        .filter((b) => b.length > 0)
    : [];
  const paragraph = clean(typeof raw.paragraph === 'string' ? raw.paragraph : '', SUMMARY_MAX_PARAGRAPH_CHARS);

  // A card must actually say something in the style it claims.
  if (style === 'bullets' && bullets.length === 0) return null;
  if (style === 'paragraph' && paragraph.length === 0) return null;

  // Size bound only. The COUNT of bullets is the model's choice; this trims a
  // runaway response rather than capping how many points a summary may make.
  const kept = [];
  let used = cleanTitle.length + paragraph.length;
  for (const bullet of bullets) {
    if (used + bullet.length > SUMMARY_MAX_TOTAL_CHARS && kept.length > 0) break;
    kept.push(bullet);
    used += bullet.length;
  }

  return {
    messageId: String(messageId),
    sourceTextHash,
    summaryVersion,
    provider,
    model,
    generatedAt: new Date(generatedAt).toISOString(),
    title: cleanTitle,
    style,
    paragraph: style === 'paragraph' ? paragraph : '',
    bullets: style === 'bullets' ? kept : [],
  };
}

function pathFor(taskId) {
  if (!ID_PATTERN.test(taskId)) throw new Error('bad task id');
  return join(SUMMARIES_DIR, `${taskId}.json`);
}

/** Every summary held for a task, as `{ [messageId]: record }`. */
export function loadMessageSummaries(taskId) {
  if (!ID_PATTERN.test(taskId ?? '')) return {};
  const raw = readJson(pathFor(taskId), null);
  if (typeof raw !== 'object' || raw === null || raw.version !== 1) return {};
  const out = {};
  for (const [messageId, entry] of Object.entries(raw.summaries ?? {})) {
    const record = sanitizeSummary(entry);
    if (record && record.messageId === messageId) out[messageId] = record;
  }
  return out;
}

/** True when this cached record may be served for this exact text. */
export function isFresh(record, sourceTextHash) {
  return Boolean(
    record &&
      record.sourceTextHash === sourceTextHash &&
      record.summaryVersion === SUMMARY_VERSION,
  );
}

export function getFreshSummary(taskId, messageId, sourceTextHash) {
  const record = loadMessageSummaries(taskId)[messageId];
  return isFresh(record, sourceTextHash) ? record : null;
}

let writeChain = Promise.resolve();

/** Adds or replaces one record. Serialised so concurrent writes cannot race. */
export function saveMessageSummary(taskId, record) {
  const clean = sanitizeSummary(record);
  if (!clean) return Promise.resolve(false);
  const run = () => {
    if (!existsSync(SUMMARIES_DIR)) mkdirSync(SUMMARIES_DIR, { recursive: true, mode: 0o700 });
    const current = loadMessageSummaries(taskId);
    current[clean.messageId] = clean;
    writeJsonAtomic(pathFor(taskId), { version: 1, taskId, summaries: current });
    return true;
  };
  const next = writeChain.then(run, run);
  writeChain = next.catch(() => {});
  return next;
}
