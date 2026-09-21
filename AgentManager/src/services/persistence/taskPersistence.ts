import type { Subtask, Task, TaskMeta } from '../../types';

/**
 * Durable storage for the Project/Task layer and the user's own annotations.
 *
 * WHAT IS STORED (browser localStorage, key below)
 *   - task records: identity, PINNED project, ordinal, agent, status,
 *     timestamps, acceptedAt
 *   - subtask records: child activity (subagents) under a task
 *   - per-project task counters, so "Task N" numbering is monotonic and never
 *     reused after Accept or Forget
 *   - task metadata typed by the user: ChatGPT URL, prompt draft, custom title
 *   - tombstones from "Forget task"
 *
 * WHAT IS NEVER STORED
 *   - the VAPID private key, the relay token, any credential (they never reach
 *     this layer to begin with)
 *   - hook payloads, prompts, transcripts, agent ids or commands from Windows
 *     (the protocol carries none, so there is nothing to leak)
 *   - workspace paths (only the sender-derived projectName/projectId exist)
 *   - event history (Activity stays session-only; that is a separate,
 *     deliberate decision and this module does not change it)
 *
 * WHY localStorage
 *   This build targets the installed iPhone PWA, where localStorage persists
 *   across launches for the app's origin. It can still be empty or throw in
 *   private browsing or when site data is cleared, so every access is guarded
 *   and a failure degrades to "nothing accepted yet" rather than a crash. The
 *   push service already relies on it for the history cursor.
 *
 * Bounded: at most MAX_TASKS task records and MAX_SUBTASKS subtask records,
 * newest activity kept. Accepted tasks count toward the cap like any other.
 */

export const TASK_STORAGE_KEY = 'agenthub.tasks.v1';
export const TASK_STORAGE_VERSION = 1 as const;
export const MAX_TASKS = 300;
export const MAX_SUBTASKS = 1000;
/** How long a child with no parent yet is kept across reloads (7 days). */
export const UNRESOLVED_SUBTASK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_FORGOTTEN = 300;

export interface TaskStorageBlob {
  version: typeof TASK_STORAGE_VERSION;
  savedAt: string;
  tasks: Task[];
  meta: Record<string, TaskMeta>;
  /**
   * Tombstones for tasks the user chose to forget: task id -> ISO time.
   *
   * Relay history can re-deliver a task's old events (a cold resync after a
   * relay restart), which would otherwise quietly resurrect it. An event older
   * than the tombstone is ignored for task creation; a genuinely newer event
   * from that session creates the task again, exactly as Accept behaves.
   */
  forgotten?: Record<string, string>;
  /** Child activity (subagents) keyed under their parent task. */
  subtasks?: Subtask[];
  /** projectId -> highest task ordinal ever assigned in that project. */
  projectCounters?: Record<string, number>;
}

export interface TaskStorageState {
  tasks: Task[];
  meta: Record<string, TaskMeta>;
  forgotten: Record<string, string>;
  subtasks: Subtask[];
  projectCounters: Record<string, number>;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const VALID_STATUSES = new Set([
  'needs_approval',
  'needs_input',
  'running',
  'completed',
  'idle',
  'failed',
]);

const isIso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(new Date(v).getTime());

/** Rebuilds a task from known fields only; anything unexpected is dropped. */
function sanitizeTask(raw: unknown): Task | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const t = raw as Record<string, unknown>;
  if (
    typeof t.id !== 'string' ||
    typeof t.projectId !== 'string' ||
    typeof t.projectName !== 'string' ||
    typeof t.agentId !== 'string' ||
    typeof t.agentName !== 'string' ||
    typeof t.status !== 'string' ||
    !VALID_STATUSES.has(t.status) ||
    !isIso(t.createdAt) ||
    !isIso(t.updatedAt)
  ) {
    return null;
  }
  return {
    id: t.id,
    projectId: t.projectId,
    projectName: t.projectName,
    // 0 means "not yet assigned" — migrated below.
    ordinal: typeof t.ordinal === 'number' && Number.isInteger(t.ordinal) && t.ordinal > 0 ? t.ordinal : 0,
    agentId: t.agentId,
    agentName: t.agentName,
    provider:
      t.provider === 'openai' || t.provider === 'anthropic' || t.provider === 'google'
        ? t.provider
        : 'custom',
    status: t.status as Task['status'],
    title: typeof t.title === 'string' ? t.title : '',
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    lastRemoteEventAt: isIso(t.lastRemoteEventAt) ? t.lastRemoteEventAt : t.updatedAt,
    acceptedAt: isIso(t.acceptedAt) ? t.acceptedAt : null,
    origin: t.origin === 'simulated' ? 'simulated' : 'remote',
    escalatedBy: typeof t.escalatedBy === 'string' && t.escalatedBy.length <= 64 ? t.escalatedBy : null,
    autoTitle: typeof t.autoTitle === 'string' && t.autoTitle.length > 0 && t.autoTitle.length <= 80 ? t.autoTitle : null,
  };
}

