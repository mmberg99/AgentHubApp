/**
 * Conversation-aware tasks: titles from the first prompt, the visible thread,
 * latest output, child output separation, replay idempotency, forget.
 *
 *   npm run test:store
 *
 * The store never receives raw hook payloads: it reads what the relay returns
 * from its authenticated routes (summaries and one task's conversation). These
 * tests feed those shapes through the same validators the client uses.
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
const { subtaskTitle } = require(path.join(BUILD, 'store', 'taskIdentity.js'));
const {
  parseAgentNotificationEvent,
  parseTaskConversation,
  parseConversationSummary,
  parseConversationMessage,
} = require(path.join(BUILD, 'protocol', 'index.js'));
const { loadTaskStorage, saveTaskStorage } = require(path.join(BUILD, 'services', 'persistence', 'index.js'));

const PROJECT = { projectId: 'p-1111aaaa2222', projectName: 'AgentHub' };
const A = 's-aaaaaaaaaaaaaaaa';
const B = 's-bbbbbbbbbbbbbbbb';
const A1 = 't-a1a1a1a1a1a1a1a1';
const EMPTY = { agents: [], events: [], approvals: [], tasks: [], taskMeta: {}, forgottenTasks: {}, subtasks: [], projectCounters: {}, conversations: {} };

let seq = 0;
const at = (s) => new Date(Date.UTC(2026, 8, 21, 10, 0, s)).toISOString();
function event(type, second, taskId, extra = {}) {
  seq += 1;
  return { version: 1, eventId: `evt-${String(seq).padStart(4, '0')}${'d'.repeat(28)}`, agentId: 'win_claude_code', agentName: 'Claude Code', type, title: 'x', message: `Claude Code ${type}.`, timestamp: at(second), provider: 'claude', taskId, ...PROJECT, ...extra };
}
function ingest(state, raw) {
  const r = parseAgentNotificationEvent(raw);
  assert.equal(r.ok, true, (r.errors || []).join('; '));
  return agentReducer(state, { type: 'ingestRemoteEvent', event: r.event, source: 'push' });
}
let mseq = 0;
function msg(taskId, role, text, second, extra = {}) {
  mseq += 1;
  return { messageId: `m-${String(mseq).padStart(4, '0')}${'e'.repeat(20)}`, taskId, role, text, timestamp: at(second), ...extra };
}
/** What GET /conversation/<id> returns for a task, built like the relay builds it. */
function conversation(taskId, messages, { title, children = {} } = {}) {
  const firstUser = messages.find((m) => m.role === 'user');
  return parseTaskConversation({
    version: 1,
    taskId,
    title: title ?? (firstUser ? firstUser.title ?? null : null),
    updatedAt: at(99),
    thread: { messages, trimmed: 0 },
    children,
  });
}
const summaryOf = (conv) =>
  parseConversationSummary({
    taskId: conv.taskId,
    title: conv.title,
    messageCount: conv.thread.messages.length,
    lastRole: null,
    updatedAt: conv.updatedAt,
    children: Object.fromEntries(Object.entries(conv.children).map(([id, t]) => [id, { title: t.title ?? null, messageCount: t.messages.length }])),
  });
const setConv = (state, conv) => agentReducer(state, { type: 'setConversation', conversation: conv });
const applySummaries = (state, list) => agentReducer(state, { type: 'applyConversationSummaries', summaries: list });
const task = (s, id) => s.tasks.find((t) => t.id === id);
// Mirrors components/TaskRow.taskTitle (UI file, not part of the test build).
const displayTitle = (t, meta) => (meta && meta.customTitle && meta.customTitle.trim()) || t.autoTitle || t.title;

const PROMPT1 = 'Fix the push notification lifecycle so Claude is idle while background tests are still running';
const TITLE1 = 'Fix push notification lifecycle';
const ANSWER1 = 'Implemented the corrected lifecycle.\n\n```ts\nconst x = 1;\n```\nAll 59 tests pass.';

test.beforeEach(() => {
  mem.clear();
  seq = 0;
  mseq = 0;
});

