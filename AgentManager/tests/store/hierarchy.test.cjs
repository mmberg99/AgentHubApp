/**
 * Project -> Task -> Subtask hierarchy and "Task N" numbering.
 *
 *   npm run test:store
 *
 * Scenario (as specified):
 *   AgentHub        session A, subagents A1 + A2   -> Task 1
 *                   session B, subagent  B1        -> Task 2
 *   RobotFramework  session C, subagent  C1        -> Task 1
 *
 * The wire identity is what the notifier would send: projectId/projectName
 * from the MAIN session's cwd, taskId from the main session id, subtaskId from
 * (session id | agent id). Nothing raw ever appears here, so the assertions
 * that no raw value is stored hold trivially — the store never sees one.
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
const { visualStateFor, defaultTaskTitle } = require(path.join(BUILD, 'store', 'taskIdentity.js'));
const { parseAgentNotificationEvent } = require(path.join(BUILD, 'protocol', 'index.js'));
const { loadTaskStorage, saveTaskStorage, TASK_STORAGE_KEY } = require(
  path.join(BUILD, 'services', 'persistence', 'index.js'),
);

const AGENTHUB = { projectId: 'p-1111aaaa2222', projectName: 'AgentHub' };
const ROBOT = { projectId: 'p-3333bbbb4444', projectName: 'RobotFramework' };
const A = 's-aaaaaaaaaaaaaaaa';
const B = 's-bbbbbbbbbbbbbbbb';
const C = 's-cccccccccccccccc';
const A1 = 't-a1a1a1a1a1a1a1a1';
const A2 = 't-a2a2a2a2a2a2a2a2';
const B1 = 't-b1b1b1b1b1b1b1b1';
const C1 = 't-c1c1c1c1c1c1c1c1';

const EMPTY = {
  agents: [],
  events: [],
  approvals: [],
  tasks: [],
  taskMeta: {},
  forgottenTasks: {},
  subtasks: [],
  projectCounters: {},
  conversations: {},
};

let seq = 0;
const at = (m) => new Date(Date.UTC(2026, 8, 21, 10, 0, m)).toISOString();
function event(type, second, taskId, project, extra = {}) {
  seq += 1;
  return {
    version: 1,
    eventId: `evt-${String(seq).padStart(4, '0')}${'c'.repeat(28)}`,
    agentId: 'win_claude_code',
    agentName: 'Claude Code',
    type,
    title: extra.subtaskId ? 'Subtask update' : 'Task update',
    message: extra.subtaskId ? `Subtask ${type}.` : `Claude Code ${type}.`,
    timestamp: at(second),
    provider: 'claude',
    taskId,
    ...project,
    ...extra,
  };
}
const main = (type, s, taskId, project = AGENTHUB) => event(type, s, taskId, project);
const sub = (type, s, taskId, subtaskId, project = AGENTHUB, agentType = 'Explore') =>
  event(type, s, taskId, project, { subtaskId, agentType });

function ingest(state, raw) {
  const r = parseAgentNotificationEvent(raw);
  assert.equal(r.ok, true, (r.errors || []).join('; '));
  return agentReducer(state, { type: 'ingestRemoteEvent', event: r.event, source: 'push' });
}
const task = (s, id) => s.tasks.find((t) => t.id === id);
const subtask = (s, id) => s.subtasks.find((x) => x.id === id);

/** The full scenario, in wall-clock order, with subagents interleaved. */
function scenario() {
  let s = EMPTY;
  s = ingest(s, main('idle', 0, A)); // A: SessionStart
  s = ingest(s, main('running', 1, A)); // A: prompt
  s = ingest(s, sub('running', 2, A, A1)); // A1 start
  s = ingest(s, sub('running', 3, A, A2)); // A2 start
  s = ingest(s, sub('completed', 4, A, A1)); // A1 stop
  s = ingest(s, main('idle', 5, B)); // B: SessionStart (same workspace)
  s = ingest(s, main('running', 6, B));
  s = ingest(s, sub('running', 7, B, B1));
  s = ingest(s, main('idle', 8, C, ROBOT)); // C: other workspace
  s = ingest(s, main('running', 9, C, ROBOT));
  s = ingest(s, sub('running', 10, C, C1, ROBOT, 'security-reviewer'));
  s = ingest(s, sub('completed', 11, A, A2)); // A2 stop
  s = ingest(s, sub('completed', 12, B, B1));
  s = ingest(s, sub('completed', 13, C, C1, ROBOT));
  return s;
}