function sanitizeSubtask(raw: unknown): Subtask | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Record<string, unknown>;
  if (
    typeof s.id !== 'string' ||
    typeof s.taskId !== 'string' ||
    typeof s.status !== 'string' ||
    !VALID_STATUSES.has(s.status) ||
    !isIso(s.createdAt) ||
    !isIso(s.updatedAt)
  ) {
    return null;
  }
  return {
    id: s.id,
    taskId: s.taskId,
    ordinal: typeof s.ordinal === 'number' && Number.isInteger(s.ordinal) && s.ordinal > 0 ? s.ordinal : 1,
    ...(typeof s.agentType === 'string' && s.agentType.length <= 40 ? { agentType: s.agentType } : {}),
    ...(typeof s.autoTitle === 'string' && s.autoTitle.length > 0 && s.autoTitle.length <= 80 ? { autoTitle: s.autoTitle } : {}),
    status: s.status as Subtask['status'],
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    lastRemoteEventAt: isIso(s.lastRemoteEventAt) ? s.lastRemoteEventAt : s.updatedAt,
    origin: s.origin === 'simulated' ? 'simulated' : 'remote',
  };
}

function sanitizeMeta(raw: unknown): TaskMeta | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const out: TaskMeta = {};
  if (typeof m.chatUrl === 'string' && m.chatUrl.length <= 2048) out.chatUrl = m.chatUrl;
  if (typeof m.promptDraft === 'string' && m.promptDraft.length <= 20000) {
    out.promptDraft = m.promptDraft;
  }
  if (typeof m.customTitle === 'string' && m.customTitle.length <= 120) {
    out.customTitle = m.customTitle;
  }
  return out;
}

/**
 * Assigns ordinals to tasks that predate numbering and reconciles counters.
 *
 * Tasks without an ordinal are numbered per project in creation order, after
 * any already-numbered tasks. Counters are raised to the highest ordinal seen
 * so a future task never reuses a number. A task whose title is the old
 * time-based default ("Session 14:32") is renamed to its "Task N" default;
 * a user's custom title lives in meta and is untouched.
 */
function migrateOrdinals(
  tasks: Task[],
  counters: Record<string, number>,
): { tasks: Task[]; counters: Record<string, number> } {
  const next = { ...counters };
  for (const t of tasks) {
    if (t.ordinal > 0) next[t.projectId] = Math.max(next[t.projectId] ?? 0, t.ordinal);
  }
  const unnumbered = tasks
    .filter((t) => t.ordinal === 0)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const assigned = new Map<string, number>();
  for (const t of unnumbered) {
    const ordinal = (next[t.projectId] ?? 0) + 1;
    next[t.projectId] = ordinal;
    assigned.set(t.id, ordinal);
  }
  const migrated = tasks.map((t) => {
    const ordinal = t.ordinal > 0 ? t.ordinal : (assigned.get(t.id) as number);
    const title = t.title === '' || /^Session \d{2}:\d{2}$/.test(t.title) ? `Task ${ordinal}` : t.title;
    return { ...t, ordinal, title };
  });
  return { tasks: migrated, counters: next };
}