test('main first prompt renames Task 1; the second prompt does not rename it', () => {
  let s = ingest(EMPTY, event('idle', 0, A));
  assert.equal(task(s, A).title, 'Task 1');
  assert.equal(displayTitle(task(s, A)), 'Task 1', 'before a first prompt the ordinal name is fine');
  s = ingest(s, event('running', 1, A));
  s = setConv(s, conversation(A, [msg(A, 'user', PROMPT1, 1, { title: TITLE1 })]));
  assert.equal(task(s, A).autoTitle, TITLE1);
  assert.equal(displayTitle(task(s, A)), TITLE1);
  assert.equal(task(s, A).title, 'Task 1', 'the ordinal title is kept underneath');
  assert.equal(task(s, A).ordinal, 1);
  // Second prompt: the relay keeps the first title; even if a different title arrived, it is ignored.
  s = setConv(s, conversation(A, [msg(A, 'user', PROMPT1, 1, { title: TITLE1 }), msg(A, 'assistant', ANSWER1, 2), msg(A, 'user', 'Now fix duplicate subscriptions', 3, { title: 'Fix duplicate subscriptions' })], { title: 'Fix duplicate subscriptions' }));
  assert.equal(task(s, A).autoTitle, TITLE1, 'never renamed by later prompts');
});

test('manual custom title wins over the automatic title', () => {
  let s = ingest(EMPTY, event('running', 0, A));
  s = setConv(s, conversation(A, [msg(A, 'user', PROMPT1, 1, { title: TITLE1 })]));
  s = agentReducer(s, { type: 'setTaskMeta', taskId: A, patch: { customTitle: 'My own name' } });
  assert.equal(displayTitle(task(s, A), s.taskMeta[A]), 'My own name');
  assert.equal(task(s, A).autoTitle, TITLE1, 'the automatic title is kept, not overwritten');
});

test('two sessions get independent titles; summaries never create tasks', () => {
  let s = ingest(EMPTY, event('running', 0, A));
  s = ingest(s, event('running', 1, B));
  s = applySummaries(s, [
    summaryOf(conversation(A, [msg(A, 'user', PROMPT1, 0, { title: TITLE1 })])),
    summaryOf(conversation(B, [msg(B, 'user', 'Add conversation-aware tasks to AgentHub', 1, { title: 'Add conversation-aware tasks to AgentHub' })])),
    summaryOf(conversation('s-unknown000000000', [msg('s-unknown000000000', 'user', 'x', 2, { title: 'Ghost' })])),
  ]);
  assert.equal(task(s, A).autoTitle, TITLE1);
  assert.equal(task(s, B).autoTitle, 'Add conversation-aware tasks to AgentHub');
  assert.equal(task(s, B).title, 'Task 2');
  assert.equal(s.tasks.length, 2, 'a summary for an unknown task creates nothing');
});

test('prompt/response/prompt/response yields four messages in order; Stop response is an assistant message', () => {
  let s = ingest(EMPTY, event('running', 0, A));
  const conv = conversation(A, [
    msg(A, 'assistant', 'Second answer', 4),
    msg(A, 'user', PROMPT1, 1, { title: TITLE1 }),
    msg(A, 'user', 'Second prompt', 3),
    msg(A, 'assistant', ANSWER1, 2),
  ]);
  s = setConv(s, conv);
  const thread = sel.conversationFor(s.conversations, A);
  assert.deepEqual(thread.map((m) => [m.role, m.text.slice(0, 13)]), [
    ['user', 'Fix the push '],
    ['assistant', 'Implemented t'],
    ['user', 'Second prompt'],
    ['assistant', 'Second answer'],
  ]);
  assert.equal(thread[1].text, ANSWER1, 'code block and blank lines preserved');
});

test('completed task: Latest output equals the last assistant message (no second copy)', () => {
  let s = ingest(EMPTY, event('running', 0, A));
  s = setConv(s, conversation(A, [msg(A, 'user', PROMPT1, 1, { title: TITLE1 }), msg(A, 'assistant', ANSWER1, 2), msg(A, 'user', 'Second prompt', 3), msg(A, 'assistant', 'Second answer', 4)]));
  s = ingest(s, event('completed', 5, A));
  assert.equal(task(s, A).status, 'completed');
  const latest = sel.latestOutputFor(s.conversations, A);
  const thread = sel.conversationFor(s.conversations, A);
  assert.equal(latest.text, 'Second answer');
  assert.equal(latest, thread[thread.length - 1], 'the very same record');
});

test('Idle Stop still records the assistant response', () => {
  let s = ingest(EMPTY, event('running', 0, A));
  s = ingest(s, event('idle', 2, A));
  s = setConv(s, conversation(A, [msg(A, 'user', PROMPT1, 1, { title: TITLE1 }), msg(A, 'assistant', 'Running the tests in the background now.', 2)]));
  assert.equal(task(s, A).status, 'idle');
  assert.equal(sel.latestOutputFor(s.conversations, A).text, 'Running the tests in the background now.');
});

