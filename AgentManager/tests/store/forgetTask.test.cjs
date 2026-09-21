/**
 * "Forget task" — reducer, selectors and persistence, tested against the real
 * compiled source with Node's built-in runner.
 *
 *   npm run test:store
 *
 * A tiny in-memory localStorage stands in for the browser's so persistence can
 * be asserted byte for byte, including that the push keys are never touched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

/* ------------------------------------------------------- localStorage shim */

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => void mem.set(k, String(v)),
  removeItem: (k) => void mem.delete(k),
  clear: () => mem.clear(),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size;
  },
};

const BUILD = path.join(__dirname, '.build');
const { agentReducer } = require(path.join(BUILD, 'store', 'agentStore.js'));
const sel = require(path.join(BUILD, 'store', 'selectors.js'));
const { parseAgentNotificationEvent } = require(path.join(BUILD, 'protocol', 'index.js'));
const { loadTaskStorage, saveTaskStorage, TASK_STORAGE_KEY } = require(
  path.join(BUILD, 'services', 'persistence', 'index.js'),
);

/* ------------------------------------------------------------- fixtures */

const ALPHA = { projectId: 'p-0d05a834d1d7', projectName: 'WorkspaceAlpha' };
const BETA = { projectId: 'p-af2a9f24c656', projectName: 'WorkspaceBeta' };
const S1 = 's-cf7bbee31fb8bcd4';
const S2 = 's-e0685043bffb5d2b';
const S3 = 's-55ce49f7a0021060';

let seq = 0;
function event(project, taskId, type, at) {
  seq += 1;
  return {
    version: 1,
    eventId: `evt-${String(seq).padStart(4, '0')}${'a'.repeat(28)}`,
    agentId: 'win_claude_code',
    agentName: 'Claude Code',
    type,
    title: 'Task update',
    message: `Claude Code ${type}.`,
    timestamp: at,
    provider: 'claude',
    taskId,
    ...project,
  };
}

const EMPTY = { agents: [], events: [], approvals: [], tasks: [], taskMeta: {}, forgottenTasks: {}, subtasks: [], projectCounters: {}, conversations: {} };

function ingest(state, raw) {
  const r = parseAgentNotificationEvent(raw);
  assert.equal(r.ok, true, 'fixture must validate: ' + (r.errors || []).join('; '));
  return agentReducer(state, { type: 'ingestRemoteEvent', event: r.event, source: 'push' });
}

/** Alpha: s1 (finished) + s2 (running).  Beta: s3 (needs input). */
function seeded() {
  const t = (m) => new Date(Date.UTC(2026, 8, 20, 10, m)).toISOString();
  let s = EMPTY;
  s = ingest(s, event(ALPHA, S1, 'started', t(0)));
  s = ingest(s, event(ALPHA, S1, 'completed', t(1)));
  s = ingest(s, event(ALPHA, S2, 'started', t(2)));
  s = ingest(s, event(BETA, S3, 'started', t(3)));
  s = ingest(s, event(BETA, S3, 'needs_input', t(4)));
  return s;
}

const forget = (state, id) => agentReducer(state, { type: 'forgetTask', taskId: id });
const groupNames = (state) => sel.groupTasksByProject(sel.activeTasks(state.tasks)).map((g) => g.project.name).sort();
const ids = (state) => state.tasks.map((t) => t.id).sort();

test.beforeEach(() => {
  mem.clear();
  seq = 0;
});

/* ------------------------------------------------------------------ tests */

test('seed sanity: 3 tasks across 2 projects', () => {
  const s = seeded();
  assert.deepEqual(ids(s), [S1, S2, S3].sort());
  assert.deepEqual(groupNames(s), ['WorkspaceAlpha', 'WorkspaceBeta']);
  assert.equal(sel.runningTaskCount(s.tasks), 1);
  assert.equal(sel.needsActionCount(s.tasks), 1);
});

