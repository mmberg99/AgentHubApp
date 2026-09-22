/**
 * Rollback compatibility: the deployed app against the pre-AI relay.
 *
 *   npm run test:store
 *
 * AgentHubRelay-preai-backup is the rollback baseline. Its conversation route
 * answers `{ ok: true, conversation: conv }` where `conv` has no `summaries`
 * key at all — the field did not exist when that version was written.
 *
 * The app currently in production must keep working against exactly that
 * payload: no crash, every panel populated, and the deterministic local
 * preview used for every message, since no card can arrive. These tests pin
 * that down so a rollback is a decision, not a gamble.
 *
 * The separate question of a `summaries` key that is present but empty is
 * covered in messageSummary.test.cjs; this file is about it being ABSENT.
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
const { parseAgentNotificationEvent, parseTaskConversation } = require(path.join(BUILD, 'protocol', 'index.js'));
const { buildMessagePreview } = require(path.join(BUILD, 'lib', 'messagePreview.js'));
const {
  DEFAULT_NOTIFICATION_PREFERENCES,
  loadNotificationPreferences,
  saveNotificationPreferences,
} = require(path.join(BUILD, 'lib', 'notificationPreferences.js'));
// remoteControl.ts reaches React Native's Linking, so it is not part of this
// CommonJS build. Its one relevant property is read from source instead.
const REMOTE_CONTROL_SOURCE = require('node:fs').readFileSync(
  path.join(__dirname, '..', '..', 'src', 'services', 'remoteControl.ts'),
  'utf8',
);

const A = 's-rollback0000001';
const CHILD = 't-rollbackchild01';
const M_USER = 'm-rb01aaaaaaaaaaaaaaaaaaa';
const M_ASSISTANT = 'm-rb02aaaaaaaaaaaaaaaaaaa';
const M_CHILD = 'm-rb03aaaaaaaaaaaaaaaaaaa';

const EMPTY = {
  agents: [], events: [], approvals: [], tasks: [], taskMeta: {}, forgottenTasks: {},
  subtasks: [], projectCounters: {}, conversations: {},
};

const at = (s) => new Date(Date.UTC(2026, 8, 22, 21, 0, s)).toISOString();

const PROMPT = [
  'Fix the push notification lifecycle so Claude is idle while background tests are still running.',
  '',
  '- Stop with outstanding work should report Idle',
  '- Stop with nothing outstanding should report Completed',
  '- Do not change the existing push policy',
  '- Add tests covering both paths',
  '',
  'Build and stage it, then stop for approval before deploying anything.',
].join('\n');

const RESPONSE = [
  '## Summary',
  '',
  'Implemented the **corrected lifecycle**. `Stop` with work outstanding now reports *Idle*,',
  'and only a `Stop` with nothing outstanding reports **Completed**.',
  '',
  '- `hook_context.py` classifies the stop',
  '- `notificationPolicy.mjs` decides the push',
  '- All suites pass and nothing was deployed',
].join('\n');

const CHILD_OUTPUT = [
  'Explored the notifier and found three call sites that classify a stop.',
  '',
  '- hook_context.py builds the context',
  '- hook_events.py chooses the event type',
  '- lan_bridge.py delivers it',
  '',
  'None of them needed a change beyond the classification fix.',
].join('\n');

const message = (messageId, role, text, second, extra = {}) => ({
  messageId, taskId: A, role, text, timestamp: at(second), ...extra,
});

/**
 * Exactly what AgentHubRelay-preai-backup serves: no `summaries` anywhere,
 * on the conversation or on any thread.
 */
function preAiPayload() {
  return {
    version: 1,
    taskId: A,
    title: 'Fix push notification lifecycle',
    createdAt: at(0),
    updatedAt: at(99),
    thread: {
      messages: [
        message(M_USER, 'user', PROMPT, 1),
        message(M_ASSISTANT, 'assistant', RESPONSE, 2),
      ],
      trimmed: 0,
    },
    children: {
      [CHILD]: {
        messages: [message(M_CHILD, 'assistant', CHILD_OUTPUT, 3, { subtaskId: CHILD })],
        trimmed: 0,
        title: 'Explore the notifier',
        agentType: 'Explore',
      },
    },
  };
}