test.beforeEach(() => {
  mem.clear();
  seq = 0;
});

/* ------------------------------------------------------------ hierarchy */

test('1-3. exactly two projects, three top-level tasks, four subtasks', () => {
  const s = scenario();
  const groups = sel.groupTasksByProject(sel.activeTasks(s.tasks));
  assert.deepEqual(
    groups.map((g) => g.project.name).sort(),
    ['AgentHub', 'RobotFramework'],
  );
  assert.equal(s.tasks.length, 3, 'subagents never become tasks');
  assert.equal(s.subtasks.length, 4);
  const agentHub = groups.find((g) => g.project.name === 'AgentHub');
  const robot = groups.find((g) => g.project.name === 'RobotFramework');
  assert.equal(agentHub.tasks.length, 2);
  assert.equal(robot.tasks.length, 1);
});

test('4-6. subtasks hang under their parent, numbered within it', () => {
  const s = scenario();
  assert.deepEqual(sel.subtasksFor(s.subtasks, A).map((x) => x.id), [A1, A2]);
  assert.deepEqual(sel.subtasksFor(s.subtasks, A).map((x) => x.ordinal), [1, 2]);
  assert.deepEqual(sel.subtasksFor(s.subtasks, B).map((x) => x.id), [B1]);
  assert.deepEqual(sel.subtasksFor(s.subtasks, C).map((x) => x.id), [C1]);
  assert.equal(subtask(s, C1).agentType, 'security-reviewer');
  assert.equal(subtask(s, A1).agentType, 'Explore');
});

test('7. subtasks have NO project of their own; the parent project is the main session one', () => {
  const s = scenario();
  for (const id of [A1, A2, B1, C1]) assert.equal('projectId' in subtask(s, id), false);
  const projectOf = (st, subId) => task(st, subtask(st, subId).taskId).projectName;
  assert.equal(projectOf(s, A1), 'AgentHub');
  assert.equal(projectOf(s, C1), 'RobotFramework');
  // Parent exists, child event names a different workspace (a subagent that
  // cd'd elsewhere; the sender strips this, but the store must not trust it
  // either): the parent remains in its original project, no task is created.
  const t = ingest(scenario(), sub('running', 20, A, 't-elsewhere00000000', ROBOT));
  assert.equal(task(t, A).projectId, AGENTHUB.projectId, 'the parent did not move');
  assert.equal(task(t, A).projectName, 'AgentHub');
  assert.equal(t.tasks.length, 3, 'no new task');
  assert.equal(subtask(t, 't-elsewhere00000000').taskId, A);
  const names = new Set(t.tasks.map((x) => x.projectName));
  assert.deepEqual([...names].sort(), ['AgentHub', 'RobotFramework']);
});

test('8. "Task N" numbering is per project, in first-seen order', () => {
  const s = scenario();
  assert.equal(task(s, A).ordinal, 1);
  assert.equal(task(s, B).ordinal, 2);
  assert.equal(task(s, C).ordinal, 1);
  assert.equal(task(s, A).title, 'Task 1');
  assert.equal(task(s, B).title, 'Task 2');
  assert.equal(task(s, C).title, 'Task 1');
  assert.equal(defaultTaskTitle(7), 'Task 7');
  assert.deepEqual(s.projectCounters, { [AGENTHUB.projectId]: 2, [ROBOT.projectId]: 1 });
});

test('9. a subagent completing never completes the parent', () => {
  const s = scenario();
  // Every subagent has completed; every parent is still running.
  for (const id of [A1, A2, B1, C1]) assert.equal(subtask(s, id).status, 'completed');
  for (const id of [A, B, C]) {
    assert.equal(task(s, id).status, 'running', `${id} is still the main session's`);
    assert.equal(visualStateFor(task(s, id).status), 'running');
    assert.equal(task(s, id).acceptedAt, null);
  }
  // Only the main session's own Stop finishes it.
  const done = ingest(s, main('completed', 30, A));
  assert.equal(task(done, A).status, 'completed');
  assert.equal(task(done, B).status, 'running');
});