test('forgetting an ACTIVE task removes it from Home and the counts immediately', () => {
  let s = seeded();
  s = forget(s, S2); // the running one
  assert.deepEqual(ids(s), [S1, S3].sort());
  assert.equal(sel.runningTaskCount(s.tasks), 0, 'running count updates');
  assert.equal(sel.activeProjectCount(s.tasks), 2, 'Alpha still has s1');
  const alpha = sel.groupTasksByProject(sel.activeTasks(s.tasks)).find((g) => g.project.name === 'WorkspaceAlpha');
  assert.equal(alpha.tasks.length, 1);
  assert.equal(alpha.running, 0);
  assert.equal(alpha.finished, 1);
});

test('forgetting an ACCEPTED task removes it from Summary', () => {
  let s = seeded();
  s = agentReducer(s, { type: 'acceptTask', taskId: S1 });
  assert.equal(sel.acceptedTasks(s.tasks).length, 1);
  s = forget(s, S1);
  assert.equal(sel.acceptedTasks(s.tasks).length, 0, 'gone from Summary');
  assert.ok(!s.tasks.some((t) => t.id === S1), 'record removed');
  assert.deepEqual(groupNames(s), ['WorkspaceAlpha', 'WorkspaceBeta'], 'Alpha survives via s2');
});

test('task metadata (chat URL, prompt draft, custom title) is removed with the task', () => {
  let s = seeded();
  s = agentReducer(s, {
    type: 'setTaskMeta',
    taskId: S1,
    patch: { chatUrl: 'https://chatgpt.com/c/abc', promptDraft: 'do more', customTitle: 'My task' },
  });
  s = agentReducer(s, { type: 'setTaskMeta', taskId: S2, patch: { chatUrl: 'https://chatgpt.com/c/keep' } });
  assert.ok(s.taskMeta[S1].chatUrl);
  s = forget(s, S1);
  assert.equal(s.taskMeta[S1], undefined, 'meta for the forgotten task is gone');
  assert.equal(s.taskMeta[S2].chatUrl, 'https://chatgpt.com/c/keep', 'sibling meta untouched');

  saveTaskStorage(s.tasks, s.taskMeta, s.forgottenTasks);
  const blob = JSON.parse(localStorage.getItem(TASK_STORAGE_KEY));
  assert.equal(blob.meta[S1], undefined, 'not persisted either');
  assert.ok(!JSON.stringify(blob).includes('chatgpt.com/c/abc'));
  assert.ok(!JSON.stringify(blob).includes('do more'));
  assert.ok(!JSON.stringify(blob).includes('My task'));
});

test('another task in the same project is preserved exactly', () => {
  let s = seeded();
  const s2Before = s.tasks.find((t) => t.id === S2);
  s = forget(s, S1);
  const s2After = s.tasks.find((t) => t.id === S2);
  assert.deepEqual(s2After, s2Before);
  assert.equal(sel.groupTasksByProject(sel.activeTasks(s.tasks)).find((g) => g.project.name === 'WorkspaceAlpha').tasks.length, 1);
});

test('an empty project disappears from Home/Summary grouping after its final task is forgotten', () => {
  let s = seeded();
  s = forget(s, S3); // Beta's only task
  assert.deepEqual(groupNames(s), ['WorkspaceAlpha']);
  assert.equal(sel.activeProjectCount(s.tasks), 1);
  assert.equal(sel.needsActionCount(s.tasks), 0);
  // Summary grouping uses the same selector on accepted tasks.
  assert.equal(sel.groupTasksByProject(sel.acceptedTasks(s.tasks)).length, 0);
});

test('push subscription / local push state is untouched by forgetting and saving', () => {
  localStorage.setItem('agenthub.push.historyToken', 'CAPABILITY-TOKEN-UNCHANGED');
  localStorage.setItem('agenthub.push.cursor', '42');
  localStorage.setItem('agenthub.push.instanceId', 'relay-instance-xyz');
  const otherKeysBefore = ['agenthub.push.historyToken', 'agenthub.push.cursor', 'agenthub.push.instanceId'].map((k) => [k, localStorage.getItem(k)]);

  let s = seeded();
  saveTaskStorage(s.tasks, s.taskMeta, s.forgottenTasks);
  s = forget(s, S1);
  s = forget(s, S3);
  saveTaskStorage(s.tasks, s.taskMeta, s.forgottenTasks);

  for (const [k, v] of otherKeysBefore) assert.equal(localStorage.getItem(k), v, `${k} unchanged`);
  assert.equal(localStorage.length, 4, 'exactly one task-storage key plus the three push keys');
  assert.ok(localStorage.getItem(TASK_STORAGE_KEY));
});