test('message replay does not duplicate (same messageId twice in a payload, and re-fetch)', () => {
  let s = ingest(EMPTY, event('running', 0, A));
  const m1 = msg(A, 'user', PROMPT1, 1, { title: TITLE1 });
  const m2 = msg(A, 'assistant', ANSWER1, 2);
  s = setConv(s, conversation(A, [m1, m2, { ...m1 }, { ...m2 }]));
  assert.equal(sel.conversationFor(s.conversations, A).length, 2);
  s = setConv(s, conversation(A, [m1, m2]));
  s = setConv(s, conversation(A, [m1, m2]));
  assert.equal(sel.conversationFor(s.conversations, A).length, 2);
});

test('identical text on separate turns stays two turns; only an identical messageId is a replay', () => {
  let s = ingest(EMPTY, event('running', 0, A));
  const u1 = msg(A, 'user', 'Run the tests', 1, { title: 'Run tests' });
  const a1 = msg(A, 'assistant', 'All green.', 2);
  const u2 = msg(A, 'user', 'Run the tests', 3);
  const a2 = msg(A, 'assistant', 'All green.', 4);
  s = setConv(s, conversation(A, [u1, { ...u1 }, a1, u2, a2, { ...a2 }]));
  assert.deepEqual(sel.conversationFor(s.conversations, A).map((m) => [m.role, m.text]), [
    ['user', 'Run the tests'],
    ['assistant', 'All green.'],
    ['user', 'Run the tests'],
    ['assistant', 'All green.'],
  ]);
  assert.equal(task(s, A).autoTitle, 'Run tests');
  assert.equal(sel.latestOutputFor(s.conversations, A), sel.conversationFor(s.conversations, A)[3]);
});

test('a long conversation is shown in full: 450 turns, none dropped', () => {
  let s = ingest(EMPTY, event('running', 0, A));
  const many = [];
  for (let i = 0; i < 450; i += 1) many.push(msg(A, i % 2 ? 'assistant' : 'user', `turn ${i}`, i, i === 0 ? { title: 'First' } : {}));
  s = setConv(s, conversation(A, many));
  const thread = sel.conversationFor(s.conversations, A);
  assert.equal(thread.length, 450);
  assert.equal(thread[0].text, 'turn 0');
  assert.equal(thread[449].text, 'turn 449');
  assert.equal(task(s, A).autoTitle, 'First');
});

test('reload: the title survives in task storage; the conversation itself is re-fetched, not cached durably', () => {
  let s = ingest(EMPTY, event('running', 0, A));
  s = setConv(s, conversation(A, [msg(A, 'user', PROMPT1, 1, { title: TITLE1 }), msg(A, 'assistant', ANSWER1, 2)]));
  saveTaskStorage(s.tasks, s.taskMeta, s.forgottenTasks, s.subtasks, s.projectCounters);
  const loaded = loadTaskStorage();
  assert.equal(loaded.tasks[0].autoTitle, TITLE1);
  assert.equal(loaded.tasks[0].title, 'Task 1');
  const raw = mem.get('agenthub.tasks.v1');
  assert.equal(raw.includes(PROMPT1), false, 'no prompt text in phone storage');
  assert.equal(raw.includes('Implemented'), false, 'no response text in phone storage');
  // After a reload the store starts without the thread and refills it from Windows.
  const resumed = { ...EMPTY, tasks: loaded.tasks, subtasks: loaded.subtasks, projectCounters: loaded.projectCounters };
  assert.deepEqual(sel.conversationFor(resumed.conversations, A), []);
  const refilled = setConv(resumed, conversation(A, [msg(A, 'user', PROMPT1, 1, { title: TITLE1 }), msg(A, 'assistant', ANSWER1, 2)]));
  assert.equal(sel.conversationFor(refilled.conversations, A).length, 2);
  assert.equal(displayTitle(task(refilled, A)), TITLE1);
});

test('child final output attaches to the child, never to the parent conversation', () => {
  let s = ingest(EMPTY, event('running', 0, A));
  s = ingest(s, event('running', 1, A, { subtaskId: A1, agentType: 'Explore' }));
  s = ingest(s, event('completed', 2, A, { subtaskId: A1, agentType: 'Explore' }));
  const conv = conversation(A, [msg(A, 'user', PROMPT1, 0, { title: TITLE1 })], {
    children: { [A1]: { messages: [msg(A, 'assistant', 'Found the Stop hook issue in hook_context.py.', 2, { subtaskId: A1 })], trimmed: 0, agentType: 'Explore' } },
  });
  s = setConv(s, conv);
  assert.equal(sel.conversationFor(s.conversations, A).length, 1, 'parent thread has only the parent prompt');
  assert.equal(sel.latestOutputFor(s.conversations, A), null, 'a child output is never the parent\'s latest output');
  assert.equal(sel.childOutputFor(s.conversations, A, A1).text, 'Found the Stop hook issue in hook_context.py.');
  assert.equal(task(s, A).status, 'running', 'and the child finishing did not finish the parent');
});

