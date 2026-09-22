/**
 * Notification preferences held on the phone.
 *
 *   npm run test:store
 *
 * This is the copy the toggle reads. What is actually delivered is decided on
 * Windows by the relay, which keeps its own copy per subscription; the relay
 * suite proves the delivery filter.
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
const {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_PREFERENCES_KEY,
  loadNotificationPreferences,
  saveNotificationPreferences,
  sanitizeNotificationPreferences,
} = require(path.join(BUILD, 'lib', 'notificationPreferences.js'));

test.beforeEach(() => mem.clear());

test('subtask completion notifications default to ON', () => {
  assert.equal(DEFAULT_NOTIFICATION_PREFERENCES.subtaskCompletionPush, true);
  assert.deepEqual(loadNotificationPreferences(), { subtaskCompletionPush: true });
});

test('turning it off persists across a reload', () => {
  saveNotificationPreferences({ subtaskCompletionPush: false });
  assert.deepEqual(loadNotificationPreferences(), { subtaskCompletionPush: false });
  // A fresh read of the same store is what a reload does.
  assert.equal(JSON.parse(mem.get(NOTIFICATION_PREFERENCES_KEY)).subtaskCompletionPush, false);
  saveNotificationPreferences({ subtaskCompletionPush: true });
  assert.deepEqual(loadNotificationPreferences(), { subtaskCompletionPush: true });
});

test('unknown or corrupt stored values fall back to the defaults', () => {
  for (const raw of ['not json', '[]', 'null', '{"subtaskCompletionPush":"yes"}', '{}']) {
    mem.set(NOTIFICATION_PREFERENCES_KEY, raw);
    assert.deepEqual(loadNotificationPreferences(), { subtaskCompletionPush: true }, raw);
  }
});

test('only the known key is kept; anything else is discarded', () => {
  const clean = sanitizeNotificationPreferences({
    subtaskCompletionPush: false,
    pushAllEvents: true,
    token: 'secret',
  });
  assert.deepEqual(clean, { subtaskCompletionPush: false });
  saveNotificationPreferences({ subtaskCompletionPush: false, token: 'secret' });
  assert.equal(mem.get(NOTIFICATION_PREFERENCES_KEY).includes('secret'), false);
});

test('a blocked store degrades to defaults instead of throwing', () => {
  const real = globalThis.localStorage;
  globalThis.localStorage = {
    get getItem() {
      throw new Error('blocked');
    },
  };
  try {
    assert.deepEqual(loadNotificationPreferences(), { subtaskCompletionPush: true });
    assert.doesNotThrow(() => saveNotificationPreferences({ subtaskCompletionPush: false }));
  } finally {
    globalThis.localStorage = real;
  }
});