test('9b. a subagent event never advances the parent stale clock', () => {
  const s = scenario();
  assert.equal(task(s, A).lastRemoteEventAt, at(1), 'parent clock is the main session prompt');
  assert.equal(task(s, A).updatedAt, at(11), 'but activity ordering reflects the child');
});

test('10. a subagent needing action marks the parent Needs action', () => {
  let s = scenario();
  s = ingest(s, sub('needs_approval', 20, B, B1));
  assert.equal(subtask(s, B1).status, 'needs_approval');
  assert.equal(task(s, B).status, 'needs_approval');
  assert.equal(visualStateFor(task(s, B).status), 'action');
  assert.equal(sel.needsActionCount(s.tasks), 1, 'counted once, on the parent');
  // The other parents are untouched.
  assert.equal(task(s, A).status, 'running');
  assert.equal(task(s, C).status, 'running');
});

test('10b. the escalation clears when the child moves on, unless a sibling still needs the user', () => {
  let s = scenario();
  s = ingest(s, sub('needs_input', 20, A, A1));
  s = ingest(s, sub('needs_approval', 21, A, A2));
  assert.equal(task(s, A).status, 'needs_approval');
  assert.equal(task(s, A).escalatedBy, A2);
  s = ingest(s, sub('running', 22, A, A2)); // A2 got its approval
  assert.equal(task(s, A).status, 'needs_input', 'A1 still waits: parent stays red, with its reason');
  assert.equal(task(s, A).escalatedBy, A1);
  s = ingest(s, sub('running', 23, A, A1));
  assert.equal(task(s, A).status, 'running', 'no child needs the user any more');
  assert.equal(task(s, A).escalatedBy, null);
});

test('10e. a child never overrides a red the main session raised itself', () => {
  let s = scenario();
  s = ingest(s, main('needs_approval', 20, A));
  s = ingest(s, sub('needs_input', 21, A, A2));
  assert.equal(task(s, A).status, 'needs_approval', 'the main session\'s own reason stays');
  assert.equal(task(s, A).escalatedBy, null);
  s = ingest(s, sub('running', 22, A, A2));
  assert.equal(task(s, A).status, 'needs_approval', 'and is not cleared by the child moving on');
  s = ingest(s, main('running', 23, A));
  assert.equal(task(s, A).status, 'running');
});

test('10f. the main session\'s own next event supersedes an escalation', () => {
  let s = scenario();
  s = ingest(s, sub('needs_approval', 20, A, A1));
  assert.equal(task(s, A).escalatedBy, A1);
  s = ingest(s, main('completed', 21, A));
  assert.equal(task(s, A).status, 'completed');
  assert.equal(task(s, A).escalatedBy, null);
});

test('10c. a subagent cannot drag a parent back that has since moved on', () => {
  let s = scenario();
  s = ingest(s, main('completed', 30, A));
  // Late child event, older than the parent's own completion.
  s = ingest(s, sub('needs_approval', 25, A, A2));
  assert.equal(task(s, A).status, 'completed');
  assert.equal(subtask(s, A2).status, 'needs_approval', 'the child record itself is updated');
});

test('10d. the parent\'s own red is not cleared by a child', () => {
  let s = scenario();
  s = ingest(s, main('needs_approval', 20, A));
  s = ingest(s, sub('completed', 21, A, A2));
  assert.equal(task(s, A).status, 'needs_approval');
});

test('11. Home counts top-level tasks only', () => {
  const s = scenario();
  assert.equal(sel.runningTaskCount(s.tasks), 3, 'A, B, C — not the four subagents');
  assert.equal(sel.activeProjectCount(s.tasks), 2);
  assert.equal(sel.needsActionCount(s.tasks), 0);
  const groups = sel.groupTasksByProject(sel.activeTasks(s.tasks));
  assert.equal(groups.reduce((n, g) => n + g.tasks.length, 0), 3);
  assert.equal(groups.reduce((n, g) => n + g.running, 0), 3);
});

