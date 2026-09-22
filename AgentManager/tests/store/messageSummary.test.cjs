/**
 * Cards written on Windows, as the app receives and uses them.
 *
 *   npm run test:store
 *
 * The app never generates these and never edits a message because of one. A
 * card is presentation metadata that arrives beside the message it previews;
 * anything malformed is dropped and the local generator takes over.
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
const {
  parseAgentNotificationEvent,
  parseMessageSummary,
  parseTaskConversation,
} = require(path.join(BUILD, 'protocol', 'index.js'));

const A = 's-aaaaaaaaaaaaaaaa';
const M1 = 'm-0001aaaaaaaaaaaaaaaaaaaa';
const M2 = 'm-0002aaaaaaaaaaaaaaaaaaaa';
const EMPTY = { agents: [], events: [], approvals: [], tasks: [], taskMeta: {}, forgottenTasks: {}, subtasks: [], projectCounters: {}, conversations: {} };

const at = (s) => new Date(Date.UTC(2026, 8, 22, 10, 0, s)).toISOString();
const LONG_ANSWER = [
  '## Summary',
  '',
  'Implemented the corrected lifecycle and staged the build for review.',
  '',
  '- Stop reports Idle while background work is outstanding',
  '- Stop reports Completed only when nothing is left',
  '- All suites pass and nothing was deployed',
].join('\n');

const CARD = {
  messageId: M2,
  title: 'Corrected lifecycle implemented',
  style: 'bullets',
  paragraph: '',
  bullets: ['Idle while background work is outstanding', 'Completed only when nothing is left', 'All suites pass'],
};

const message = (messageId, role, text, second) => ({ messageId, taskId: A, role, text, timestamp: at(second) });

function conversation(messages, summaries = {}) {
  return parseTaskConversation({
    version: 1,
    taskId: A,
    title: 'Fix push notification lifecycle',
    updatedAt: at(99),
    thread: { messages },
    children: {},
    summaries,
  });
}
const event = (type, second) => ({
  version: 1, eventId: `evt-${second}${'g'.repeat(28)}`, agentId: 'win_claude_code', agentName: 'Claude Code',
  type, title: 'x', message: 'x', timestamp: at(second), provider: 'claude', taskId: A,
  projectId: 'p-1111aaaa2222', projectName: 'AgentHub',
});
function ingest(state, raw) {
  const r = parseAgentNotificationEvent(raw);
  assert.equal(r.ok, true, (r.errors || []).join('; '));
  return agentReducer(state, { type: 'ingestRemoteEvent', event: r.event, source: 'push' });
}
const setConv = (state, conv) => agentReducer(state, { type: 'setConversation', conversation: conv });

test.beforeEach(() => mem.clear());

/* ------------------------------------------------------------ validation */

test('a well-formed card is accepted intact', () => {
  const card = parseMessageSummary(CARD);
  assert.deepEqual(card, CARD);
});

test('a paragraph card keeps its paragraph and drops stray bullets', () => {
  const card = parseMessageSummary({
    messageId: M1, title: 'Authentication issue identified', style: 'paragraph',
    paragraph: 'An expired local credential caused the failure.', bullets: ['ignored'],
  });
  assert.equal(card.style, 'paragraph');
  assert.equal(card.bullets.length, 0, 'a paragraph card carries no bullets');
  assert.ok(card.paragraph.startsWith('An expired'));
});

test('malformed cards are dropped rather than shown', () => {
  for (const bad of [
    null, undefined, 'string', 42,
    { ...CARD, messageId: '../etc/passwd' },
    { ...CARD, style: 'table' },
    { ...CARD, title: '' },
    { ...CARD, title: '   ' },
    { ...CARD, bullets: [] },
    { messageId: M1, title: 'x', style: 'paragraph', paragraph: '', bullets: [] },
  ]) {
    assert.equal(parseMessageSummary(bad), null, JSON.stringify(bad)?.slice(0, 50));
  }
});

test('card text is cleaned of control characters and collapsed whitespace', () => {
  const card = parseMessageSummary({
    ...CARD,
    title: 'Deployment\u0000   completed\u0007 successfully',
    bullets: ['Relay\u0000 restarted', '   ', 'PWA   deployed'],
  });
  assert.equal(card.title, 'Deployment completed successfully');
  assert.deepEqual(card.bullets, ['Relay restarted', 'PWA deployed']);
});

