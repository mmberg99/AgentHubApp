/**
 * Conversation records: the USER-VISIBLE prompt/response text of a task.
 *
 * PRIVACY SCOPE (explicitly approved). These records carry the user's
 * submitted prompts and Claude's visible assistant responses, captured by the
 * Windows notifier from the UserPromptSubmit and Stop / SubagentStop hooks.
 * They never carry hidden reasoning, transcript contents, tool input/output,
 * commands, environment data, raw session/agent ids or paths: the notifier
 * reads exactly one approved payload key per hook and nothing else.
 *
 * DIRECTION. Windows is the source of truth. The relay stores the records
 * durably; the PWA only READS them, over the authenticated /api route, with
 * the same per-device capability token that guards /history. Nothing in this
 * module can send text back toward the PC.
 *
 * NEVER IN A PUSH. Conversation text is never placed in a Web Push payload;
 * lock-screen notifications keep their fixed generic vocabulary.
 *
 * DISPLAY. Message text is untrusted display text: rendered as plain text in a
 * <Text> element, never interpreted as HTML or markup.
 */

export interface ConversationMessage {
  messageId: string;
  taskId: string;
  subtaskId?: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  /** The sender cut the text at its cap. Shown to the user, never hidden. */
  truncated?: boolean;
}

export interface ConversationThread {
  messages: ConversationMessage[];
  /** Messages dropped from the start of this thread by the relay's cap. */
  trimmed: number;
  /** First user prompt's derived title (child threads only carry their own). */
  title?: string;
  agentType?: string;
}

/**
 * The collapsed card for one message, written on Windows.
 *
 * This is presentation metadata, never a replacement: the message it previews
 * is served unchanged beside it, and expanding a card always renders that
 * original text. A card may be absent for any reason at all, in which case the
 * app falls back to the local preview generator in `lib/messagePreview.ts`.
 *
 * Treated as untrusted display text like everything else from the wire: it is
 * rendered as plain text, so a URL inside a summary is not tappable.
 */
export interface MessageSummary {
  messageId: string;
  title: string;
  style: 'bullets' | 'paragraph';
  /** Set when `style` is 'paragraph'. */
  paragraph: string;
  /** Set when `style` is 'bullets'. Length is the writer's choice, not capped here. */
  bullets: string[];
}

export interface TaskConversation {
  taskId: string;
  /** Derived from the first main prompt on Windows; never rewritten. */
  title: string | null;
  updatedAt: string;
  thread: ConversationThread;
  /** subtaskId -> that child's own thread. Never merged into `thread`. */
  children: Record<string, ConversationThread>;
  /** messageId -> its card. Empty when summarisation is off or not done yet. */
  summaries: Record<string, MessageSummary>;
}

export interface ConversationSummary {
  taskId: string;
  title: string | null;
  messageCount: number;
  lastRole: 'user' | 'assistant' | null;
  updatedAt: string;
  children: Record<string, { title: string | null; messageCount: number }>;
}

const ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
export const MAX_MESSAGE_TEXT_CHARS = 24_000;
export const MAX_CONVERSATION_TITLE_CHARS = 80;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const isId = (v: unknown): v is string => typeof v === 'string' && ID_PATTERN.test(v);
const isIso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

function cleanTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_CONVERSATION_TITLE_CHARS);
  return t.length > 0 ? t : null;
}

/** Rebuilds one message from known fields only; anything else is dropped. */
export function parseConversationMessage(input: unknown): ConversationMessage | null {
  if (typeof input !== 'object' || input === null) return null;
  const m = input as Record<string, unknown>;
  if (!isId(m.messageId) || !isId(m.taskId)) return null;
  if (m.role !== 'user' && m.role !== 'assistant') return null;
  if (typeof m.text !== 'string') return null;
  const text = m.text.replace(CONTROL, '').slice(0, MAX_MESSAGE_TEXT_CHARS);
  if (text.trim().length === 0) return null;
  if (!isIso(m.timestamp)) return null;
  const out: ConversationMessage = {
    messageId: m.messageId,
    taskId: m.taskId,
    role: m.role,
    text,
    timestamp: new Date(m.timestamp).toISOString(),
  };
  if (isId(m.subtaskId)) out.subtaskId = m.subtaskId;
  if (m.truncated === true) out.truncated = true;
  return out;
}

