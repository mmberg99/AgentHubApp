/**
 * Durable relay state: the VAPID keypair and the push subscriptions.
 *
 * Plain JSON files, no database. Two properties matter:
 *
 * ATOMICITY
 *   Every write goes to a temporary file in the SAME directory and is then
 *   renamed over the target. rename(2) within one filesystem is atomic, so a
 *   crash mid-write leaves either the old file or the new one, never a
 *   truncated one. Writes are also serialised through a promise chain, so two
 *   concurrent requests cannot interleave and lose an update.
 *
 * SECRECY
 *   vapid.json holds the private key. It is created with owner-only
 *   permissions and is never returned by an API, never logged, and never
 *   included in an error message.
 */

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

import { STATE_DIR, SUBSCRIPTIONS_FILE, VAPID_FILE } from './config.mjs';

/* ------------------------------------------------------------------ files */

export function ensureStateDir() {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

/**
 * Restrict a file to the current user only.
 *
 * chmod is close to meaningless on Windows, so the real work is done by icacls:
 * inheritance is removed and a single grant for the current user is written.
 * Best effort by design — a relay that cannot tighten an ACL should still run,
 * so failure is reported by the caller rather than thrown here.
 */
export function restrictToOwner(path) {
  try {
    if (process.platform !== 'win32') return true;
    const user = process.env.USERNAME;
    if (!user) return false;
    execFileSync('icacls', [path, '/inheritance:r', '/grant:r', `${user}:(R,W)`], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/** Atomic JSON write: temp file in the same directory, then rename over. */
export function writeJsonAtomic(path, value, { secret = false } = {}) {
  ensureStateDir();
  const tmp = join(dirname(path), `.${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  if (secret) restrictToOwner(path);
}

export function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // A corrupt state file must not stop the relay from starting. The
    // subscription can be recreated from the phone in a few taps.
    return fallback;
  }
}

/* ------------------------------------------------------------------ vapid */

export function loadVapid() {
  const data = readJson(VAPID_FILE, null);
  if (!data || typeof data.publicKey !== 'string' || typeof data.privateKey !== 'string') {
    return null;
  }
  return data;
}

export function saveVapid(keys) {
  writeJsonAtomic(VAPID_FILE, keys, { secret: true });
}

/* ---------------------------------------------------------- subscriptions */

/**
 * Serialises writes. Every mutation appends to this chain, so a burst of
 * registrations cannot produce a lost update through read-modify-write racing.
 */
let writeChain = Promise.resolve();

function enqueueWrite(fn) {
  writeChain = writeChain.then(fn, fn);
  return writeChain;
}

/**
 * The history capability token is stored as a SHA-256 hash, never in plaintext.
 * The relay only ever needs to answer "does this presented token match?", which
 * a hash answers. If the state file leaks, the tokens in it are not usable.
 */
export function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 256 bits from the CSPRNG, urlsafe-base64. */
export function generateCapabilityToken() {
  return randomBytes(32).toString('base64url');
}

/** Constant-time compare so a wrong token cannot be found byte by byte. */
export function tokenMatchesHash(token, expectedHash) {
  if (typeof token !== 'string' || typeof expectedHash !== 'string') return false;
  const actual = Buffer.from(hashToken(token), 'utf8');
  const expected = Buffer.from(expectedHash, 'utf8');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * Per-device notification preferences.
 *
 * Chosen on the phone, stored beside that device's subscription because the
 * push decision is made here, on Windows: the phone cannot suppress a push
 * after the fact without breaking the service worker's userVisibleOnly
 * contract. Defaults are ON, so a device that never expressed a preference,
 * or whose record predates this field, keeps the previous behaviour.
 *
 * These are display preferences only. They never widen what is delivered,
 * only narrow it, and they carry no identity of any kind.
 */
export const DEFAULT_PREFERENCES = Object.freeze({ subtaskCompletionPush: true });

/** Rebuilds preferences from known keys only; anything else is discarded. */
export function sanitizePreferences(value) {
  const out = { ...DEFAULT_PREFERENCES };
  if (typeof value !== 'object' || value === null) return out;
  if (typeof value.subtaskCompletionPush === 'boolean') {
    out.subtaskCompletionPush = value.subtaskCompletionPush;
  }
  return out;
}

export function loadSubscriptions() {
  const data = readJson(SUBSCRIPTIONS_FILE, []);
  if (!Array.isArray(data)) return [];
  return data
    .filter(isStoredSubscription)
    .map((s) => ({ ...s, preferences: sanitizePreferences(s.preferences) }));
}

function isStoredSubscription(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.endpoint === 'string' &&
    typeof value.p256dh === 'string' &&
    typeof value.auth === 'string'
  );
}

/**
 * Insert or update one subscription and return its fresh capability token.
 *
 * Identity is the endpoint: re-registering the same browser replaces the row
 * rather than accumulating duplicates. A new token is minted on every
 * registration, which also makes re-registering the documented way to rotate a
 * token that might have been exposed.
 */
export async function upsertSubscription({ endpoint, p256dh, auth }) {
  const token = generateCapabilityToken();
  const now = new Date().toISOString();

  await enqueueWrite(() => {
    const all = loadSubscriptions();
    const existing = all.find((s) => s.endpoint === endpoint);
    const record = {
      endpoint,
      p256dh,
      auth,
      tokenHash: hashToken(token),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      // Re-registering the same device keeps its notification preferences.
      preferences: sanitizePreferences(existing?.preferences),
    };
    const next = all.filter((s) => s.endpoint !== endpoint);
    next.push(record);
    writeJsonAtomic(SUBSCRIPTIONS_FILE, next);
  });

  // Returned exactly once, to the device that just registered. The relay keeps
  // only the hash and can never show this value again.
  return token;
}

/** Drop a subscription. Used when the push service reports 404/410. */
export async function removeSubscription(endpoint) {
  await enqueueWrite(() => {
    const next = loadSubscriptions().filter((s) => s.endpoint !== endpoint);
    writeJsonAtomic(SUBSCRIPTIONS_FILE, next);
  });
}

/**
 * Update the notification preferences of the device that presents `token`.
 *
 * Authenticated by the same per-device capability token that guards /history
 * and the conversation reads: a caller without it changes nothing. Returns the
 * stored preferences, or null when no subscription matches.
 */
export async function setPreferencesForToken(token, preferences) {
  const clean = sanitizePreferences(preferences);
  let matched = false;

  await enqueueWrite(() => {
    const all = loadSubscriptions();
    const next = all.map((record) => {
      if (!tokenMatchesHash(token, record.tokenHash ?? '')) return record;
      matched = true;
      return { ...record, preferences: clean, updatedAt: new Date().toISOString() };
    });
    if (matched) writeJsonAtomic(SUBSCRIPTIONS_FILE, next);
  });

  return matched ? clean : null;
}

/**
 * Find the subscription a presented capability token belongs to.
 *
 * Revocation is implicit and total: the token lives only on its subscription
 * record, so removing the subscription removes the only thing that could match.
 */
export function findByCapabilityToken(token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  for (const record of loadSubscriptions()) {
    if (tokenMatchesHash(token, record.tokenHash ?? '')) return record;
  }
  return null;
}