/* --------------------------------------------- child before parent */

const OTHER = { projectId: 'p-9999other0000', projectName: 'SomeOtherWorkspace' };
const NO_PROJECT = { projectId: undefined, projectName: undefined };
const noProjects = (s) => sel.groupTasksByProject(sel.activeTasks(s.tasks)).map((g) => g.project.name);

test('12. REGRESSION: a child arriving before its parent never creates a project or task', () => {
  // Main session A launched in .../AgentHub. Before any main event for A, a
  // subagent of A fires from .../SomeOtherWorkspace. Two sender variants:
  // the real notifier (no project on a child) and a misbehaving one (project
  // of the child's cwd). Neither may surface anything.
  for (const variant of [NO_PROJECT, OTHER]) {
    let s = ingest(EMPTY, sub('running', 0, A, A1, variant));
    assert.equal(s.tasks.length, 0, 'no top-level task from a child');
    assert.deepEqual(noProjects(s), [], 'no project from a child');
    assert.deepEqual(s.projectCounters, {}, 'no ordinal consumed');
    assert.equal(sel.runningTaskCount(s.tasks), 0);
    assert.equal(sel.activeProjectCount(s.tasks), 0);
    assert.equal(subtask(s, A1).taskId, A, 'held, associated with the unresolved parent');
    assert.equal(JSON.stringify(s.tasks).includes('SomeOtherWorkspace'), false);

    // Then the main session speaks, from AgentHub.
    s = ingest(s, main('running', 1, A));
    assert.equal(s.tasks.length, 1, 'exactly one top-level task');
    assert.deepEqual(noProjects(s), ['AgentHub'], 'exactly one project: AgentHub');
    assert.equal(task(s, A).projectId, AGENTHUB.projectId);
    assert.equal(task(s, A).title, 'Task 1');
    assert.deepEqual(sel.subtasksFor(s.subtasks, A).map((x) => x.ordinal), [1], 'Subagent 1 underneath');
    assert.equal(JSON.stringify(s).includes('SomeOtherWorkspace'), false, 'zero trace of the child cwd');
  }
});

test('12b. several children before the parent: none creates a project, all attach when it appears', () => {
  let s = EMPTY;
  s = ingest(s, sub('running', 0, A, A1, OTHER));
  s = ingest(s, sub('running', 1, A, A2, NO_PROJECT));
  s = ingest(s, sub('completed', 2, A, A1, OTHER));
  s = ingest(s, sub('running', 3, B, B1, OTHER)); // another unresolved parent
  assert.equal(s.tasks.length, 0);
  assert.deepEqual(noProjects(s), []);
  assert.equal(s.subtasks.length, 3);
  s = ingest(s, main('idle', 4, A));
  assert.equal(s.tasks.length, 1);
  assert.deepEqual(sel.subtasksFor(s.subtasks, A).map((x) => [x.ordinal, x.status]), [[1, 'completed'], [2, 'running']]);
  assert.equal(task(s, A).status, 'idle', 'the main event sets the parent status');
  assert.equal(sel.subtasksFor(s.subtasks, B).length, 1, 'B1 still held for B');
  assert.deepEqual(noProjects(s), ['AgentHub']);
  s = ingest(s, main('running', 5, B));
  assert.equal(task(s, B).title, 'Task 2');
  assert.deepEqual(sel.subtasksFor(s.subtasks, B).map((x) => x.id), [B1]);
});

test('12c. a held child that needs the user escalates the parent when it appears', () => {
  let s = ingest(EMPTY, sub('needs_approval', 5, A, A1, OTHER));
  assert.equal(s.tasks.length, 0);
  assert.equal(sel.needsActionCount(s.tasks), 0, 'nothing to count yet');
  // Main event older than the child's request (delivery order != clock order).
  s = ingest(s, main('running', 1, A));
  assert.equal(task(s, A).status, 'needs_approval');
  assert.equal(task(s, A).escalatedBy, A1);
  assert.equal(sel.needsActionCount(s.tasks), 1);
  // Main event newer than the child's request: the main session has moved on.
  let t = ingest(EMPTY, sub('needs_approval', 1, A, A1));
  t = ingest(t, main('running', 5, A));
  assert.equal(task(t, A).status, 'running');
});