test('subtask title: from the child\'s first prompt when a hook exposes one, otherwise "<agentType> N"', () => {
  let s = ingest(EMPTY, event('running', 0, A));
  s = ingest(s, event('running', 1, A, { subtaskId: A1, agentType: 'Explore' }));
  const child = s.subtasks.find((x) => x.id === A1);
  assert.equal(subtaskTitle(child), 'Explore 1', 'safe fallback: agent type + ordinal');
  assert.equal(subtaskTitle({ ordinal: 2 }), 'Subagent 2');
  // If Claude ever delivers a child prompt through UserPromptSubmit, the relay names the child thread from it.
  const conv = conversation(A, [msg(A, 'user', PROMPT1, 0, { title: TITLE1 })], {
    children: { [A1]: { messages: [msg(A, 'user', 'Investigate how the Stop hook classifies background work', 1, { subtaskId: A1 })], trimmed: 0, title: 'Investigate how Stop hook classifies background work' } },
  });
  s = setConv(s, conv);
  assert.equal(subtaskTitle(s.subtasks.find((x) => x.id === A1)), 'Investigate how Stop hook classifies background work');
  // Never guessed from the final response: an output-only child keeps the fallback.
  const s2 = setConv(ingest(ingest(EMPTY, event('running', 0, B)), event('running', 1, B, { subtaskId: 't-b1b1b1b1b1b1b1b1', agentType: 'Plan' })),
    conversation(B, [], { children: { 't-b1b1b1b1b1b1b1b1': { messages: [msg(B, 'assistant', 'Here is the plan.', 2, { subtaskId: 't-b1b1b1b1b1b1b1b1' })], trimmed: 0 } } }));
  assert.equal(subtaskTitle(s2.subtasks.find((x) => x.id === 't-b1b1b1b1b1b1b1b1')), 'Plan 1');
});

test('forget removes the phone\'s cached conversation with the task (Windows copy untouched by design)', () => {
  let s = ingest(EMPTY, event('running', 0, A));
  s = setConv(s, conversation(A, [msg(A, 'user', PROMPT1, 1, { title: TITLE1 })]));
  assert.deepEqual(Object.keys(s.conversations), [A]);
  s = agentReducer(s, { type: 'forgetTask', taskId: A });
  assert.deepEqual(s.conversations, {});
  assert.equal(task(s, A), undefined);
});

test('message validation drops anything but the record shape; text is plain text', () => {
  const ok = parseConversationMessage({ messageId: 'm-1', taskId: A, role: 'user', text: '<b>not html</b>\n<script>alert(1)</script>', timestamp: at(0), tool_input: { command: 'rm' }, transcript_path: 'x' });
  assert.equal(ok.text, '<b>not html</b>\n<script>alert(1)</script>', 'kept verbatim as text; the UI renders it as text, never as markup');
  assert.equal('tool_input' in ok, false);
  assert.equal('transcript_path' in ok, false);
  for (const bad of [{ role: 'system' }, { text: '' }, { messageId: '../x' }, { timestamp: 'nope' }]) {
    assert.equal(parseConversationMessage({ messageId: 'm-1', taskId: A, role: 'user', text: 'x', timestamp: at(0), ...bad }), null, JSON.stringify(bad));
  }
  const conv = parseTaskConversation({ taskId: A, title: 'T', updatedAt: at(0), thread: { messages: [{ nonsense: true }] }, children: { 'bad id!': { messages: [] } } });
  assert.deepEqual(conv.thread.messages, []);
  assert.deepEqual(conv.children, {});
});

test('status events carry no conversation text and the hierarchy/lifecycle rules are unchanged', () => {
  let s = ingest(EMPTY, event('idle', 0, A));
  s = ingest(s, event('running', 1, A));
  s = ingest(s, event('running', 2, A, { subtaskId: A1, agentType: 'Explore' }));
  s = ingest(s, event('completed', 3, A, { subtaskId: A1 }));
  assert.equal(task(s, A).status, 'running');
  s = ingest(s, event('completed', 4, A));
  assert.equal(task(s, A).status, 'completed');
  assert.equal(s.tasks.length, 1);
  assert.equal(JSON.stringify(s.events).includes('text'), false);
});

/* ------------------------------------------------ newest-first display order */

