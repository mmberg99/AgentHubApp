/**
 * Relay test suite. Standard library only — `node --test test/`.
 *
 * The state directory is redirected to a scratch folder BEFORE any module that
 * reads config is imported, so tests never touch real subscriptions or the real
 * VAPID key.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const SCRATCH = mkdtempSync(join(tmpdir(), 'agenthub-relay-test-'));
process.env.AGENTHUB_RELAY_STATE_DIR = SCRATCH;
process.env.AGENTHUB_BRIDGE_TOKEN = 'test-token-that-is-long-enough';
process.env.AGENTHUB_RELAY_INGEST_PORT = '18781';
process.env.AGENTHUB_RELAY_API_PORT = '18782';

const { parseAgentNotificationEvent } = await import('../src/validateAgentEvent.mjs');
const { toLockScreenNotification, isPolicyApprovedBody, LOCK_SCREEN_BODIES, shouldPush, isFreshTransition } =
  await import('../src/notificationPolicy.mjs');
const { EventHistory } = await import('../src/history.mjs');
const { buildPushPayload } = await import('../src/push.mjs');
const storage = await import('../src/storage.mjs');
const { createServers, history } = await import('../src/server.mjs');

const INGEST = 'http://127.0.0.1:18781';
const API = 'http://127.0.0.1:18782';
const TOKEN = 'test-token-that-is-long-enough';

let servers;

before(async () => {
  servers = createServers();
  await new Promise((r) => servers.ingest.listen(18781, '127.0.0.1', r));
  await new Promise((r) => servers.api.listen(18782, '127.0.0.1', r));
});

after(() => {
  servers.ingest.close();
  servers.api.close();
  rmSync(SCRATCH, { recursive: true, force: true });
});

function validEvent(overrides = {}) {
  return {
    version: 1,
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    agentId: 'win_claude_code',
    agentName: 'Claude Code',
    type: 'completed',
    title: 'Claude Code',
    message: 'Claude Code completed a task.',
    timestamp: new Date().toISOString(),
    provider: 'claude',
    ...overrides,
  };
}

const post = (url, body, token) =>
  fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

/* ------------------------------------------------------------- validation */

describe('protocol validation', () => {
  it('accepts a well-formed event', () => {
    const result = parseAgentNotificationEvent(validEvent());
    assert.equal(result.ok, true);
  });

  it('rejects a wrong protocol version', () => {
    const result = parseAgentNotificationEvent(validEvent({ version: 2 }));
    assert.equal(result.ok, false);
  });

  it('rejects an unknown event type', () => {
    const result = parseAgentNotificationEvent(validEvent({ type: 'exploded' }));
    assert.equal(result.ok, false);
  });

  it('discards unknown fields rather than passing them through', () => {
    const result = parseAgentNotificationEvent({ ...validEvent(), evil: 'payload' });
    assert.equal(result.ok, true);
    assert.equal('evil' in result.event, false);
  });

  it('passes optional project identity through intact', () => {
    const result = parseAgentNotificationEvent(
      validEvent({ projectId: 'p-3f9a1c2b4d5e', projectName: 'RobotFramework', taskId: 's-abcdef0123456789' }),
    );
    assert.equal(result.ok, true);
    assert.equal(result.event.projectId, 'p-3f9a1c2b4d5e');
    assert.equal(result.event.projectName, 'RobotFramework');
    assert.equal(result.event.taskId, 's-abcdef0123456789');
  });

  it('still validates an event with no project fields (older senders)', () => {
    const result = parseAgentNotificationEvent(validEvent());
    assert.equal(result.ok, true);
    assert.equal('projectId' in result.event, false);
    assert.equal('projectName' in result.event, false);
  });

  it('redacts a full path that a sender wrongly put in projectName', () => {
    const result = parseAgentNotificationEvent(
      validEvent({ projectName: String.raw`C:\Users\someone\source\repos\Secret` }),
    );
    assert.equal(result.ok, true);
    assert.ok(!result.event.projectName.includes('someone'));
    assert.ok(result.event.projectName.includes('[redacted]'));
  });

  it('redacts Windows paths and key-like tokens from displayed text', () => {
    const result = parseAgentNotificationEvent(
      validEvent({ message: String.raw`see C:\Users\someone\secret.ts and sk-abcdefgh12345678` }),
    );
    assert.equal(result.ok, true);
    assert.ok(!result.event.message.includes('secret.ts'));
    assert.ok(!result.event.message.includes('sk-abcdefgh'));
    assert.ok(result.event.message.includes('[redacted]'));
  });
});