test('12d. child cwd changing between events is irrelevant to project identity', () => {
  let s = EMPTY;
  s = ingest(s, sub('running', 0, A, A1, OTHER));
  s = ingest(s, sub('running', 1, A, A1, ROBOT));
  s = ingest(s, sub('running', 2, A, A1, NO_PROJECT));
  s = ingest(s, main('running', 3, A));
  s = ingest(s, sub('completed', 4, A, A1, OTHER));
  assert.equal(s.tasks.length, 1);
  assert.equal(task(s, A).projectName, 'AgentHub');
  assert.equal(s.subtasks.length, 1);
  assert.deepEqual(noProjects(s), ['AgentHub']);
});

test('12e. parent projectId/projectName can never be overwritten by child events', () => {
  let s = scenario();
  const before = { id: task(s, A).projectId, name: task(s, A).projectName };
  for (const [i, p] of [OTHER, ROBOT, NO_PROJECT, OTHER].entries()) {
    s = ingest(s, sub(i % 2 ? 'needs_input' : 'running', 20 + i, A, A1, p));
    s = ingest(s, sub('completed', 30 + i, A, `t-new${i}000000000000`, p));
  }
  assert.equal(task(s, A).projectId, before.id);
  assert.equal(task(s, A).projectName, before.name);
  assert.equal(s.tasks.length, 3);
  assert.equal(JSON.stringify(s.tasks).includes('SomeOtherWorkspace'), false);
});

test('12f. reload/persistence never turns unresolved children into top-level tasks', () => {
  let s = ingest(EMPTY, sub('running', 0, A, A1, OTHER));
  s = ingest(s, sub('running', 1, A, A2, OTHER));
  saveTaskStorage(s.tasks, s.taskMeta, s.forgottenTasks, s.subtasks, s.projectCounters);
  const loaded = loadTaskStorage();
  assert.equal(loaded.tasks.length, 0, 'no task appeared through persistence');
  assert.deepEqual(loaded.projectCounters, {});
  assert.equal(loaded.subtasks.length, 2, 'held children survive the reload');
  assert.equal(JSON.stringify(loaded).includes('SomeOtherWorkspace'), false);
  // After the reload the parent arrives and the held children attach.
  const resumed = { ...EMPTY, tasks: loaded.tasks, subtasks: loaded.subtasks, projectCounters: loaded.projectCounters };
  const n = ingest(resumed, main('running', 10, A));
  assert.equal(n.tasks.length, 1);
  assert.deepEqual(noProjects(n), ['AgentHub']);
  assert.deepEqual(sel.subtasksFor(n.subtasks, A).map((x) => x.id), [A1, A2]);
});

test('12g. a held child whose parent never arrives ages out of storage', () => {
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const fresh = new Date().toISOString();
  const mk = (id, when) => ({ id, taskId: 's-never0000000000', ordinal: 1, status: 'running', createdAt: when, updatedAt: when, lastRemoteEventAt: when, origin: 'remote' });
  saveTaskStorage([], {}, {}, [mk('t-stale00000000000', old), mk('t-fresh00000000000', fresh)], {});
  const loaded = loadTaskStorage();
  assert.deepEqual(loaded.subtasks.map((x) => x.id), ['t-fresh00000000000']);
  assert.equal(loaded.tasks.length, 0);
});

test('13. repeated events from one subagent update one record', () => {
  let s = EMPTY;
  for (let i = 0; i < 5; i += 1) s = ingest(s, sub('running', i, A, A1));
  s = ingest(s, sub('completed', 9, A, A1));
  assert.equal(s.subtasks.length, 1);
  assert.equal(subtask(s, A1).status, 'completed');
  // A late child event is ignored by the child's own stale rule.
  s = ingest(s, sub('running', 7, A, A1));
  assert.equal(subtask(s, A1).status, 'completed');
});