function parseThread(input: unknown): ConversationThread {
  const thread: ConversationThread = { messages: [], trimmed: 0 };
  if (typeof input !== 'object' || input === null) return thread;
  const t = input as Record<string, unknown>;
  if (Array.isArray(t.messages)) {
    const seen = new Set<string>();
    for (const raw of t.messages) {
      const m = parseConversationMessage(raw);
      if (m && !seen.has(m.messageId)) {
        seen.add(m.messageId);
        thread.messages.push(m);
      }
    }
    thread.messages.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  }
  if (typeof t.trimmed === 'number' && t.trimmed > 0) thread.trimmed = Math.floor(t.trimmed);
  const title = cleanTitle(t.title);
  if (title) thread.title = title;
  const agentType = cleanTitle(t.agentType);
  if (agentType) thread.agentType = agentType.slice(0, 40);
  return thread;
}

const MAX_SUMMARY_TITLE = 80;
const MAX_SUMMARY_BULLET = 200;
const MAX_SUMMARY_PARAGRAPH = 600;

function cleanLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Rebuilds a card from known fields only; anything unusable becomes null. */
export function parseMessageSummary(input: unknown): MessageSummary | null {
  if (typeof input !== 'object' || input === null) return null;
  const s = input as Record<string, unknown>;
  if (!isId(s.messageId)) return null;
  if (s.style !== 'bullets' && s.style !== 'paragraph') return null;

  const title = cleanLine(s.title, MAX_SUMMARY_TITLE);
  if (title.length === 0) return null;

  const bullets = Array.isArray(s.bullets)
    ? s.bullets.map((b) => cleanLine(b, MAX_SUMMARY_BULLET)).filter((b) => b.length > 0)
    : [];
  const paragraph = cleanLine(s.paragraph, MAX_SUMMARY_PARAGRAPH);

  // A card must say something in the style it claims, or it is not a card.
  if (s.style === 'bullets' && bullets.length === 0) return null;
  if (s.style === 'paragraph' && paragraph.length === 0) return null;

  return {
    messageId: s.messageId,
    title,
    style: s.style,
    paragraph: s.style === 'paragraph' ? paragraph : '',
    bullets: s.style === 'bullets' ? bullets : [],
  };
}

/** Validates a `GET /conversation/<id>` body. Untrusted in, typed out. */
export function parseTaskConversation(input: unknown): TaskConversation | null {
  if (typeof input !== 'object' || input === null) return null;
  const c = input as Record<string, unknown>;
  if (!isId(c.taskId)) return null;
  const out: TaskConversation = {
    taskId: c.taskId,
    title: cleanTitle(c.title),
    updatedAt: isIso(c.updatedAt) ? new Date(c.updatedAt).toISOString() : new Date(0).toISOString(),
    thread: parseThread(c.thread),
    children: {},
    summaries: {},
  };
  if (typeof c.children === 'object' && c.children !== null) {
    for (const [id, child] of Object.entries(c.children as Record<string, unknown>)) {
      if (isId(id)) out.children[id] = parseThread(child);
    }
  }
  if (typeof c.summaries === 'object' && c.summaries !== null) {
    for (const [id, entry] of Object.entries(c.summaries as Record<string, unknown>)) {
      const summary = parseMessageSummary(entry);
      // The key must be the message the card belongs to; a mismatch is dropped
      // rather than risking a card shown against the wrong message.
      if (isId(id) && summary && summary.messageId === id) out.summaries[id] = summary;
    }
  }
  return out;
}

/** Validates one entry of a `GET /conversations` listing. */
export function parseConversationSummary(input: unknown): ConversationSummary | null {
  if (typeof input !== 'object' || input === null) return null;
  const s = input as Record<string, unknown>;
  if (!isId(s.taskId)) return null;
  const children: ConversationSummary['children'] = {};
  if (typeof s.children === 'object' && s.children !== null) {
    for (const [id, child] of Object.entries(s.children as Record<string, unknown>)) {
      if (!isId(id) || typeof child !== 'object' || child === null) continue;
      const ch = child as Record<string, unknown>;
      children[id] = {
        title: cleanTitle(ch.title),
        messageCount: typeof ch.messageCount === 'number' ? Math.max(0, Math.floor(ch.messageCount)) : 0,
      };
    }
  }
  return {
    taskId: s.taskId,
    title: cleanTitle(s.title),
    messageCount: typeof s.messageCount === 'number' ? Math.max(0, Math.floor(s.messageCount)) : 0,
    lastRole: s.lastRole === 'user' || s.lastRole === 'assistant' ? s.lastRole : null,
    updatedAt: isIso(s.updatedAt) ? new Date(s.updatedAt).toISOString() : new Date(0).toISOString(),
    children,
  };
}

/** The newest assistant message of the main thread, if any. */
export function latestAssistantMessage(conv: TaskConversation | undefined): ConversationMessage | null {
  if (!conv) return null;
  for (let i = conv.thread.messages.length - 1; i >= 0; i -= 1) {
    if (conv.thread.messages[i].role === 'assistant') return conv.thread.messages[i];
  }
  return null;
}