const event = (type, second) => ({
  version: 1, eventId: `evt-rb${second}${'h'.repeat(27)}`, agentId: 'win_claude_code',
  agentName: 'Claude Code', type, title: 'x', message: 'x', timestamp: at(second),
  provider: 'claude', taskId: A, projectId: 'p-1111aaaa2222', projectName: 'AgentHub',
});

function ingest(state, raw) {
  const r = parseAgentNotificationEvent(raw);
  assert.equal(r.ok, true, (r.errors || []).join('; '));
  return agentReducer(state, { type: 'ingestRemoteEvent', event: r.event, source: 'push' });
}

function loaded() {
  const payload = preAiPayload();
  assert.equal('summaries' in payload, false, 'the baseline really does omit the field');
  const conversation = parseTaskConversation(payload);
  let s = ingest(EMPTY, event('running', 0));
  s = agentReducer(s, { type: 'setConversation', conversation });
  return { state: s, conversation };
}

test.beforeEach(() => mem.clear());

/* --------------------------------------------------------------- parsing */

test('a payload with no summaries key parses without throwing', () => {
  const payload = preAiPayload();
  let conversation;
  assert.doesNotThrow(() => {
    conversation = parseTaskConversation(payload);
  });
  assert.ok(conversation, 'a conversation came back');
  assert.deepEqual(conversation.summaries, {}, 'the field is defaulted, never undefined');
});

test('the absent field is never confused with a malformed one', () => {
  for (const bad of [undefined, null, 'nope', 42, []]) {
    const conversation = parseTaskConversation({ ...preAiPayload(), summaries: bad });
    assert.deepEqual(conversation.summaries, {}, JSON.stringify(bad));
  }
});

/* ------------------------------------------------------------- rendering */

test('the conversation still renders, newest first', () => {
  const { state } = loaded();
  const shown = sel.conversationForDisplay(state.conversations, A);
  assert.equal(shown.length, 2);
  assert.equal(shown[0].messageId, M_ASSISTANT, 'newest at the top');
  assert.equal(shown[1].messageId, M_USER);
  assert.equal(shown[0].text, RESPONSE, 'the full original text is intact');
  assert.equal(shown[1].text, PROMPT);
});

test('every message falls back to the deterministic local preview', () => {
  const { state } = loaded();
  for (const id of [M_USER, M_ASSISTANT, M_CHILD]) {
    assert.equal(sel.summaryFor(state.conversations, A, id), null,
      'no card exists, so the card lookup must say so rather than throw');
  }

  // What the card component does with that null: build the preview itself.
  const fromPrompt = buildMessagePreview(PROMPT, 'user');
  const fromResponse = buildMessagePreview(RESPONSE, 'assistant');
  assert.equal(fromPrompt.needsExpansion, true, 'a long prompt still collapses');
  assert.equal(fromResponse.needsExpansion, true, 'a long response still collapses');
  assert.ok(fromPrompt.title.length > 0, 'and still gets a title');
  assert.ok(fromResponse.title.length > 0);
  assert.ok(
    fromResponse.bullets.length > 0 || fromResponse.paragraph.length > 0,
    'and a body',
  );
});

test('Latest output still works and resolves to the newest assistant message', () => {
  const { state } = loaded();
  const latest = sel.latestOutputFor(state.conversations, A);
  assert.ok(latest, 'there is a latest output');
  assert.equal(latest.messageId, M_ASSISTANT);
  assert.equal(latest.text, RESPONSE);
  assert.equal(sel.summaryFor(state.conversations, A, latest.messageId), null,
    'it uses the local preview too, exactly like the conversation');
});