test('14. the parent stays where it was created even if later main events name another project', () => {
  let s = ingest(EMPTY, main('idle', 0, A));
  s = ingest(s, main('running', 1, A, ROBOT)); // e.g. after a cd; the sender should not, but
  assert.equal(task(s, A).projectId, AGENTHUB.projectId);
  assert.equal(task(s, A).projectName, 'AgentHub');
  assert.equal(s.tasks.length, 1);
});

test('subtask events are visible on the parent timeline and labelled as child activity', () => {
  const s = scenario();
  const timeline = sel.eventsForTask(s.events, A);
  assert.equal(timeline.length, 6, 'A idle, A running, A1 x2, A2 x2');
  assert.equal(timeline.filter((e) => e.subtaskId).length, 4);
  assert.equal(timeline.filter((e) => e.subtaskId === A1).length, 2);
});

test('the wire refuses a subtaskId without a taskId', () => {
  const raw = sub('running', 0, undefined, A1);
  delete raw.taskId;
  const r = parseAgentNotificationEvent(raw);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('subtaskId')));
});

test('a subagent event carries no raw identity into state', () => {
  const s = scenario();
  const blob = JSON.stringify(s);
  for (const needle of ['agent_id', 'session_id', 'cwd', 'transcript', 'C:\\\\', '/Users/']) {
    assert.equal(blob.includes(needle), false, needle);
  }
});

/* -------------------------------------------------------------- numbering */

test('numbering: Task 1, 2, 3; accept 2 and forget 2; the next task is Task 4', () => {
  const T1 = 's-1111111111111111';
  const T2 = 's-2222222222222222';
  const T3 = 's-3333333333333333';
  const T4 = 's-4444444444444444';
  let s = EMPTY;
  s = ingest(s, main('running', 0, T1));
  s = ingest(s, main('running', 1, T2));
  s = ingest(s, main('running', 2, T3));
  assert.deepEqual([T1, T2, T3].map((id) => task(s, id).title), ['Task 1', 'Task 2', 'Task 3']);

  s = ingest(s, main('completed', 3, T2));
  s = agentReducer(s, { type: 'acceptTask', taskId: T2 });
  assert.equal(task(s, T1).title, 'Task 1');
  assert.equal(task(s, T3).title, 'Task 3', 'no renumbering on accept');

  s = agentReducer(s, { type: 'forgetTask', taskId: T2 });
  assert.equal(task(s, T2), undefined);
  assert.equal(task(s, T3).title, 'Task 3', 'no renumbering on forget');

  s = ingest(s, main('running', 60 * 60, T4)); // well after the tombstone
  assert.equal(task(s, T4).ordinal, 4);
  assert.equal(task(s, T4).title, 'Task 4', 'the forgotten number is never reused');
});

test('numbering: subagents never consume a task number', () => {
  let s = EMPTY;
  s = ingest(s, main('running', 0, A));
  s = ingest(s, sub('running', 1, A, A1));
  s = ingest(s, sub('running', 2, A, A2));
  s = ingest(s, main('running', 3, B));
  assert.equal(task(s, B).ordinal, 2);
  assert.equal(s.projectCounters[AGENTHUB.projectId], 2);
});

test('numbering and hierarchy survive a reload (persist -> load)', () => {
  const s = scenario();
  saveTaskStorage(s.tasks, s.taskMeta, s.forgottenTasks, s.subtasks, s.projectCounters);
  const loaded = loadTaskStorage();
  assert.equal(loaded.tasks.length, 3);
  assert.equal(loaded.subtasks.length, 4);
  assert.deepEqual(loaded.projectCounters, s.projectCounters);
  assert.equal(loaded.tasks.find((t) => t.id === B).ordinal, 2);
  assert.equal(loaded.tasks.find((t) => t.id === B).title, 'Task 2');
  assert.equal(loaded.subtasks.find((x) => x.id === A2).taskId, A);
  assert.equal(loaded.subtasks.find((x) => x.id === C1).agentType, 'security-reviewer');

  // Continue from the reloaded state: numbering picks up where it left off.
  const resumed = { ...EMPTY, tasks: loaded.tasks, subtasks: loaded.subtasks, projectCounters: loaded.projectCounters };
  const n = ingest(resumed, main('running', 100, 's-dddddddddddddddd'));
  assert.equal(task(n, 's-dddddddddddddddd').title, 'Task 3');
});

