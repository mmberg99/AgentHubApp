/**
 * Claude status lifecycle in the store: running -> idle -> running -> completed.
 *
 *   npm run test:store
 *
 * Push decisions are the relay's (see AgentHubRelay/test); this file proves the
 * app-side state model: Idle is a real, gray, non-running, non-finished state
 * that keeps its project active and never offers Accept, and the same task
 * moves through every transition without ever being duplicated.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

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
const { visualStateFor, statusLabel } = require(path.join(BUILD, 'store', 'taskIdentity.js'));
const { parseAgentNotificationEvent, mapStatus } = require(path.join(BUILD, 'protocol', 'index.js'));

const PROJECT = { projectId: 'p-0d05a834d1d7', projectName: 'WorkspaceAlpha' };
const TASK = 's-cf7bbee31fb8bcd4';
const EMPTY = { agents: [], events: [], approvals: [], tasks: [], taskMeta: {}, forgottenTasks: {}, subtasks: [], projectCounters: {}, conversations: {} };

let seq = 0;
const at = (m) => new Date(Date.UTC(2026, 8, 21, 9, m)).toISOString();
function event(type, minute, overrides = {}) {
  seq += 1;
  return {
    version: 1,
    eventId: `evt-${String(seq).padStart(4, '0')}${'b'.repeat(28)}`,
    agentId: 'win_claude_code',
    agentName: 'Claude Code',
    type,
    title: 'Task update',
    message: `Claude Code ${type}.`,
    timestamp: at(minute),
    provider: 'claude',
    taskId: TASK,
    ...PROJECT,
    ...overrides,
  };
}
function ingest(state, raw) {
  const r = parseAgentNotificationEvent(raw);
  assert.equal(r.ok, true, (r.errors || []).join('; '));
  return agentReducer(state, { type: 'ingestRemoteEvent', event: r.event, source: 'push' });
}
const task = (s) => s.tasks.find((t) => t.id === TASK);
/** Accept is offered exactly when the task is Finished and not yet accepted. */
const offersAccept = (t) => t && t.acceptedAt === null && visualStateFor(t.status) === 'finished';

test.beforeEach(() => {
  mem.clear();
  seq = 0;
});

test('the wire accepts idle and maps it to a distinct status', () => {
  assert.equal(parseAgentNotificationEvent(event('idle', 0)).ok, true);
  assert.equal(mapStatus('idle'), 'idle');
  assert.equal(visualStateFor('idle'), 'idle');
  assert.equal(statusLabel('idle'), 'Idle');
});

test('SessionStart (idle) -> one task, Idle, Running agents 0 — opening Claude is not working', () => {
  const s = ingest(EMPTY, event('idle', 0));
  assert.equal(s.tasks.length, 1, 'the task exists immediately');
  assert.equal(task(s).status, 'idle');
  assert.equal(visualStateFor(task(s).status), 'idle');
  assert.equal(statusLabel(task(s).status), 'Idle');
  assert.equal(sel.runningTaskCount(s.tasks), 0, 'never Running just for being open');
  assert.equal(sel.activeProjectCount(s.tasks), 1);
  assert.equal(sel.needsActionCount(s.tasks), 0);
  assert.equal(offersAccept(task(s)), false);
});

test('an open session with no prompt stays Idle no matter how long, and repeated opens do not add tasks', () => {
  let s = ingest(EMPTY, event('idle', 0));
  s = ingest(s, event('idle', 30)); // e.g. a replayed/duplicate-shaped open
  assert.equal(s.tasks.length, 1);
  assert.equal(task(s).status, 'idle');
  assert.equal(sel.runningTaskCount(s.tasks), 0);
});

test('SessionStart then UserPromptSubmit: the SAME task goes Idle -> Running', () => {
  let s = ingest(EMPTY, event('idle', 0));
  s = ingest(s, event('running', 1));
  assert.equal(s.tasks.length, 1, 'no second task');
  assert.equal(task(s).status, 'running');
  assert.equal(sel.runningTaskCount(s.tasks), 1);
});