/* ------------------------------------------------------ lock-screen policy */

describe('lock-screen privacy policy', () => {
  it('never uses event.message as the notification body', () => {
    const event = validEvent({ message: 'SECRET PROSE THAT MUST NOT APPEAR' });
    const { body } = toLockScreenNotification(event);
    assert.ok(!body.includes('SECRET'));
    assert.ok(isPolicyApprovedBody(body));
  });

  it('uses only fixed bodies for every event type', () => {
    for (const type of ['started', 'running', 'idle', 'completed', 'needs_approval', 'needs_input', 'failed']) {
      const { body } = toLockScreenNotification(validEvent({ type }));
      assert.ok(LOCK_SCREEN_BODIES.includes(body), `${type} produced "${body}"`);
    }
  });

  it('pushes only for completed / needs_approval / needs_input / failed', () => {
    assert.equal(shouldPush('completed'), true);
    assert.equal(shouldPush('needs_approval'), true);
    assert.equal(shouldPush('needs_input'), true);
    assert.equal(shouldPush('failed'), true);
    assert.equal(shouldPush('started'), false);
    assert.equal(shouldPush('running'), false);
    assert.equal(shouldPush('idle'), false);
  });

  it('a repeat completed for the same task is not a fresh transition', () => {
    assert.equal(isFreshTransition('completed', null), true);
    assert.equal(isFreshTransition('completed', 'running'), true);
    assert.equal(isFreshTransition('completed', 'idle'), true);
    assert.equal(isFreshTransition('completed', 'completed'), false);
    // Only completed is guarded; the others always count.
    assert.equal(isFreshTransition('failed', 'failed'), true);
    assert.equal(isFreshTransition('needs_input', 'needs_input'), true);
  });

  it('lock-screen text never includes the project name', () => {
    const event = validEvent({ projectId: 'p-3f9a1c2b4d5e', projectName: 'RobotFramework' });
    const { title, body } = toLockScreenNotification(event);
    assert.ok(!title.includes('RobotFramework'));
    assert.ok(!body.includes('RobotFramework'));
    // ...while the app still receives it inside data.agentEvent.
    const payload = JSON.parse(buildPushPayload(event));
    assert.ok(!payload.title.includes('RobotFramework'));
    assert.ok(!payload.body.includes('RobotFramework'));
    assert.equal(payload.data.agentEvent.projectName, 'RobotFramework');
  });

  it('push payload carries the full event but a policy body', () => {
    const event = validEvent({ message: 'DO NOT LEAK' });
    const payload = JSON.parse(buildPushPayload(event));
    assert.ok(isPolicyApprovedBody(payload.body));
    assert.ok(!payload.body.includes('DO NOT LEAK'));
    // The full event still travels in data, where the app reads it.
    assert.equal(payload.data.agentEvent.message, 'DO NOT LEAK');
  });
});

/* ----------------------------------------------------------------- history */

describe('event history', () => {
  it('suppresses duplicate event ids', () => {
    const h = new EventHistory();
    assert.equal(h.add(validEvent({ eventId: 'dupe' })), true);
    assert.equal(h.add(validEvent({ eventId: 'dupe' })), false);
    assert.equal(h.since(0).events.length, 1);
  });

  it('is bounded', () => {
    const h = new EventHistory({ max: 5 });
    for (let i = 0; i < 20; i += 1) h.add(validEvent({ eventId: `e${i}` }));
    assert.equal(h.since(0).events.length, 5);
  });

  it('returns only events newer than the cursor', () => {
    const h = new EventHistory();
    h.add(validEvent({ eventId: 'a' }));
    const first = h.since(0);
    h.add(validEvent({ eventId: 'b' }));
    const second = h.since(first.cursor);
    assert.equal(second.events.length, 1);
    assert.equal(second.events[0].eventId, 'b');
  });

  it('gives each instance a distinct id so clients detect a restart', () => {
    assert.notEqual(new EventHistory().instanceId, new EventHistory().instanceId);
  });
});

