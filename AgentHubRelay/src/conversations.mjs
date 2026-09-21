/**
 * Conversation storage: the user-visible prompt/response text per task.
 *
 * SCOPE (explicitly approved). The notifier sends, as separate small records:
 *   - the user's submitted prompt (UserPromptSubmit)
 *   - Claude's visible response (Stop / SubagentStop `last_assistant_message`)
 * Nothing else is ever accepted here: no tool input/output, no transcript
 * contents, no commands, no raw ids or paths. The validator rebuilds every
 * record from an allow-list, so an unknown field can never reach disk.
 *
 * DIRECTION. Writes arrive only through the loopback ingestion listener with
 * the ingestion bearer token (the same path as status events). Reads are
 * served only by the PWA listener behind a device's capability token. The
 * phone can never write a message; a hook can never read one.
 *
 * LAYOUT. One file per parent task, `<taskId>.json`, holding the task's own
 * thread plus one thread per child (subagent). Windows is the source of truth:
 * the phone only caches. Writes are atomic (temp file + rename) and serialised.
 *
 * IDENTITY. Only the derived ids the notifier already uses: hashed task id,
 * hashed subtask id. No session id, agent id, cwd or path is ever stored.
 *
 * IDEMPOTENCY. `messageId` names ONE hook invocation (the notifier mints it
 * once per invocation, randomly). A replay of the same id is a no-op; two
 * turns with identical text but different ids are two turns. Text is never
 * used for deduplication.
 *
 * RETENTION. None. Every captured turn of a task is kept; no per-thread count
 * limit, no automatic deletion. The only bounds are per message
 * (MAX_MESSAGE_TEXT_CHARS, rejected above; the notifier cuts at 20,000 and
 * flags `truncated`) and per request body. Files are never deleted by the
 * relay; "Forget task" on the phone is local-only by design. A retention /
 * deletion policy is a separate, explicit decision.
 */

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  CONVERSATIONS_DIR,
  MAX_CONVERSATION_SUMMARIES,
  MAX_CONVERSATION_TITLE_CHARS,
  MAX_MESSAGE_TEXT_CHARS,
} from './config.mjs';
import { readJson, writeJsonAtomic } from './storage.mjs';

/* ------------------------------------------------------------- validation */

const ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
const ROLES = new Set(['user', 'assistant']);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function cleanText(value) {
  return value.replace(/\r\n?/g, '\n').replace(CONTROL, '').trim();
}

function cleanTitle(value) {
  return value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_CONVERSATION_TITLE_CHARS);
}

/**
 * Allow-list validation. Returns {ok, message} or {ok:false, errors}.
 * The returned object is built from scratch; nothing else passes through.
 */
