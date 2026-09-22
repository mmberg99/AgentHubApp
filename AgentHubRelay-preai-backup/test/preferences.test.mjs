/**
 * Per-device notification preferences and the delivery filter they drive.
 *
 * Own scratch state dir and ports, no VAPID keys: nothing here can reach a
 * real device. What is proven is the DECISION — which subscriptions a given
 * event would be delivered to — which is exactly the expression the ingestion
 * route uses to pick its targets.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const SCRATCH = mkdtempSync(join(tmpdir(), 'agenthub-prefs-test-'));
process.env.AGENTHUB_RELAY_STATE_DIR = SCRATCH;
process.env.AGENTHUB_BRIDGE_TOKEN = 'test-token-that-is-long-enough';
process.env.AGENTHUB_RELAY_INGEST_PORT = '18801';
process.env.AGENTHUB_RELAY_API_PORT = '18802';

const { allowsPush, shouldPush } = await import('../src/notificationPolicy.mjs');
const { loadSubscriptions, sanitizePreferences, DEFAULT_PREFERENCES } = await import('../src/storage.mjs');
const { buildPushPayload } = await import('../src/push.mjs');
const { createServers } = await import('../src/server.mjs');

const INGEST = 'http://127.0.0.1:18801';
const API = 'http://127.0.0.1:18802';
const TOKEN = 'test-token-that-is-long-enough';

let servers;
before(async () => {
  servers = createServers();
  await new Promise((r) => servers.ingest.listen(18801, '127.0.0.1', r));
  await new Promise((r) => servers.api.listen(18802, '127.0.0.1', r));
});
after(() => {
  servers.ingest.close();
  servers.api.close();
  rmSync(SCRATCH, { recursive: true, force: true });
});

let n = 0;
function ev(type, extra = {}) {
  n += 1;
  return {
    version: 1,
    eventId: `evt-pref-${n}`,
    agentId: 'win_claude_code',
    agentName: 'Claude Code',
    provider: 'claude',
    type,
    title: 'Claude Code',
    message: `Claude Code ${type}.`,
    timestamp: new Date().toISOString(),
    taskId: 's-parent000000001',
    projectId: 'p-main000000',
    projectName: 'AgentHub',
    ...extra,
  };
}
const child = (type) => ev(type, { subtaskId: 't-child000000001', agentType: 'Explore' });

async function registerDevice(suffix) {
  const res = await fetch(`${API}/push/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      endpoint: `https://web.push.apple.com/prefs-${suffix}`,
      keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) },
    }),
  });
  const body = await res.json();
  assert.equal(body.ok, true);
  return body.historyToken;
}
const setPrefs = (token, value, extra = {}) =>
  fetch(`${API}/push/preferences`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ version: 1, subtaskCompletionPush: value, ...extra }),
  });
const recordFor = (suffix) =>
  loadSubscriptions().find((s) => s.endpoint === `https://web.push.apple.com/prefs-${suffix}`);
/** Exactly what handleIngest computes when choosing who to deliver to. */
const targets = (event) => loadSubscriptions().filter((r) => allowsPush(r, event));

describe('defaults', () => {
  it('a newly registered device has subtask completion notifications ON', async () => {
    await registerDevice('a');
    assert.deepEqual(DEFAULT_PREFERENCES, { subtaskCompletionPush: true });
    assert.deepEqual(recordFor('a').preferences, { subtaskCompletionPush: true });
    assert.equal(allowsPush(recordFor('a'), child('completed')), true);
  });

  it('a record written before preferences existed reads as ON', () => {
    assert.deepEqual(sanitizePreferences(undefined), { subtaskCompletionPush: true });
    assert.deepEqual(sanitizePreferences({}), { subtaskCompletionPush: true });
    assert.deepEqual(sanitizePreferences({ subtaskCompletionPush: 'no' }), { subtaskCompletionPush: true });
    assert.equal(allowsPush({}, child('completed')), true);
    assert.equal(allowsPush(undefined, child('completed')), true);
  });
});

