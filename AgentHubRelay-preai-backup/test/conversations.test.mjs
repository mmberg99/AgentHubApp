/**
 * Conversation storage + routes. Own scratch state dir and ports so this file
 * is independent of relay.test.mjs (node --test runs files in separate
 * processes). No VAPID keys: nothing can be pushed from here.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const SCRATCH = mkdtempSync(join(tmpdir(), 'agenthub-conv-test-'));
process.env.AGENTHUB_RELAY_STATE_DIR = SCRATCH;
process.env.AGENTHUB_BRIDGE_TOKEN = 'test-token-that-is-long-enough';
process.env.AGENTHUB_RELAY_INGEST_PORT = '18791';
process.env.AGENTHUB_RELAY_API_PORT = '18792';

const { parseConversationMessage, ConversationStore, conversations } = await import('../src/conversations.mjs');
const { MAX_MESSAGE_TEXT_CHARS } = await import('../src/config.mjs');
const { buildPushPayload } = await import('../src/push.mjs');
const { createServers } = await import('../src/server.mjs');

const INGEST = 'http://127.0.0.1:18791';
const API = 'http://127.0.0.1:18792';
const TOKEN = 'test-token-that-is-long-enough';

let servers;
before(async () => {
  servers = createServers();
  await new Promise((r) => servers.ingest.listen(18791, '127.0.0.1', r));
  await new Promise((r) => servers.api.listen(18792, '127.0.0.1', r));
});
after(() => {
  servers.ingest.close();
  servers.api.close();
  rmSync(SCRATCH, { recursive: true, force: true });
});

let n = 0;
const PROMPT = 'Fix the push notification lifecycle so Claude is idle while background tests are still running';
const ANSWER = 'Implemented the corrected lifecycle.\n\n```ts\nconst x = 1;\n```\nAll tests pass.';
function msg(overrides = {}) {
  n += 1;
  return {
    version: 1,
    messageId: `m-${String(n).padStart(4, '0')}${'a'.repeat(20)}`,
    taskId: 's-task00000000000a',
    role: 'user',
    text: PROMPT,
    timestamp: new Date(Date.UTC(2026, 8, 21, 12, 0, n)).toISOString(),
    title: 'Fix push notification lifecycle',
    ...overrides,
  };
}
const post = (path, body, token = TOKEN, base = INGEST) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const get = (path, token) =>
  fetch(`${API}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

async function registerDevice() {
  const res = await post(
    '/push/register',
    { endpoint: 'https://web.push.apple.com/test-device', keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) } },
    null,
    API,
  );
  const body = await res.json();
  assert.equal(body.ok, true);
  return body.historyToken;
}

describe('validation', () => {
  it('accepts exactly the record shape and rebuilds it', () => {
    const r = parseConversationMessage({ ...msg(), extra: 'DROPPED', tool_input: { command: 'rm' }, transcript_path: 'x' });
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(r.message).sort(), ['messageId', 'role', 'taskId', 'text', 'timestamp', 'title']);
    assert.equal('extra' in r.message, false);
  });
  it('rejects malformed ids, roles, empty text, bad timestamps, titles on assistant messages', () => {
    for (const bad of [
      { messageId: '../../etc' },
      { taskId: 'has space' },
      { subtaskId: 'C:\\x' },
      { role: 'system' },
      { text: '' },
      { text: 42 },
      { timestamp: 'yesterday' },
      { version: 2 },
      { role: 'assistant', title: 'nope' },
      { truncated: 'yes' },
    ]) {
      assert.equal(parseConversationMessage(msg(bad)).ok, false, JSON.stringify(bad));
    }
  });
  it('refuses text above the cap and keeps code blocks / newlines otherwise', () => {
    assert.equal(parseConversationMessage(msg({ text: 'x'.repeat(MAX_MESSAGE_TEXT_CHARS + 1) })).ok, false);
    const r = parseConversationMessage(msg({ role: 'assistant', title: undefined, text: ANSWER }));
    assert.equal(r.ok, true);
    assert.equal(r.message.text, ANSWER);
  });
});

describe('store', () => {
  it('writes one file per task, dedupes by messageId, keeps order, names from the first prompt only', async () => {
    const dir = join(SCRATCH, 'store-a');
    const store = new ConversationStore(dir);
    const t = 's-store000000000a';
    const first = msg({ taskId: t });
    assert.deepEqual(await store.add(first), { stored: true, duplicate: false });
    assert.deepEqual(await store.add(first), { stored: false, duplicate: true });
    await store.add(msg({ taskId: t, role: 'assistant', title: undefined, text: ANSWER }));
    await store.add(msg({ taskId: t, text: 'Now fix duplicate subscriptions', title: 'Fix duplicate subscriptions' }));
    await store.add(msg({ taskId: t, role: 'assistant', title: undefined, text: 'Done.' }));
    const conv = store.get(t);
    assert.equal(conv.title, 'Fix push notification lifecycle', 'second prompt does not rename');
    assert.deepEqual(conv.thread.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
    assert.deepEqual(readdirSync(dir), [`${t}.json`]);
    const raw = readFileSync(join(dir, `${t}.json`), 'utf8');
    for (const needle of ['session_id', 'agent_id', 'cwd', 'transcript', 'tool_input']) assert.equal(raw.includes(needle), false, needle);
  });
  it('child messages go to the child thread, never the parent thread', async () => {
    const store = new ConversationStore(join(SCRATCH, 'store-b'));
    const t = 's-store000000000b';
    await store.add(msg({ taskId: t }));
    await store.add(msg({ taskId: t, subtaskId: 't-child0000000001', role: 'assistant', title: undefined, text: 'Found the Stop hook issue.' }), { agentType: 'Explore' });
    await store.add(msg({ taskId: t, subtaskId: 't-child0000000002', text: 'Validate relay behavior', title: 'Validate relay behavior' }));
    const conv = store.get(t);
    assert.equal(conv.thread.messages.length, 1);
    assert.equal(conv.children['t-child0000000001'].messages[0].text, 'Found the Stop hook issue.');
    assert.equal(conv.children['t-child0000000001'].agentType, 'Explore');
    assert.equal(conv.children['t-child0000000002'].title, 'Validate relay behavior');
    assert.equal(conv.title, 'Fix push notification lifecycle', 'a child prompt never names the parent');
    const summary = ConversationStore.summarize(conv);
    assert.equal(summary.messageCount, 1);
    assert.equal(summary.children['t-child0000000002'].title, 'Validate relay behavior');
    assert.equal(JSON.stringify(summary).includes(PROMPT), false, 'summaries carry no text');
  });
  it('identical text with different messageIds is two turns; the same messageId replayed is one', async () => {
    const store = new ConversationStore(join(SCRATCH, 'store-e'));
    const t = 's-store000000000e';
    const a = msg({ taskId: t, text: 'Run the tests', title: 'Run tests' });
    assert.deepEqual(await store.add(a), { stored: true, duplicate: false });
    assert.deepEqual(await store.add({ ...a }), { stored: false, duplicate: true }, 'replay of the same record');
    const ra = msg({ taskId: t, role: 'assistant', title: undefined, text: 'All green.' });
    await store.add(ra);
    const b = msg({ taskId: t, text: 'Run the tests', title: 'Run the tests again?' }); // a later, separate invocation
    assert.deepEqual(await store.add(b), { stored: true, duplicate: false });
    const rb = msg({ taskId: t, role: 'assistant', title: undefined, text: 'All green.' }); // identical response text, separate turn
    assert.deepEqual(await store.add(rb), { stored: true, duplicate: false });
    await store.add({ ...rb });
    const conv = store.get(t);
    assert.deepEqual(conv.thread.messages.map((m) => [m.role, m.text]), [
      ['user', 'Run the tests'],
      ['assistant', 'All green.'],
      ['user', 'Run the tests'],
      ['assistant', 'All green.'],
    ]);
    assert.equal(conv.title, 'Run tests', 'title from the first user turn only');
  });
  it('keeps every turn: more than 400 messages remain, and a fresh store instance reads them all back', async () => {
    const dir = join(SCRATCH, 'store-c');
    const store = new ConversationStore(dir);
    const t = 's-store000000000c';
    const N = 450;
    for (let i = 0; i < N; i += 1) await store.add(msg({ taskId: t, role: i % 2 ? 'assistant' : 'user', text: `m${i}`, title: i === 0 ? 'First' : undefined }));
    const conv = store.get(t);
    assert.equal(conv.thread.messages.length, N);
    assert.equal(conv.thread.messages[0].text, 'm0');
    assert.equal(conv.thread.messages[N - 1].text, `m${N - 1}`);
    assert.equal('trimmed' in conv.thread, false);
    // "Reload": a new instance over the same directory sees the complete thread.
    const reloaded = new ConversationStore(dir).get(t);
    assert.equal(reloaded.thread.messages.length, N);
    assert.equal(reloaded.title, 'First');
    assert.equal(ConversationStore.summarize(reloaded).messageCount, N);
  });
  it('a bad task id can never become a path', () => {
    const store = new ConversationStore(join(SCRATCH, 'store-d'));
    assert.equal(store.get('../../vapid'), null);
    assert.throws(() => store.pathFor('..\\x'));
  });
});

describe('routes', () => {
  it('POST /messages on the ingestion listener stores with the ingestion token; replay is a duplicate', async () => {
    const m = msg({ taskId: 's-route00000000001' });
    let res = await post('/messages', m);
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { ok: true, stored: true, duplicate: false });
    res = await post('/messages', m);
    assert.deepEqual(await res.json(), { ok: true, stored: false, duplicate: true });
    assert.equal(existsSync(join(SCRATCH, 'conversations', 's-route00000000001.json')), true);
  });
  it('over the wire: same messageId once, identical text with new ids twice, order kept', async () => {
    const t = 's-route00000000002';
    const a = msg({ taskId: t, text: 'Run the tests', title: 'Run tests' });
    await post('/messages', a);
    await post('/messages', a);
    await post('/messages', msg({ taskId: t, role: 'assistant', title: undefined, text: 'All green.' }));
    await post('/messages', msg({ taskId: t, text: 'Run the tests', title: 'Run tests' }));
    await post('/messages', msg({ taskId: t, role: 'assistant', title: undefined, text: 'All green.' }));
    const conv = conversations.get(t);
    assert.deepEqual(conv.thread.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
    assert.equal(conv.thread.messages.filter((m) => m.text === 'Run the tests').length, 2);
  });
  it('POST /messages requires the token, rejects garbage, and caps the body', async () => {
    assert.equal((await post('/messages', msg(), null)).status, 401);
    assert.equal((await post('/messages', msg(), 'wrong-token-wrong-token')).status, 401);
    assert.equal((await post('/messages', { version: 1, hello: 'world' })).status, 422);
    assert.equal((await post('/messages', 'not json')).status, 400);
    const huge = msg({ text: 'x'.repeat(200 * 1024) });
    assert.equal((await post('/messages', huge)).status, 413);
    const tooLongButUnderBody = msg({ text: 'x'.repeat(MAX_MESSAGE_TEXT_CHARS + 10) });
    const r = await post('/messages', tooLongButUnderBody);
    assert.equal(r.status, 422, 'explicitly rejected, never silently cut');
  });
  it('the PWA listener has NO write route and the ingestion listener has NO read route', async () => {
    assert.equal((await post('/messages', msg(), TOKEN, API)).status, 404);
    assert.equal((await post('/api/messages', msg(), TOKEN, API)).status, 404);
    assert.equal((await fetch(`${INGEST}/conversations`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 404);
    assert.equal((await fetch(`${INGEST}/conversation/s-route00000000001`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 404);
  });
  it('reads require a device capability token; the ingestion token does not work there', async () => {
    assert.equal((await get('/conversations')).status, 401);
    assert.equal((await get('/conversations', TOKEN)).status, 401);
    assert.equal((await get('/conversation/s-route00000000001', TOKEN)).status, 401);
    const cap = await registerDevice();
    const list = await (await get('/conversations', cap)).json();
    assert.equal(list.ok, true);
    const entry = list.conversations.find((c) => c.taskId === 's-route00000000001');
    assert.equal(entry.title, 'Fix push notification lifecycle');
    assert.equal(entry.messageCount, 1);
    assert.equal(JSON.stringify(list).includes(PROMPT), false, 'listing carries titles, not text');
    const conv = await (await get('/conversation/s-route00000000001', cap)).json();
    assert.equal(conv.ok, true);
    assert.equal(conv.conversation.thread.messages[0].text, PROMPT);
    assert.equal((await get('/conversation/s-missing0000000000', cap)).status, 404);
    assert.equal((await get('/conversation/..%2F..%2Fvapid', cap)).status, 404);
    // The /api prefix Tailscale forwards is accepted too.
    assert.equal((await get('/api/conversations', cap)).status, 200);
  });
  it('conversation text never enters a push payload', async () => {
    const event = { version: 1, eventId: 'e-1', agentId: 'win_claude_code', agentName: 'Claude Code', type: 'completed', title: 'Task completed', message: 'Claude Code completed a task.', timestamp: new Date().toISOString(), taskId: 's-route00000000001' };
    const payload = JSON.stringify(buildPushPayload(event));
    assert.equal(payload.includes(PROMPT), false);
    assert.equal(payload.includes('Fix push notification lifecycle'), false, 'not even the derived title');
    assert.equal(payload.includes('text'), false);
  });
});