/* -------------------------------------------------------- ingestion :8781 */

describe('ingestion endpoint', () => {
  it('accepts a valid authenticated event', async () => {
    const res = await post(`${INGEST}/events`, validEvent(), TOKEN);
    assert.equal(res.status, 202);
    assert.equal((await res.json()).ok, true);
  });

  it('rejects a wrong token', async () => {
    const res = await post(`${INGEST}/events`, validEvent(), 'wrong-token-wrong-token');
    assert.equal(res.status, 401);
  });

  it('rejects a missing token', async () => {
    const res = await post(`${INGEST}/events`, validEvent());
    assert.equal(res.status, 401);
  });

  it('rejects an oversized payload', async () => {
    const huge = JSON.stringify({ ...validEvent(), pad: 'x'.repeat(20000) });
    const res = await post(`${INGEST}/events`, huge, TOKEN).catch(() => ({ status: 413 }));
    assert.ok(res.status === 413 || res.status === 400, `got ${res.status}`);
  });

  it('rejects a malformed event with 422', async () => {
    const res = await post(`${INGEST}/events`, { version: 1, nope: true }, TOKEN);
    assert.equal(res.status, 422);
  });

  it('reports a duplicate without re-sending', async () => {
    const event = validEvent({ eventId: 'ingest-dupe' });
    await post(`${INGEST}/events`, event, TOKEN);
    const res = await post(`${INGEST}/events`, event, TOKEN);
    const body = await res.json();
    assert.equal(body.duplicate, true);
    assert.equal(body.pushed, false);
  });

  it('accepts idle and records it silently', async () => {
    const res = await post(`${INGEST}/events`, validEvent({ type: 'idle', taskId: 's-idle-task' }), TOKEN);
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.pushed, false, 'idle must never push');
  });

  it('records started and running without pushing', async () => {
    for (const type of ['started', 'running']) {
      const res = await post(`${INGEST}/events`, validEvent({ type, taskId: 's-quiet-task' }), TOKEN);
      assert.equal((await res.json()).pushed, false, `${type} must not push`);
    }
  });

  it('pushes for needs_approval, needs_input and failed', async () => {
    for (const type of ['needs_approval', 'needs_input', 'failed']) {
      const res = await post(`${INGEST}/events`, validEvent({ type, taskId: `s-attn-${type}` }), TOKEN);
      assert.equal((await res.json()).pushed, true, `${type} must push`);
    }
  });

  it('the lifecycle: running -> idle (silent) -> running -> completed pushes exactly once', async () => {
    const taskId = 's-lifecycle-task';
    const step = async (type) => (await (await post(`${INGEST}/events`, validEvent({ type, taskId }), TOKEN)).json()).pushed;
    assert.equal(await step('running'), false);
    assert.equal(await step('idle'), false, 'Stop with background work: no push');
    assert.equal(await step('running'), false);
    assert.equal(await step('completed'), true, 'genuine completion: one push');
  });

  it('the exact user experience: open (idle) -> prompt -> stop(bg) -> prompt -> done = exactly one push, at the end', async () => {
    const taskId = 's-ux-task';
    const pushes = [];
    for (const type of ['idle', 'running', 'idle', 'running', 'completed']) {
      pushes.push((await (await post(`${INGEST}/events`, validEvent({ type, taskId }), TOKEN)).json()).pushed);
    }
    assert.deepEqual(pushes, [false, false, false, false, true]);
    assert.equal(pushes.filter(Boolean).length, 1);
  });

  it('subtask events: completion pushes "Subtask completed", running is silent, parent guard untouched', async () => {
    const taskId = 's-parent-task';
    const sub = (type, subtaskId) => post(`${INGEST}/events`, validEvent({ type, taskId, subtaskId, agentType: 'Explore' }), TOKEN).then((r) => r.json());
    assert.equal((await sub('running', 't-sub-1')).pushed, false);
    assert.equal((await sub('completed', 't-sub-1')).pushed, true, 'subtask completion pushes');
    assert.equal((await sub('completed', 't-sub-1')).pushed, false, 'repeat subtask completion is guarded');
    assert.equal((await sub('completed', 't-sub-2')).pushed, true, 'a different subtask has its own guard');
    // The PARENT finishing afterwards is a fresh transition of its own key.
    const parent = await post(`${INGEST}/events`, validEvent({ type: 'completed', taskId }), TOKEN).then((r) => r.json());
    assert.equal(parent.pushed, true, 'subtask completions never consumed the parent transition');
  });

  it('subtask lock-screen text is generic and references nothing but the agent name', () => {
    const ev = validEvent({ type: 'completed', taskId: 's-p', subtaskId: 't-c', agentType: 'security-reviewer', message: 'SECRET PROSE' });
    const { title, body } = toLockScreenNotification(ev);
    assert.equal(body, 'Subtask completed');
    assert.ok(!title.includes('security-reviewer') && !body.includes('security-reviewer'));
    assert.ok(!body.includes('SECRET'));
    const payload = JSON.parse(buildPushPayload(ev));
    assert.equal(payload.data.agentEvent.taskId, 's-p', 'parent task travels in data');
    assert.equal(payload.data.agentEvent.subtaskId, 't-c');
  });

  it('a child event never carries project identity onward (the project belongs to the main session)', () => {
    const r = parseAgentNotificationEvent(validEvent({ type: 'running', taskId: 's-p', subtaskId: 't-c', projectId: 'p-other', projectName: 'SomeOtherWorkspace' }));
    assert.equal(r.ok, true);
    assert.equal(r.event.subtaskId, 't-c');
    assert.equal(r.event.taskId, 's-p');
    assert.equal('projectId' in r.event, false);
    assert.equal('projectName' in r.event, false);
    assert.equal(JSON.stringify(r.event).includes('SomeOtherWorkspace'), false);
    // A main event keeps its project exactly as before.
    const m = parseAgentNotificationEvent(validEvent({ type: 'running', taskId: 's-p', projectId: 'p-main', projectName: 'AgentHub' }));
    assert.equal(m.event.projectName, 'AgentHub');
  });

  it('a subtaskId without a parent taskId is refused', async () => {
    const res = await post(`${INGEST}/events`, validEvent({ type: 'completed', taskId: undefined, subtaskId: 't-orphan' }), TOKEN);
    assert.equal(res.status, 422);
  });

  it('agentType is redacted like displayed text and old events without subtask fields still validate', () => {
    const r = parseAgentNotificationEvent(validEvent({ taskId: 's-p', subtaskId: 't-c', agentType: String.raw`C:\Users\x\evil` }));
    assert.equal(r.ok, true);
    assert.ok(r.event.agentType.includes('[redacted]'));
    const plain = parseAgentNotificationEvent(validEvent());
    assert.equal(plain.ok, true);
    assert.equal('subtaskId' in plain.event, false);
  });

  it('opening a session (idle) never pushes, and a stray started never pushes either', async () => {
    for (const type of ['idle', 'started']) {
      const res = await post(`${INGEST}/events`, validEvent({ type, taskId: `s-open-${type}` }), TOKEN);
      assert.equal((await res.json()).pushed, false, `${type} must not notify`);
    }
  });

  it('a repeated completed for the same task does not push again; new activity re-arms it', async () => {
    const taskId = 's-repeat-task';
    const step = async (type) => (await (await post(`${INGEST}/events`, validEvent({ type, taskId }), TOKEN)).json()).pushed;
    assert.equal(await step('completed'), true, 'first completion pushes');
    assert.equal(await step('completed'), false, 'repeat completion with no activity in between is silent');
    assert.equal(await step('running'), false);
    assert.equal(await step('completed'), true, 'a new turn that finishes pushes once more');
  });

  it('the completed guard is per task, not global', async () => {
    const a = (await (await post(`${INGEST}/events`, validEvent({ type: 'completed', taskId: 's-guard-a' }), TOKEN)).json()).pushed;
    const b = (await (await post(`${INGEST}/events`, validEvent({ type: 'completed', taskId: 's-guard-b' }), TOKEN)).json()).pushed;
    assert.equal(a, true);
    assert.equal(b, true);
  });

  it('exposes no other route', async () => {
    for (const path of ['/history', '/push/register', '/health', '/']) {
      const res = await fetch(`${INGEST}${path}`);
      assert.equal(res.status, 404, `${path} should not exist on the ingestion port`);
    }
  });
});