/** Synchronous on purpose: the store reads this during its initial render. */
export function loadTaskStorage(): TaskStorageState {
  const empty: TaskStorageState = { tasks: [], meta: {}, forgotten: {}, subtasks: [], projectCounters: {} };
  const s = storage();
  if (!s) return empty;

  try {
    const raw = s.getItem(TASK_STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<TaskStorageBlob>;
    if (parsed.version !== TASK_STORAGE_VERSION) return empty;

    const rawTasks = Array.isArray(parsed.tasks)
      ? parsed.tasks.map(sanitizeTask).filter((t): t is Task => t !== null)
      : [];

    const rawCounters: Record<string, number> = {};
    if (typeof parsed.projectCounters === 'object' && parsed.projectCounters !== null) {
      for (const [pid, n] of Object.entries(parsed.projectCounters)) {
        if (typeof n === 'number' && Number.isInteger(n) && n >= 0) rawCounters[pid] = n;
      }
    }
    const { tasks, counters } = migrateOrdinals(rawTasks, rawCounters);
    const taskIds = new Set(tasks.map((t) => t.id));

    // Subtasks whose parent exists are kept. UNRESOLVED subtasks (parent not
    // yet seen) are kept too, so a reload cannot lose them — and they can
    // never become a task or project, because only a main-session event
    // creates those. An unresolved child that never finds its parent is
    // dropped after UNRESOLVED_SUBTASK_TTL_MS so the slice cannot grow
    // unbounded on a phone that missed a session's main events for good.
    const cutoff = Date.now() - UNRESOLVED_SUBTASK_TTL_MS;
    const subtasks = Array.isArray(parsed.subtasks)
      ? parsed.subtasks
          .map(sanitizeSubtask)
          .filter(
            (x): x is Subtask =>
              x !== null && (taskIds.has(x.taskId) || new Date(x.updatedAt).getTime() >= cutoff),
          )
      : [];

    const meta: Record<string, TaskMeta> = {};
    if (typeof parsed.meta === 'object' && parsed.meta !== null) {
      for (const [id, value] of Object.entries(parsed.meta)) {
        const clean = sanitizeMeta(value);
        if (clean && Object.keys(clean).length > 0) meta[id] = clean;
      }
    }

    const forgotten: Record<string, string> = {};
    if (typeof parsed.forgotten === 'object' && parsed.forgotten !== null) {
      for (const [id, at] of Object.entries(parsed.forgotten)) {
        if (isIso(at)) forgotten[id] = at;
      }
    }
    return { tasks, meta, forgotten, subtasks, projectCounters: counters };
  } catch {
    return empty;
  }
}

export function saveTaskStorage(
  tasks: Task[],
  meta: Record<string, TaskMeta>,
  forgotten: Record<string, string> = {},
  subtasks: Subtask[] = [],
  projectCounters: Record<string, number> = {},
): void {
  const s = storage();
  if (!s) return;

  // Never persist demo records; there are none any more, but the guard costs
  // nothing and keeps the contract explicit.
  const kept = tasks
    .filter((t) => t.origin === 'remote' || t.origin === 'simulated')
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, MAX_TASKS);
  const keptIds = new Set(kept.map((t) => t.id));

  // Children of kept tasks plus unresolved children (see loadTaskStorage).
  const keptSubtasks = subtasks
    .filter((x) => keptIds.has(x.taskId) || !tasks.some((t) => t.id === x.taskId))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, MAX_SUBTASKS);

  // Metadata for a task that fell off the cap goes with it.
  const keptMeta: Record<string, TaskMeta> = {};
  for (const [id, value] of Object.entries(meta)) {
    if (keptIds.has(id) && Object.keys(value).length > 0) keptMeta[id] = value;
  }

  // Newest tombstones win the cap. A tombstone for a task that still exists
  // is contradictory and dropped.
  const keptForgotten: Record<string, string> = {};
  for (const [id, at] of Object.entries(forgotten)
    .filter(([id]) => !keptIds.has(id))
    .sort((a, b) => new Date(b[1]).getTime() - new Date(a[1]).getTime())
    .slice(0, MAX_FORGOTTEN)) {
    keptForgotten[id] = at;
  }

  const blob: TaskStorageBlob = {
    version: TASK_STORAGE_VERSION,
    savedAt: new Date().toISOString(),
    tasks: kept,
    meta: keptMeta,
    forgotten: keptForgotten,
    subtasks: keptSubtasks,
    // Counters are never trimmed: a number, once used, is never reused.
    projectCounters,
  };

  try {
    s.setItem(TASK_STORAGE_KEY, JSON.stringify(blob));
  } catch {
    /* quota or private mode; in-memory state remains the truth */
  }
}

export function clearTaskStorage(): void {
  try {
    storage()?.removeItem(TASK_STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}