test('the exact user experience: open -> prompt -> stop(bg) -> prompt -> done, one task, Accept only at the end', () => {
  let s = EMPTY;
  const expect = (state, status, visual, running, accept) => {
    assert.equal(state.tasks.length, 1, 'never a second task');
    assert.equal(task(state).status, status);
    assert.equal(visualStateFor(task(state).status), visual);
    assert.equal(sel.runningTaskCount(state.tasks), running);
    assert.equal(offersAccept(task(state)), accept);
  };
  s = ingest(s, event('idle', 0));      expect(s, 'idle', 'idle', 0, false);        // SessionStart
  s = ingest(s, event('running', 1));   expect(s, 'running', 'running', 1, false);  // UserPromptSubmit
  s = ingest(s, event('idle', 2));      expect(s, 'idle', 'idle', 0, false);        // Stop + background work
  s = ingest(s, event('running', 3));   expect(s, 'running', 'running', 1, false);  // UserPromptSubmit
  s = ingest(s, event('completed', 4)); expect(s, 'completed', 'finished', 0, true); // Stop, nothing outstanding
  assert.equal(s.events.length, 5);
});

test('UserPromptSubmit (running) -> RUNNING', () => {
  const s = ingest(EMPTY, event('running', 0));
  assert.equal(task(s).status, 'running');
  assert.equal(visualStateFor(task(s).status), 'running');
  assert.equal(sel.runningTaskCount(s.tasks), 1);
  assert.equal(offersAccept(task(s)), false);
});

test('Stop with background work (idle) -> IDLE: visible, active, not running, not finished, no Accept', () => {
  let s = ingest(EMPTY, event('running', 0));
  s = ingest(s, event('idle', 1));
  const t = task(s);
  assert.equal(t.status, 'idle');
  assert.equal(visualStateFor(t.status), 'idle');
  assert.equal(statusLabel(t.status), 'Idle');
  assert.equal(offersAccept(t), false, 'Idle must not offer Accept');
  assert.equal(sel.runningTaskCount(s.tasks), 0, 'Idle is not Running');
  assert.equal(sel.needsActionCount(s.tasks), 0, 'Idle is not Needs action');
  assert.equal(sel.activeProjectCount(s.tasks), 1, 'Idle keeps its project active');
  const group = sel.groupTasksByProject(sel.activeTasks(s.tasks))[0];
  assert.equal(group.project.name, 'WorkspaceAlpha');
  assert.deepEqual({ running: group.running, idle: group.idle, finished: group.finished, action: group.action }, { running: 0, idle: 1, finished: 0, action: 0 });
  assert.equal(s.tasks.length, 1, 'same task, not a new one');
});

test('a later UserPromptSubmit makes the SAME task running again', () => {
  let s = ingest(EMPTY, event('running', 0));
  s = ingest(s, event('idle', 1));
  s = ingest(s, event('running', 2));
  assert.equal(s.tasks.length, 1);
  assert.equal(task(s).status, 'running');
  assert.equal(sel.runningTaskCount(s.tasks), 1);
});

test('Stop with nothing outstanding (completed) -> FINISHED, eligible for Accept', () => {
  let s = ingest(EMPTY, event('running', 0));
  s = ingest(s, event('completed', 1));
  const t = task(s);
  assert.equal(t.status, 'completed');
  assert.equal(visualStateFor(t.status), 'finished');
  assert.equal(offersAccept(t), true);
  assert.equal(sel.runningTaskCount(s.tasks), 0, 'Finished is not Running');
  assert.equal(sel.activeProjectCount(s.tasks), 1, 'unaccepted Finished keeps its project active');
});