test('however many bullets the writer chose are kept', () => {
  for (const count of [1, 3, 7, 12]) {
    const bullets = Array.from({ length: count }, (_, i) => `Point ${i + 1}`);
    assert.equal(parseMessageSummary({ ...CARD, bullets }).bullets.length, count);
  }
});

/* ------------------------------------------------- arriving with a thread */

test('a card is matched to its own message and a mismatched key is dropped', () => {
  const conv = conversation(
    [message(M1, 'user', 'x'.repeat(400), 1), message(M2, 'assistant', LONG_ANSWER, 2)],
    { [M2]: CARD, [M1]: { ...CARD, messageId: M2 } },
  );
  assert.deepEqual(Object.keys(conv.summaries), [M2], 'a card filed under the wrong id is discarded');
  assert.equal(conv.summaries[M2].title, CARD.title);
});

test('a conversation with no cards is completely normal', () => {
  const conv = conversation([message(M2, 'assistant', LONG_ANSWER, 2)]);
  assert.deepEqual(conv.summaries, {});
  assert.equal(conv.thread.messages[0].text, LONG_ANSWER);
});

test('the original message is untouched by the presence of a card', () => {
  const conv = conversation([message(M2, 'assistant', LONG_ANSWER, 2)], { [M2]: CARD });
  assert.equal(conv.thread.messages[0].text, LONG_ANSWER, 'the full original text is what expanding shows');
  assert.equal(conv.thread.messages[0].messageId, M2);
  assert.equal(conv.thread.messages[0].timestamp, at(2));
});

/* ----------------------------------------------------------- in the store */

test('cards reach the store and are looked up by messageId', () => {
  let s = ingest(EMPTY, event('running', 0));
  s = setConv(s, conversation([message(M1, 'user', 'x'.repeat(400), 1), message(M2, 'assistant', LONG_ANSWER, 2)], { [M2]: CARD }));

  assert.equal(sel.summaryFor(s.conversations, A, M2).title, CARD.title);
  assert.equal(sel.summaryFor(s.conversations, A, M1), null, 'no card means the local generator is used');
  assert.equal(sel.summaryFor(s.conversations, A, undefined), null);
  assert.equal(sel.summaryFor(s.conversations, 's-unknown00000000', M2), null);
});

test('Latest output and Conversation resolve to the same card for the same message', () => {
  let s = ingest(EMPTY, event('running', 0));
  s = setConv(s, conversation([message(M1, 'user', 'x'.repeat(400), 1), message(M2, 'assistant', LONG_ANSWER, 2)], { [M2]: CARD }));
  s = ingest(s, event('completed', 3));

  const latest = sel.latestOutputFor(s.conversations, A);
  const newestInThread = sel.conversationForDisplay(s.conversations, A)[0];
  assert.equal(latest.messageId, newestInThread.messageId, 'the same underlying message');
  const fromLatest = sel.summaryFor(s.conversations, A, latest.messageId);
  const fromThread = sel.summaryFor(s.conversations, A, newestInThread.messageId);
  assert.equal(fromLatest, fromThread, 'and therefore the very same card object');
});

test('forgetting a task drops its cards with its cached conversation', () => {
  let s = ingest(EMPTY, event('running', 0));
  s = setConv(s, conversation([message(M2, 'assistant', LONG_ANSWER, 2)], { [M2]: CARD }));
  s = agentReducer(s, { type: 'forgetTask', taskId: A });
  assert.deepEqual(s.conversations, {});
  assert.equal(sel.summaryFor(s.conversations, A, M2), null);
});

test('no card text is ever written to phone storage', () => {
  let s = ingest(EMPTY, event('running', 0));
  s = setConv(s, conversation([message(M2, 'assistant', LONG_ANSWER, 2)], { [M2]: CARD }));
  const { saveTaskStorage } = require(path.join(BUILD, 'services', 'persistence', 'index.js'));
  saveTaskStorage(s.tasks, s.taskMeta, s.forgottenTasks, s.subtasks, s.projectCounters);
  const raw = mem.get('agenthub.tasks.v1') ?? '';
  assert.equal(raw.includes(CARD.title), false, 'cards are session cache, refetched from Windows');
  assert.equal(raw.includes(LONG_ANSWER.slice(0, 30)), false);
});