test('subagent output still works', () => {
  const { state, conversation } = loaded();
  const childMessages = sel.childConversationFor(state.conversations, A, CHILD);
  assert.equal(childMessages.length, 1, 'the child thread survived a payload with no summaries');
  assert.equal(childMessages[0].text, CHILD_OUTPUT);
  assert.equal(childMessages[0].subtaskId, CHILD);
  assert.equal(conversation.children[CHILD].title, 'Explore the notifier');
  assert.equal(conversation.children[CHILD].agentType, 'Explore');

  const output = sel.childOutputFor(state.conversations, A, CHILD);
  assert.ok(output, 'the subagent output panel has something to show');
  assert.equal(output.text, CHILD_OUTPUT);
  assert.equal(sel.summaryFor(state.conversations, A, M_CHILD), null,
    'the child message uses the local preview too');
});

test('nothing reads summaries off a thread, where the field never existed', () => {
  const { conversation } = loaded();
  assert.equal('summaries' in conversation.thread, false);
  assert.equal('summaries' in conversation.children[CHILD], false);
  // The lookup is by message id against the conversation, so a thread without
  // the field cannot produce an undefined dereference.
  assert.equal(sel.summaryFor({ [A]: conversation }, A, M_ASSISTANT), null);
});

/* ------------------------------------------- features that must be unaffected */

test('the notification preference is unaffected by the relay version', () => {
  assert.deepEqual(loadNotificationPreferences(), DEFAULT_NOTIFICATION_PREFERENCES);
  saveNotificationPreferences({ subtaskCompletionPush: false });
  assert.equal(loadNotificationPreferences().subtaskCompletionPush, false);
  saveNotificationPreferences({ subtaskCompletionPush: true });
  assert.equal(loadNotificationPreferences().subtaskCompletionPush, true);
});

test('Continue in Claude is unaffected by the relay version', () => {
  assert.ok(
    REMOTE_CONTROL_SOURCE.includes("CLAUDE_CODE_URL = 'https://claude.ai/code'"),
    'a fixed link, so it cannot depend on anything the relay sends',
  );
  for (const forbidden of ['sessionId', 'session_id', 'conversation', 'summaries']) {
    assert.equal(REMOTE_CONTROL_SOURCE.includes(forbidden), false,
      `Continue in Claude must not reference ${forbidden}`);
  }
  // The file mentions claude:// only to record that Anthropic documents no
  // such scheme. What matters is that no claude:// URL is ever opened.
  assert.equal(/openURL\(\s*['"`]claude:\/\//.test(REMOTE_CONTROL_SOURCE), false);
  assert.equal(/=\s*['"`]claude:\/\//.test(REMOTE_CONTROL_SOURCE), false);
});

/* ----------------------------------------------------- no crash, end to end */

test('a whole task screen can be built from the pre-AI payload', () => {
  const { state } = loaded();
  assert.doesNotThrow(() => {
    const shown = sel.conversationForDisplay(state.conversations, A);
    for (const m of shown) {
      const card = sel.summaryFor(state.conversations, A, m.messageId);
      // Exactly the expression the card component evaluates.
      const preview = card ?? buildMessagePreview(m.text, m.role);
      assert.ok(preview, 'every message resolves to something renderable');
    }
    sel.latestOutputFor(state.conversations, A);
    sel.childConversationFor(state.conversations, A, CHILD);
    sel.childOutputFor(state.conversations, A, CHILD);
    sel.subtasksFor(state.subtasks, A);
  });
});

test('a task with no conversation at all is still safe', () => {
  const s = ingest(EMPTY, event('running', 0));
  assert.deepEqual(sel.conversationFor(s.conversations, A), [], 'an empty list, never undefined');
  assert.deepEqual(sel.conversationForDisplay(s.conversations, A), []);
  assert.equal(sel.latestOutputFor(s.conversations, A), null);
  assert.equal(sel.summaryFor(s.conversations, A, M_ASSISTANT), null);
  assert.deepEqual(sel.childConversationFor(s.conversations, A, CHILD), []);
  assert.equal(sel.childOutputFor(s.conversations, A, CHILD), null);
});