test('Conversation is displayed newest first while storage stays chronological', () => {
  let s = ingest(EMPTY, event('running', 0, A));
  s = setConv(s, conversation(A, [
    msg(A, 'user', PROMPT1, 1, { title: TITLE1 }),
    msg(A, 'assistant', ANSWER1, 2),
    msg(A, 'user', 'Second prompt', 3),
    msg(A, 'assistant', 'Second answer', 4),
  ]));

  // Stored / fetched order is untouched: oldest first.
  assert.deepEqual(
    sel.conversationFor(s.conversations, A).map((m) => m.text.slice(0, 13)),
    ['Fix the push ', 'Implemented t', 'Second prompt', 'Second answer'],
  );
  // Display order is the reverse: the latest turn is first on the screen.
  assert.deepEqual(
    sel.conversationForDisplay(s.conversations, A).map((m) => [m.role, m.text.slice(0, 13)]),
    [
      ['assistant', 'Second answer'],
      ['user', 'Second prompt'],
      ['assistant', 'Implemented t'],
      ['user', 'Fix the push '],
    ],
  );
  // Same records, same ids, same timestamps: only the order differs.
  const stored = sel.conversationFor(s.conversations, A);
  const shown = sel.conversationForDisplay(s.conversations, A);
  assert.deepEqual(shown.map((m) => m.messageId), [...stored.map((m) => m.messageId)].reverse());
  assert.equal(shown[0], stored[stored.length - 1], 'the very same record object');
  assert.deepEqual(shown.map((m) => m.timestamp), [...stored.map((m) => m.timestamp)].reverse());
  // Reversing must not mutate the cached conversation.
  assert.deepEqual(sel.conversationFor(s.conversations, A).map((m) => m.text.slice(0, 13)), [
    'Fix the push ', 'Implemented t', 'Second prompt', 'Second answer',
  ]);
});

test('an existing conversation captured earlier also renders newest first', () => {
  // A conversation fetched from Windows exactly as the relay stores it.
  let s = ingest(EMPTY, event('running', 0, A));
  const many = [];
  for (let i = 0; i < 9; i += 1) many.push(msg(A, i % 2 ? 'assistant' : 'user', `turn ${i}`, i, i === 0 ? { title: TITLE1 } : {}));
  s = setConv(s, conversation(A, many));
  const shown = sel.conversationForDisplay(s.conversations, A);
  assert.equal(shown.length, 9);
  assert.equal(shown[0].text, 'turn 8');
  assert.equal(shown[8].text, 'turn 0');
  assert.equal(task(s, A).autoTitle, TITLE1, 'the title still comes from the first turn');
});

test('a newly received message appears at the top without disturbing the rest', () => {
  let s = ingest(EMPTY, event('running', 0, A));
  const first = msg(A, 'user', PROMPT1, 1, { title: TITLE1 });
  const reply = msg(A, 'assistant', ANSWER1, 2);
  s = setConv(s, conversation(A, [first, reply]));
  assert.equal(sel.conversationForDisplay(s.conversations, A)[0].text, ANSWER1);

  // The screen is open and a new turn arrives on the next fetch.
  const fresh = msg(A, 'assistant', 'A brand new answer', 3);
  s = setConv(s, conversation(A, [first, reply, fresh]));
  const shown = sel.conversationForDisplay(s.conversations, A);
  assert.equal(shown[0].text, 'A brand new answer', 'newest is first');
  assert.equal(shown[0].messageId, fresh.messageId);
  assert.deepEqual(shown.slice(1).map((m) => m.text), [ANSWER1, PROMPT1], 'older turns keep their order below');
  // "Latest output" and the top bubble are the same record.
  assert.equal(sel.latestOutputFor(s.conversations, A).messageId, shown[0].messageId);
});

test('display order never mixes a child thread into the parent', () => {
  let s = ingest(EMPTY, event('running', 0, A));
  s = ingest(s, event('running', 1, A, { subtaskId: A1, agentType: 'Explore' }));
  s = setConv(s, conversation(A, [msg(A, 'user', PROMPT1, 0, { title: TITLE1 }), msg(A, 'assistant', ANSWER1, 5)], {
    children: { [A1]: { messages: [msg(A, 'assistant', 'Child output', 9, { subtaskId: A1 })], trimmed: 0 } },
  }));
  const shown = sel.conversationForDisplay(s.conversations, A);
  assert.equal(shown.length, 2);
  assert.equal(shown.some((m) => m.text === 'Child output'), false, 'the newer child turn stays under the child');
  assert.equal(sel.childOutputFor(s.conversations, A, A1).text, 'Child output');
});