export function parseConversationMessage(input) {
  const errors = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['payload must be a JSON object'] };
  }
  const src = input;
  if (src.version !== 1) errors.push('"version" must be 1');

  const id = (key, required) => {
    const v = src[key];
    if (v === undefined || v === null) {
      if (required) errors.push(`"${key}" is required`);
      return undefined;
    }
    if (typeof v !== 'string' || !ID_PATTERN.test(v)) {
      errors.push(`"${key}" is malformed`);
      return undefined;
    }
    return v;
  };
  const messageId = id('messageId', true);
  const taskId = id('taskId', true);
  const subtaskId = id('subtaskId', false);

  if (typeof src.role !== 'string' || !ROLES.has(src.role)) errors.push('"role" must be user or assistant');

  let text;
  if (typeof src.text !== 'string') {
    errors.push('"text" must be a string');
  } else {
    text = cleanText(src.text);
    if (text.length === 0) errors.push('"text" must not be empty');
    if (text.length > MAX_MESSAGE_TEXT_CHARS) errors.push(`"text" exceeds ${MAX_MESSAGE_TEXT_CHARS} characters`);
  }

  let timestamp;
  if (typeof src.timestamp !== 'string' || Number.isNaN(new Date(src.timestamp).getTime())) {
    errors.push('"timestamp" must be an ISO 8601 string');
  } else {
    timestamp = new Date(src.timestamp).toISOString();
  }

  let truncated = false;
  if (src.truncated !== undefined) {
    if (typeof src.truncated !== 'boolean') errors.push('"truncated" must be a boolean');
    else truncated = src.truncated;
  }

  let title;
  if (src.title !== undefined && src.title !== null) {
    if (typeof src.title !== 'string') errors.push('"title" must be a string');
    else if (src.role !== 'user') errors.push('"title" is only allowed on a user message');
    else {
      title = cleanTitle(src.title);
      if (title.length === 0) title = undefined;
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const message = { messageId, taskId, role: src.role, text, timestamp };
  if (subtaskId) message.subtaskId = subtaskId;
  if (truncated) message.truncated = true;
  if (title) message.title = title;
  return { ok: true, message };
}

/* ---------------------------------------------------------------- storage */

function emptyThread() {
  return { messages: [] };
}

function emptyConversation(taskId, now) {
  return {
    version: 1,
    taskId,
    title: null,
    createdAt: now,
    updatedAt: now,
    thread: emptyThread(),
    children: {},
  };
}

function sanitizeThread(raw) {
  const thread = emptyThread();
  if (typeof raw !== 'object' || raw === null) return thread;
  if (Array.isArray(raw.messages)) {
    for (const m of raw.messages) {
      const r = parseConversationMessage({ version: 1, ...m });
      if (r.ok) thread.messages.push(r.message);
    }
  }
  if (typeof raw.title === 'string') thread.title = cleanTitle(raw.title) || undefined;
  if (typeof raw.agentType === 'string') thread.agentType = cleanTitle(raw.agentType).slice(0, 40) || undefined;
  return thread;
}

function sanitizeConversation(raw, taskId) {
  const now = new Date().toISOString();
  const conv = emptyConversation(taskId, now);
  if (typeof raw !== 'object' || raw === null || raw.version !== 1) return conv;
  if (typeof raw.title === 'string') conv.title = cleanTitle(raw.title) || null;
  if (typeof raw.createdAt === 'string' && !Number.isNaN(Date.parse(raw.createdAt))) conv.createdAt = raw.createdAt;
  if (typeof raw.updatedAt === 'string' && !Number.isNaN(Date.parse(raw.updatedAt))) conv.updatedAt = raw.updatedAt;
  conv.thread = sanitizeThread(raw.thread);
  if (typeof raw.children === 'object' && raw.children !== null) {
    for (const [id, child] of Object.entries(raw.children)) {
      if (ID_PATTERN.test(id)) conv.children[id] = sanitizeThread(child);
    }
  }
  return conv;
}

function byTimestamp(a, b) {
  return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
}

function appendToThread(thread, message) {
  if (thread.messages.some((m) => m.messageId === message.messageId)) return false;
  thread.messages.push(message);
  thread.messages.sort(byTimestamp);
  // First user message names the thread; never overwritten afterwards.
  if (message.role === 'user' && message.title && !thread.title) thread.title = message.title;
  // No count-based trimming: the complete captured conversation is kept.
  return true;
}

export class ConversationStore {
  constructor(dir = CONVERSATIONS_DIR) {
    this.dir = dir;
    this.chain = Promise.resolve();
    /** taskId -> summary, for GET /conversations without touching every file. */
    this.index = null;
  }

  ensureDir() {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  pathFor(taskId) {
    if (!ID_PATTERN.test(taskId)) throw new Error('bad task id');
    return join(this.dir, `${taskId}.json`);
  }

  /** The full conversation for a task, or null. Sanitised on read. */
  get(taskId) {
    if (!ID_PATTERN.test(taskId)) return null;
    const raw = readJson(this.pathFor(taskId), null);
    if (raw === null) return null;
    return sanitizeConversation(raw, taskId);
  }

  static summarize(conv) {
    const last = conv.thread.messages[conv.thread.messages.length - 1] ?? null;
    return {
      taskId: conv.taskId,
      title: conv.title,
      messageCount: conv.thread.messages.length,
      lastRole: last ? last.role : null,
      updatedAt: conv.updatedAt,
      children: Object.fromEntries(
        Object.entries(conv.children).map(([id, t]) => [
          id,
          { title: t.title ?? null, messageCount: t.messages.length },
        ]),
      ),
    };
  }

  loadIndex() {
    if (this.index) return this.index;
    const index = new Map();
    if (existsSync(this.dir)) {
      for (const name of readdirSync(this.dir)) {
        if (!name.endsWith('.json')) continue;
        const taskId = name.slice(0, -5);
        if (!ID_PATTERN.test(taskId)) continue;
        try {
          if (!statSync(join(this.dir, name)).isFile()) continue;
        } catch {
          continue;
        }
        const conv = this.get(taskId);
        if (conv) index.set(taskId, ConversationStore.summarize(conv));
      }
    }
    this.index = index;
    return index;
  }

  /** Newest first, bounded. Titles and counts only; never message text. */
  summaries() {
    return [...this.loadIndex().values()]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, MAX_CONVERSATION_SUMMARIES);
  }

  /**
   * Append one validated message. Resolves to {stored, duplicate}. Serialised
   * so two hooks landing together cannot lose each other's write.
   */
  add(message, { agentType } = {}) {
    const run = () => {
      this.ensureDir();
      const now = new Date().toISOString();
      const conv = this.get(message.taskId) ?? emptyConversation(message.taskId, now);
      let target;
      if (message.subtaskId) {
        target = conv.children[message.subtaskId] ?? (conv.children[message.subtaskId] = emptyThread());
        if (agentType && !target.agentType) target.agentType = agentType;
      } else {
        target = conv.thread;
      }
      const stored = appendToThread(target, message);
      if (!stored) return { stored: false, duplicate: true };
      if (!message.subtaskId && !conv.title && target.title) conv.title = target.title;
      conv.updatedAt = now;
      writeJsonAtomic(this.pathFor(message.taskId), conv);
      this.loadIndex().set(conv.taskId, ConversationStore.summarize(conv));
      return { stored: true, duplicate: false };
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => {});
    return next;
  }
}

export const conversations = new ConversationStore();