describe('the toggle', () => {
  it('requires the device capability token; the ingestion token does not work', async () => {
    const token = await registerDevice('b');
    assert.equal((await setPrefs(null, false)).status, 401);
    assert.equal((await setPrefs(TOKEN, false)).status, 401);
    assert.equal((await setPrefs('wrong-token-wrong-token', false)).status, 401);
    // Nothing changed while those were rejected.
    assert.equal(recordFor('b').preferences.subtaskCompletionPush, true);
    assert.equal((await setPrefs(token, false)).status, 200);
    assert.equal(recordFor('b').preferences.subtaskCompletionPush, false);
  });

  it('validates the body and ignores unknown fields', async () => {
    const token = await registerDevice('c');
    assert.equal((await setPrefs(token, 'false')).status, 422);
    const wrongVersion = await fetch(`${API}/push/preferences`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ version: 2, subtaskCompletionPush: false }),
    });
    assert.equal(wrongVersion.status, 422);
    // An extra field is discarded, not stored.
    assert.equal((await setPrefs(token, false, { pushEverything: true, token: 'secret' })).status, 200);
    assert.deepEqual(recordFor('c').preferences, { subtaskCompletionPush: false });
    assert.equal(readFileSync(join(SCRATCH, 'subscriptions.json'), 'utf8').includes('secret'), false);
  });

  it('persists on disk and survives a re-read, and re-registering keeps it', async () => {
    const token = await registerDevice('d');
    await setPrefs(token, false);
    // loadSubscriptions reads the file each time: this is the reload path.
    assert.equal(recordFor('d').preferences.subtaskCompletionPush, false);
    assert.equal(
      JSON.parse(readFileSync(join(SCRATCH, 'subscriptions.json'), 'utf8')).find((s) =>
        s.endpoint.endsWith('prefs-d'),
      ).preferences.subtaskCompletionPush,
      false,
    );
    await registerDevice('d');
    assert.equal(recordFor('d').preferences.subtaskCompletionPush, false, 're-registration preserves the choice');
  });

  it('reads back through GET with the same credential', async () => {
    const token = await registerDevice('e');
    await setPrefs(token, false);
    const res = await fetch(`${API}/push/preferences`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).preferences, { subtaskCompletionPush: false });
    assert.equal((await fetch(`${API}/push/preferences`)).status, 401);
  });

  it('is not reachable on the loopback ingestion listener', async () => {
    const res = await fetch(`${INGEST}/push/preferences`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ version: 1, subtaskCompletionPush: false }),
    });
    assert.equal(res.status, 404);
  });
});

describe('what the preference suppresses', () => {
  it('OFF suppresses the child completion push and nothing else', async () => {
    const token = await registerDevice('f');
    const before = recordFor('f');
    assert.equal(allowsPush(before, child('completed')), true);

    await setPrefs(token, false);
    const off = recordFor('f');

    // The one suppressed case.
    assert.equal(allowsPush(off, child('completed')), false);

    // Everything else this device could be sent is untouched.
    for (const event of [
      ev('completed'),
      ev('needs_approval'),
      ev('needs_input'),
      ev('failed'),
      child('needs_approval'),
      child('needs_input'),
      child('failed'),
    ]) {
      const label = `${event.type}${event.subtaskId ? ' (child)' : ''}`;
      assert.equal(allowsPush(off, event), true, label);
    }
    // States that never push anyway are unaffected either way.
    for (const event of [ev('running'), ev('idle'), child('running'), child('idle')]) {
      assert.equal(allowsPush(off, event), true);
      assert.equal(shouldPush(event.type), false);
    }
  });

  it('turning it back ON restores the child completion push', async () => {
    const token = await registerDevice('g');
    await setPrefs(token, false);
    assert.equal(allowsPush(recordFor('g'), child('completed')), false);
    await setPrefs(token, true);
    assert.equal(allowsPush(recordFor('g'), child('completed')), true);
  });

  it('the preference is per device: one opting out does not silence the others', async () => {
    const quiet = await registerDevice('h');
    await registerDevice('i');
    await setPrefs(quiet, false);

    const forChildDone = targets(child('completed')).map((r) => r.endpoint);
    assert.equal(forChildDone.some((e) => e.endsWith('prefs-h')), false, 'opted out');
    assert.equal(forChildDone.some((e) => e.endsWith('prefs-i')), true, 'still subscribed');

    // A main completion still reaches every device, including the quiet one.
    const forTaskDone = targets(ev('completed')).map((r) => r.endpoint);
    assert.equal(forTaskDone.some((e) => e.endsWith('prefs-h')), true);
    assert.equal(forTaskDone.some((e) => e.endsWith('prefs-i')), true);
    assert.equal(forTaskDone.length, loadSubscriptions().length);
  });

  it('a suppressed push changes nothing about the event, its history or its text', async () => {
    const token = await registerDevice('j');
    await setPrefs(token, false);
    const event = child('completed');
    // The relay still accepts, records and reports the event exactly as before.
    const res = await fetch(`${INGEST}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(event),
    });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.pushed, true, 'the POLICY still says push-worthy; only the audience narrowed');
    assert.equal(body.sent, 0);
    // The lock-screen vocabulary is untouched by preferences.
    const payload = JSON.parse(buildPushPayload(event));
    assert.equal(payload.body, 'Subtask completed');
    assert.equal(JSON.stringify(payload).includes('preference'), false);
  });
});