test('reload after forgetting keeps the counter (Task 4 after a forgotten Task 2)', () => {
  const T2 = 's-2222222222222222';
  let s = EMPTY;
  s = ingest(s, main('running', 0, 's-1111111111111111'));
  s = ingest(s, main('running', 1, T2));
  s = ingest(s, main('running', 2, 's-3333333333333333'));
  s = agentReducer(s, { type: 'forgetTask', taskId: T2 });
  saveTaskStorage(s.tasks, s.taskMeta, s.forgottenTasks, s.subtasks, s.projectCounters);
  const loaded = loadTaskStorage();
  assert.equal(loaded.tasks.length, 2);
  assert.equal(loaded.projectCounters[AGENTHUB.projectId], 3);
  const resumed = { ...EMPTY, ...loaded, taskMeta: loaded.meta, forgottenTasks: loaded.forgotten };
  const n = ingest(resumed, main('running', 3600, 's-4444444444444444'));
  assert.equal(task(n, 's-4444444444444444').title, 'Task 4');
});

test('migration: tasks saved before numbering get ordinals by creation order and "Task N" titles', () => {
  const legacy = {
    version: 1,
    savedAt: at(0),
    tasks: [
      {
        id: 's-oldb', projectId: AGENTHUB.projectId, projectName: 'AgentHub', agentId: 'win_claude_code',
        agentName: 'Claude Code', provider: 'anthropic', status: 'completed', title: 'Session 14:32',
        createdAt: at(5), updatedAt: at(6), lastRemoteEventAt: at(6), acceptedAt: null, origin: 'remote',
      },
      {
        id: 's-olda', projectId: AGENTHUB.projectId, projectName: 'AgentHub', agentId: 'win_claude_code',
        agentName: 'Claude Code', provider: 'anthropic', status: 'completed', title: 'Session 09:00',
        createdAt: at(1), updatedAt: at(2), lastRemoteEventAt: at(2), acceptedAt: at(3), origin: 'remote',
      },
      {
        id: 's-oldc', projectId: ROBOT.projectId, projectName: 'RobotFramework', agentId: 'win_claude_code',
        agentName: 'Claude Code', provider: 'anthropic', status: 'running', title: 'Session 15:00',
        createdAt: at(7), updatedAt: at(7), lastRemoteEventAt: at(7), acceptedAt: null, origin: 'remote',
      },
    ],
    meta: { 's-oldb': { customTitle: 'My rename' } },
    forgotten: {},
  };
  mem.set(TASK_STORAGE_KEY, JSON.stringify(legacy));
  const loaded = loadTaskStorage();
  const byId = Object.fromEntries(loaded.tasks.map((t) => [t.id, t]));
  assert.equal(byId['s-olda'].ordinal, 1);
  assert.equal(byId['s-oldb'].ordinal, 2);
  assert.equal(byId['s-oldc'].ordinal, 1);
  assert.equal(byId['s-olda'].title, 'Task 1');
  assert.equal(byId['s-oldb'].title, 'Task 2');
  assert.equal(loaded.meta['s-oldb'].customTitle, 'My rename', 'user renames are untouched');
  assert.deepEqual(loaded.projectCounters, { [AGENTHUB.projectId]: 2, [ROBOT.projectId]: 1 });
  assert.equal(byId['s-olda'].acceptedAt, at(3), 'accepted state preserved');
});

/* ------------------------------------------------------------ forget */

test('forgetting a parent removes its subtasks and nothing else', () => {
  let s = scenario();
  s = agentReducer(s, { type: 'forgetTask', taskId: A });
  assert.equal(task(s, A), undefined);
  assert.equal(sel.subtasksFor(s.subtasks, A).length, 0);
  assert.equal(s.subtasks.length, 2, 'B1 and C1 remain');
  assert.equal(s.tasks.length, 2);
  // A replayed child event of the forgotten parent does not resurrect it.
  s = ingest(s, sub('completed', 4, A, A1));
  assert.equal(task(s, A), undefined);
  assert.equal(subtask(s, A1), undefined);
});