/* ----------------------------------------------------------- pwa api :8782 */

describe('pwa api', () => {
  let historyToken;

  it('does NOT expose /events', async () => {
    const res = await post(`${API}/events`, validEvent(), TOKEN);
    assert.equal(res.status, 404);
  });

  it('registers a valid subscription and returns a capability token once', async () => {
    const res = await post(`${API}/push/register`, {
      endpoint: 'https://web.push.apple.com/test-endpoint-1',
      keys: { p256dh: 'BExamplePublicKeyValue', auth: 'ExampleAuthSecret' },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.historyToken, 'string');
    assert.ok(body.historyToken.length >= 40);
    historyToken = body.historyToken;
  });

  it('stores only a hash of the capability token, never the token itself', () => {
    const raw = readFileSync(join(SCRATCH, 'subscriptions.json'), 'utf8');
    assert.ok(!raw.includes(historyToken), 'plaintext token found in storage');
    assert.ok(raw.includes('tokenHash'));
  });

  it('rejects a malformed subscription', async () => {
    for (const bad of [
      {},
      { endpoint: 'https://x', keys: {} },
      { endpoint: 'http://insecure.example', keys: { p256dh: 'a', auth: 'b' } },
      { endpoint: 'https://x', keys: { p256dh: 'a' } },
    ]) {
      const res = await post(`${API}/push/register`, bad);
      assert.equal(res.status, 400, `should reject ${JSON.stringify(bad)}`);
    }
  });

  it('rejects /history without a capability token', async () => {
    const res = await fetch(`${API}/history`);
    assert.equal(res.status, 401);
  });

  it('rejects /history with a wrong capability token', async () => {
    const res = await fetch(`${API}/history`, {
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    assert.equal(res.status, 401);
  });

  it('rejects /history using the INGESTION token', async () => {
    const res = await fetch(`${API}/history`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 401, 'notifier token must not grant history access');
  });

  it('serves /history with the correct capability token', async () => {
    const res = await fetch(`${API}/history`, {
      headers: { authorization: `Bearer ${historyToken}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.instanceId, 'string');
    assert.equal(typeof body.cursor, 'number');
    assert.ok(Array.isArray(body.events));
  });

  it('never enumerates subscriptions through any route', async () => {
    const res = await fetch(`${API}/history`, {
      headers: { authorization: `Bearer ${historyToken}` },
    });
    const text = await res.text();
    assert.ok(!text.includes('web.push.apple.com'), 'endpoint leaked through history');
    assert.ok(!text.includes('tokenHash'));
  });

  it('revokes the token when its subscription is removed', async () => {
    await storage.removeSubscription('https://web.push.apple.com/test-endpoint-1');
    const res = await fetch(`${API}/history`, {
      headers: { authorization: `Bearer ${historyToken}` },
    });
    assert.equal(res.status, 401);
  });

  it('accepts both /x and /api/x so Tailscale prefix behaviour cannot break it', async () => {
    const a = await fetch(`${API}/health`);
    const b = await fetch(`${API}/api/health`);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
  });
});

/* ------------------------------------------------------------------ vapid */

describe('vapid storage', () => {
  it('does not create a key file merely by importing the relay', () => {
    assert.equal(existsSync(join(SCRATCH, 'vapid.json')), false);
  });

  it('round-trips a keypair and keeps the private key out of history responses', async () => {
    storage.saveVapid({ publicKey: 'PUB', privateKey: 'PRIV-SECRET', subject: 'mailto:x@y' });
    assert.equal(storage.loadVapid().privateKey, 'PRIV-SECRET');
    const res = await fetch(`${API}/health`);
    assert.ok(!(await res.text()).includes('PRIV-SECRET'));
  });
});