test('forgotten state survives a reload: task gone, tombstone kept, nothing resurrected', () => {
  let s = seeded();
  s = forget(s, S3);
  saveTaskStorage(s.tasks, s.taskMeta, s.forgottenTasks);

  const restored = loadTaskStorage();
  assert.deepEqual(restored.tasks.map((t) => t.id).sort(), [S1, S2].sort());
  assert.ok(restored.forgotten[S3], 'tombstone persisted');
  assert.equal(restored.forgotten[S1], undefined);
});

test('a history REPLAY of old events cannot resurrect a forgotten task', () => {
  let s = seeded();
  s = forget(s, S3);
  // The relay re-delivers s3's original events (older than the tombstone).
  const t = (m) => new Date(Date.UTC(2026, 8, 20, 10, m)).toISOString();
  s = ingest(s, event(BETA, S3, 'started', t(3)));
  s = ingest(s, event(BETA, S3, 'needs_input', t(4)));
  assert.ok(!s.tasks.some((x) => x.id === S3), 'still forgotten');
  assert.deepEqual(groupNames(s), ['WorkspaceAlpha']);
  assert.equal(s.events.length, 7, 'the events themselves are still recorded in Activity');
  assert.ok(s.forgottenTasks[S3], 'tombstone remains');
});

test('normal NEW events still create and update tasks afterwards — including the same session doing new work', () => {
  let s = seeded();
  s = forget(s, S3);
  const later = new Date(Date.now() + 60_000).toISOString();

  // A brand-new session in a new workspace.
  s = ingest(s, event({ projectId: 'p-new000000000', projectName: 'WorkspaceGamma' }, 's-new0000000000001', 'started', later));
  assert.ok(s.tasks.some((t) => t.id === 's-new0000000000001'));
  assert.deepEqual(groupNames(s), ['WorkspaceAlpha', 'WorkspaceGamma']);

  // The forgotten session genuinely continues: newer than the tombstone.
  s = ingest(s, event(BETA, S3, 'completed', later));
  const s3 = s.tasks.find((t) => t.id === S3);
  assert.ok(s3, 'task comes back because the agent did new work');
  assert.equal(s3.status, 'completed');
  assert.equal(s.forgottenTasks[S3], undefined, 'tombstone cleared');
  assert.deepEqual(groupNames(s), ['WorkspaceAlpha', 'WorkspaceBeta', 'WorkspaceGamma']);

  // Existing tasks still update in place.
  s = ingest(s, event(ALPHA, S2, 'completed', later));
  assert.equal(s.tasks.find((t) => t.id === S2).status, 'completed');
  assert.equal(s.tasks.length, 4);
});

test('forgetting an unknown id is a no-op and leaves no tombstone', () => {
  const s = seeded();
  const after = forget(s, 's-does-not-exist');
  assert.equal(after, s);
});

test('a late draft save for a forgotten task does not create an orphan meta entry', () => {
  let s = seeded();
  s = forget(s, S1);
  s = agentReducer(s, { type: 'setTaskMeta', taskId: S1, patch: { promptDraft: 'late autosave' } });
  assert.equal(s.taskMeta[S1], undefined);
});

test('eventId dedupe is unaffected: replaying all seed events changes nothing', () => {
  let s = seeded();
  const before = JSON.stringify(s);
  seq = 0; // same eventIds again
  const t = (m) => new Date(Date.UTC(2026, 8, 20, 10, m)).toISOString();
  s = ingest(s, event(ALPHA, S1, 'started', t(0)));
  s = ingest(s, event(ALPHA, S1, 'completed', t(1)));
  s = ingest(s, event(ALPHA, S2, 'started', t(2)));
  s = ingest(s, event(BETA, S3, 'started', t(3)));
  s = ingest(s, event(BETA, S3, 'needs_input', t(4)));
  assert.equal(JSON.stringify(s), before);
});