test('Running agents excludes Idle and Completed; Active projects includes Idle, Running and unaccepted Completed', () => {
  let s = EMPTY;
  s = ingest(s, event('running', 0, { taskId: 's-a', projectId: 'p-a', projectName: 'A' }));
  s = ingest(s, event('idle', 1, { taskId: 's-b', projectId: 'p-b', projectName: 'B' }));
  s = ingest(s, event('completed', 2, { taskId: 's-c', projectId: 'p-c', projectName: 'C' }));
  s = ingest(s, event('completed', 3, { taskId: 's-d', projectId: 'p-d', projectName: 'D' }));
  s = agentReducer(s, { type: 'acceptTask', taskId: 's-d' });
  assert.equal(sel.runningTaskCount(s.tasks), 1, 'only the running one');
  assert.equal(sel.activeProjectCount(s.tasks), 3, 'A (running) + B (idle) + C (unaccepted completed); D accepted is excluded');
  assert.equal(sel.needsActionCount(s.tasks), 0);
});

test('the full sequence: running -> idle -> running -> completed, one task throughout, Accept only at the end', () => {
  let s = EMPTY;
  const expect = (state, status, visual, accept) => {
    const t = task(state);
    assert.equal(t.status, status);
    assert.equal(visualStateFor(t.status), visual);
    assert.equal(offersAccept(t), accept);
    assert.equal(state.tasks.length, 1, 'never a second task');
  };
  s = ingest(s, event('running', 0));   expect(s, 'running', 'running', false);
  s = ingest(s, event('idle', 1));      expect(s, 'idle', 'idle', false);
  s = ingest(s, event('running', 2));   expect(s, 'running', 'running', false);
  s = ingest(s, event('running', 3));   expect(s, 'running', 'running', false);
  s = ingest(s, event('completed', 4)); expect(s, 'completed', 'finished', true);
  // ...and a later turn in the same session, after the user accepted it.
  s = agentReducer(s, { type: 'acceptTask', taskId: TASK });
  assert.equal(offersAccept(task(s)), false, 'accepted');
  // acceptedAt is wall-clock; re-activation needs events genuinely NEWER than it.
  const later = (ms) => new Date(Date.now() + ms).toISOString();
  s = ingest(s, { ...event('running', 0), timestamp: later(60_000) });  expect(s, 'running', 'running', false);
  assert.equal(task(s).acceptedAt, null, 'new work re-activates the accepted task');
  s = ingest(s, { ...event('completed', 0), timestamp: later(120_000) }); expect(s, 'completed', 'finished', true);
  assert.equal(s.events.length, 7);
});

test('a replayed / duplicate completed event changes nothing (eventId dedupe intact)', () => {
  let s = ingest(EMPTY, event('running', 0));
  const done = event('completed', 1);
  s = ingest(s, done);
  const before = JSON.stringify(s);
  s = ingest(s, done);
  s = ingest(s, done);
  assert.equal(JSON.stringify(s), before);
  assert.equal(s.events.length, 2);
});

test('a stale idle arriving after a newer completed does not regress the task', () => {
  let s = ingest(EMPTY, event('running', 0));
  s = ingest(s, event('completed', 5));
  s = ingest(s, event('idle', 2)); // older timestamp, delivered late
  assert.equal(task(s).status, 'completed', 'ordering rule holds for idle too');
  assert.equal(visualStateFor(task(s).status), 'finished');
});

test('needs_approval / needs_input / failed still resolve to Needs action', () => {
  for (const type of ['needs_approval', 'needs_input', 'failed']) {
    let s = ingest(EMPTY, event('running', 0));
    s = ingest(s, event(type, 1));
    assert.equal(visualStateFor(task(s).status), 'action', type);
    assert.equal(sel.needsActionCount(s.tasks), 1, type);
    assert.equal(offersAccept(task(s)), false, type);
  }
});

test('project/task identity is unchanged by the new states', () => {
  let s = EMPTY;
  for (const [type, m] of [['running', 0], ['idle', 1], ['running', 2], ['completed', 3]]) s = ingest(s, event(type, m));
  const t = task(s);
  assert.equal(t.projectId, PROJECT.projectId);
  assert.equal(t.projectName, PROJECT.projectName);
  assert.equal(t.id, TASK);
  assert.ok(!/[A-Za-z]:\\|\/Users\//.test(t.projectName + t.title), 'no path anywhere');
});
