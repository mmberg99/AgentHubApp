import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';

import {
  initialsFor,
  mapDomainEventType,
  mapProvider,
  mapStatus,
  parseAgentNotificationEvent,
  requiresUserAction,
  type AgentNotificationEvent,
  type ConversationSummary,
  type ParseResult,
  type TaskConversation,
} from '../protocol';
import { localId } from '../lib/time';
import {
  buildSnapshot,
  loadTaskStorage,
  migrateSnapshot,
  saveTaskStorage,
  sessionPersistence,
  type PersistedSnapshot,
  type PersistenceAdapter,
} from '../services/persistence';
import type {
  Agent,
  AgentEvent,
  AgentEventType,
  AgentStatus,
  ApprovalRequest,
  EventOrigin,
  EventSource,
  Subtask,
  Task,
  TaskMeta,
} from '../types';
import { ATTENTION_STATUSES } from '../types';
import { defaultTaskTitle, projectFor, taskIdFor } from './taskIdentity';
import {
  APPROVAL_POOL,
  COMPLETION_POOL,
  FAILURE_POOL,
  INPUT_POOL,
  MESSAGE_POOL,
  PROGRESS_POOL,
  TASK_POOL,
  pickAgent,
  pickOne,
} from './simulation';

export interface AgentState {
  agents: Agent[];
  events: AgentEvent[];
  approvals: ApprovalRequest[];
  /** Project/Task layer. Durable via localStorage; see `taskPersistence.ts`. */
  tasks: Task[];
  /** User-authored annotations keyed by task id. Durable. */
  taskMeta: Record<string, TaskMeta>;
  /** Tombstones from "Forget task": task id -> when. Durable. */
  forgottenTasks: Record<string, string>;
  /** Child activity (subagents) under tasks. Never top-level. Durable. */
  subtasks: Subtask[];
  /** projectId -> highest "Task N" ordinal ever assigned. Only grows. Durable. */
  projectCounters: Record<string, number>;
  /**
   * Conversation cache, keyed by task id. Windows is the source of truth;
   * this is a session cache filled from the relay's read-only routes.
   */
  conversations: Record<string, TaskConversation>;
}

type Action =
  | { type: 'approve'; approvalId: string }
  | { type: 'reject'; approvalId: string }
  | { type: 'answerInput'; agentId: string; answer: string }
  | { type: 'sendMessage'; agentId: string; message: string }
  | { type: 'markAgentRead'; agentId: string }
  | { type: 'markAllRead' }
  | { type: 'retryAgent'; agentId: string }
  | { type: 'simulateCompletion'; agentId?: string }
  | { type: 'simulateApproval'; agentId?: string }
  | { type: 'simulateMessage'; agentId?: string }
  | { type: 'simulateFailure'; agentId?: string }
  | { type: 'simulateStartTask'; agentId?: string }
  | { type: 'ingestRemoteEvent'; event: AgentNotificationEvent; source: EventSource }
  | { type: 'hydrate'; snapshot: PersistedSnapshot }
  | { type: 'acceptTask'; taskId: string }
  | { type: 'unacceptTask'; taskId: string }
  | { type: 'setTaskMeta'; taskId: string; patch: TaskMeta }
  | { type: 'forgetTask'; taskId: string }
  | { type: 'applyConversationSummaries'; summaries: ConversationSummary[] }
  | { type: 'setConversation'; conversation: TaskConversation }
  | { type: 'reset' };

/**
 * Empty by design. The app shows only real events and tasks; nothing is
 * seeded. Demo copy pools in `simulation.ts` remain available to the simulate
 * reducers below for development, but they never populate the UI on their own
 * — with no agents present, every simulate action is a no-op.
 */
const initialState: AgentState = {
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

/**
 * Restores the durable task layer synchronously on first render, so a history
 * sync that fires immediately after mount can never race an async hydrate and
 * re-create a task the user already accepted or forgotten.
 */
function initialStateFromStorage(): AgentState {
  const { tasks, meta, forgotten, subtasks, projectCounters } = loadTaskStorage();
  return {
    ...initialState,
    tasks,
    taskMeta: meta,
    forgottenTasks: forgotten,
    subtasks,
    projectCounters,
  };
}

/* ------------------------------------------------------------ task layer */

/** The durable Project/Task/Subtask slices, updated together by one event. */
interface TaskLayer {
  tasks: Task[];
  subtasks: Subtask[];
  projectCounters: Record<string, number>;
}

const ms = (iso: string): number => new Date(iso).getTime();

/**
 * Creates a task the first time a MAIN session is seen.
 *
 * The project is pinned here from the event and never refreshed afterwards,
 * and the task takes the next number in that project's counter. The counter
 * only ever grows, so Accept and Forget never cause renumbering and a number
 * is never reused.
 */
function createTask(
  layer: TaskLayer,
  incoming: AgentNotificationEvent,
  origin: EventOrigin,
  status: AgentStatus,
  escalatedBy: string | null = null,
): TaskLayer {
  const project = projectFor(incoming);
  const ordinal = (layer.projectCounters[project.id] ?? 0) + 1;
  const at = incoming.timestamp;
  const task: Task = {
    id: taskIdFor(incoming),
    projectId: project.id,
    projectName: project.name,
    ordinal,
    agentId: incoming.agentId,
    agentName: incoming.agentName,
    provider: mapProvider(incoming.provider),
    status,
    title: defaultTaskTitle(ordinal),
    createdAt: at,
    updatedAt: at,
    lastRemoteEventAt: at,
    acceptedAt: null,
    origin,
    escalatedBy,
  };
  return {
    ...layer,
    tasks: [task, ...layer.tasks],
    projectCounters: { ...layer.projectCounters, [project.id]: ordinal },
  };
}

/**
 * A MAIN-session event: finds or creates the Task and drives its lifecycle.
 *
 * Only main-session events reach here (subagent events go through
 * `applySubtaskEvent`), so only the main session can mark a task completed,
 * idle, running or failed on its own account.
 *
 * The stale rule mirrors the agent rule: an event older than the newest one
 * already applied to this task is history only and changes nothing. Ties
 * apply. Project identity is NOT refreshed on later events: it was pinned at
 * creation from the session's launch directory.
 *
 * ACCEPT RULE: a task the user accepted stays accepted through replays and
 * late arrivals, but a genuinely NEW event — newer than `acceptedAt` — means
 * the agent did more work, so the task comes back to the active list. That is
 * the intended flow for a follow-up turn on a session that was already signed
 * off.
 */
function applyMainEvent(
  layer: TaskLayer,
  incoming: AgentNotificationEvent,
  origin: EventOrigin,
): TaskLayer {
  const id = taskIdFor(incoming);
  const status = mapStatus(incoming.type);
  const at = incoming.timestamp;
  const existing = layer.tasks.find((t) => t.id === id);

  if (!existing) {
    // First main-session event: THIS is what establishes the project. Any
    // children held unresolved for this parent are already keyed by its id
    // and become visible now. If one of them is waiting on the user and is
    // newer than this event, the parent starts out escalated.
    const created = createTask(layer, incoming, origin, status);
    if (isAttention(status)) return created;
    const waiting = created.subtasks
      .filter((s) => s.taskId === id && isAttention(s.status) && ms(s.lastRemoteEventAt) >= ms(at))
      .sort((a, b) => ms(b.lastRemoteEventAt) - ms(a.lastRemoteEventAt))[0];
    if (!waiting) return created;
    return {
      ...created,
      tasks: created.tasks.map((t) =>
        t.id === id ? { ...t, status: waiting.status, escalatedBy: waiting.id } : t,
      ),
    };
  }

  const incomingMs = ms(at);
  if (incomingMs < ms(existing.lastRemoteEventAt)) return layer;

  const reactivate = existing.acceptedAt !== null && incomingMs > ms(existing.acceptedAt);

  return {
    ...layer,
    tasks: layer.tasks.map((t) =>
      t.id === id
        ? {
            ...t,
            status,
            // The main session spoke: whatever a child had raised is superseded.
            escalatedBy: null,
            agentName: incoming.agentName,
            updatedAt: at,
            lastRemoteEventAt: at,
            acceptedAt: reactivate ? null : t.acceptedAt,
            // Once a real event has touched a task it is a real task.
            origin: origin === 'remote' ? 'remote' : t.origin,
          }
        : t,
    ),
  };
}

const isAttention = (status: AgentStatus): boolean => ATTENTION_STATUSES.includes(status);

/**
 * A SUBAGENT event: child activity under the parent task named by `taskId`.
 *
 * WHAT IT NEVER DOES
 *   - create a task or a project. THE PROJECT BELONGS TO THE MAIN SESSION: a
 *     subagent may run in another directory, so nothing a child event says
 *     (it carries no project fields; even if one did, it is ignored) can
 *     establish or move the parent's project. An unseen parent is NOT
 *     created; the child is held unresolved, keyed by the parent task id,
 *     invisible on Home and in Summary, until the main session's first event
 *     creates the parent — at which point the child is already underneath it.
 *   - complete, idle or otherwise drive the parent's own lifecycle
 *   - advance the parent's `lastRemoteEventAt`, so the parent's own stale
 *     rule keeps working on the main session's clock
 *
 * WHAT IT DOES
 *   - upserts the subtask record (numbered within the parent; its own stale
 *     rule)
 *   - ESCALATES: a child in needs_approval / needs_input / failed marks the
 *     parent Needs action too (`escalatedBy` = the child), since the user
 *     has to respond on Windows either way. Only when the child event is
 *     newer than the parent's own last event, so a parent that has since
 *     moved on is not dragged back; and never over a red the main session
 *     raised itself.
 *   - CLEARS its escalation: when the escalating child leaves an attention
 *     state, another waiting child takes over, or the parent returns to
 *     Running. A red set by the main session is left alone.
 *   - bumps the parent's `updatedAt` and re-activates an accepted parent on
 *     genuinely newer activity, exactly as a main event would
 */
function applySubtaskEvent(
  layer: TaskLayer,
  incoming: AgentNotificationEvent,
  origin: EventOrigin,
): TaskLayer {
  const subtaskId = incoming.subtaskId as string;
  const parentId = taskIdFor(incoming);
  const status = mapStatus(incoming.type);
  const at = incoming.timestamp;
  const atMs = ms(at);

  const next = layer;
  // May be undefined: the main session has not spoken yet. The child is then
  // held unresolved below and no task, project or ordinal is created.
  const parent = next.tasks.find((t) => t.id === parentId);

  const existingSub = next.subtasks.find((s) => s.id === subtaskId);
  if (existingSub && atMs < ms(existingSub.lastRemoteEventAt)) return next;

  let subtasks: Subtask[];
  if (!existingSub) {
    const ordinal =
      next.subtasks
        .filter((s) => s.taskId === parentId)
        .reduce((max, s) => Math.max(max, s.ordinal), 0) + 1;
    const subtask: Subtask = {
      id: subtaskId,
      taskId: parentId,
      ordinal,
      ...(incoming.agentType ? { agentType: incoming.agentType } : {}),
      status,
      createdAt: at,
      updatedAt: at,
      lastRemoteEventAt: at,
      origin,
    };
    subtasks = [subtask, ...next.subtasks];
  } else {
    subtasks = next.subtasks.map((s) =>
      s.id === subtaskId
        ? {
            ...s,
            status,
            // A subagent's type is fixed for its life; keep the first one seen.
            ...(!s.agentType && incoming.agentType ? { agentType: incoming.agentType } : {}),
            updatedAt: at,
            lastRemoteEventAt: at,
            origin: origin === 'remote' ? 'remote' : s.origin,
          }
        : s,
    );
  }

  // Unresolved parent: hold the child and stop here. Nothing else changes.
  if (!parent) return { ...next, subtasks };

  // Parent effects.
  const newerThanParentEvent = atMs >= ms(parent.lastRemoteEventAt);
  const ownRed = isAttention(parent.status) && !parent.escalatedBy;

  let parentStatus = parent.status;
  let escalatedBy: string | null = parent.escalatedBy ?? null;
  if (newerThanParentEvent && isAttention(status) && !ownRed) {
    parentStatus = status;
    escalatedBy = subtaskId;
  } else if (escalatedBy === subtaskId && !isAttention(status)) {
    // The child that had raised the parent's red has moved on.
    const sibling = subtasks.find(
      (s) => s.taskId === parentId && s.id !== subtaskId && isAttention(s.status),
    );
    parentStatus = sibling ? sibling.status : 'running';
    escalatedBy = sibling ? sibling.id : null;
  }

  const reactivate = parent.acceptedAt !== null && atMs > ms(parent.acceptedAt);

  return {
    ...next,
    subtasks,
    tasks: next.tasks.map((t) =>
      t.id === parentId
        ? {
            ...t,
            status: parentStatus,
            escalatedBy,
            updatedAt: atMs > ms(t.updatedAt) ? at : t.updatedAt,
            acceptedAt: reactivate ? null : t.acceptedAt,
            origin: origin === 'remote' ? 'remote' : t.origin,
          }
        : t,
    ),
  };
}

/** Routes an event to the main-task or subtask path by its scope marker. */
function applyToTaskLayer(
  layer: TaskLayer,
  incoming: AgentNotificationEvent,
  origin: EventOrigin,
): TaskLayer {
  return incoming.subtaskId
    ? applySubtaskEvent(layer, incoming, origin)
    : applyMainEvent(layer, incoming, origin);
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Builds an event and returns it alongside the timestamp used. */
function makeEvent(
  agentId: string,
  type: AgentEventType,
  message: string,
  options: { requiresAction?: boolean; approvalId?: string } = {},
): AgentEvent {
  return {
    id: localId('evt'),
    agentId,
    type,
    message,
    timestamp: nowIso(),
    requiresAction: options.requiresAction ?? false,
    read: false,
    approvalId: options.approvalId,
  };
}

function updateAgent(
  agents: Agent[],
  agentId: string,
  patch: Partial<Agent>,
): Agent[] {
  return agents.map((agent) =>
    agent.id === agentId ? { ...agent, ...patch, lastUpdated: nowIso() } : agent,
  );
}

/** Adds an event and bumps the owning agent unread counter when relevant. */
function withEvent(state: AgentState, event: AgentEvent, patch: Partial<Agent>): AgentState {
  const agent = state.agents.find((a) => a.id === event.agentId);
  const unread = agent ? agent.unread + 1 : 1;
  return {
    ...state,
    // `unread` first so an explicit value in `patch` still wins.
    agents: updateAgent(state.agents, event.agentId, { unread, ...patch }),
    events: [...state.events, event],
  };
}

/**
 * Chooses the target for a simulated event: an explicit id when the user tapped
 * an agent-specific control, otherwise a plausible candidate.
 */
function resolveTarget(
  state: AgentState,
  agentId: string | undefined,
  prefer: (agent: Agent) => boolean,
): Agent | null {
  if (agentId) return state.agents.find((a) => a.id === agentId) ?? null;
  return pickAgent(state.agents, prefer);
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

/**
 * Applies derived titles from conversation summaries to existing tasks and
 * subtasks. First title wins and is never replaced; a manual rename (in
 * TaskMeta) is untouched because it lives elsewhere and takes precedence at
 * display time. Returns the same state object when nothing changed.
 */
function withTitles(state: AgentState, byTask: Map<string, ConversationSummary>): AgentState {
  let tasks = state.tasks;
  let subtasks = state.subtasks;
  let changed = false;
  tasks = tasks.map((t) => {
    const s = byTask.get(t.id);
    if (!s || !s.title || t.autoTitle) return t;
    changed = true;
    return { ...t, autoTitle: s.title };
  });
  subtasks = subtasks.map((x) => {
    const child = byTask.get(x.taskId)?.children[x.id];
    if (!child || !child.title || x.autoTitle) return x;
    changed = true;
    return { ...x, autoTitle: child.title };
  });
  return changed ? { ...state, tasks, subtasks } : state;
}

export function agentReducer(state: AgentState, action: Action): AgentState {
  switch (action.type) {
    case 'approve':
    case 'reject': {
      const approval = state.approvals.find((a) => a.id === action.approvalId);
      if (!approval || approval.status !== 'pending') return state;

      const approved = action.type === 'approve';
      const resolvedAt = nowIso();
      const approvals = state.approvals.map((a) =>
        a.id === approval.id
          ? { ...a, status: approved ? ('approved' as const) : ('rejected' as const), resolvedAt }
          : a,
      );

      // The originating request no longer demands action.
      const events = state.events.map((e) =>
        e.approvalId === approval.id ? { ...e, requiresAction: false, read: true } : e,
      );

      const followUp = makeEvent(
        approval.agentId,
        approved ? 'approved' : 'rejected',
        approved
          ? `Approved: ${approval.title}. Continuing the task.`
          : `Rejected: ${approval.title}. I stopped and left everything unchanged.`,
      );

      // Approving resumes work; rejecting parks the agent as completed.
      const nextStatus: AgentStatus = approved ? 'running' : 'completed';
      const agentStillBlocked = approvals.some(
        (a) => a.agentId === approval.agentId && a.status === 'pending',
      );

      return {
        ...state,
        approvals,
        events: [...events, { ...followUp, read: true }],
        agents: updateAgent(state.agents, approval.agentId, {
          status: agentStillBlocked ? 'needs_approval' : nextStatus,
          startedAt: approved ? nowIso() : null,
        }),
      };
    }

    case 'answerInput': {
      const events = state.events.map((e) =>
        e.agentId === action.agentId && e.type === 'input_request'
          ? { ...e, requiresAction: false, read: true }
          : e,
      );
      const reply = makeEvent(action.agentId, 'message', action.answer);
      const ack = makeEvent(
        action.agentId,
        'progress',
        'Got it — picking the task back up now.',
      );
      return {
        ...state,
        events: [...events, { ...reply, read: true }, { ...ack, read: true }],
        agents: updateAgent(state.agents, action.agentId, {
          status: 'running',
          startedAt: nowIso(),
        }),
      };
    }

    case 'sendMessage': {
      const event = makeEvent(action.agentId, 'message', action.message);
      return {
        ...state,
        events: [...state.events, { ...event, read: true }],
        agents: updateAgent(state.agents, action.agentId, {}),
      };
    }

    case 'markAgentRead':
      return {
        ...state,
        agents: state.agents.map((a) =>
          a.id === action.agentId ? { ...a, unread: 0 } : a,
        ),
        events: state.events.map((e) =>
          e.agentId === action.agentId ? { ...e, read: true } : e,
        ),
      };

    case 'markAllRead':
      return {
        ...state,
        agents: state.agents.map((a) => ({ ...a, unread: 0 })),
        events: state.events.map((e) => ({ ...e, read: true })),
      };

    case 'retryAgent': {
      const event = makeEvent(action.agentId, 'started', 'Retrying the failed run.');
      return withEvent(state, { ...event, read: true }, {
        status: 'running',
        startedAt: nowIso(),
        unread: 0,
      });
    }

    case 'simulateStartTask': {
      const target = resolveTarget(state, action.agentId, (a) =>
        a.status === 'idle' || a.status === 'completed',
      );
      if (!target) return state;
      const task = pickOne(TASK_POOL);
      const event = makeEvent(target.id, 'started', `Started: ${task}`);
      return withEvent(state, event, {
        status: 'running',
        currentTask: task,
        startedAt: nowIso(),
      });
    }

    case 'simulateMessage': {
      const target = resolveTarget(state, action.agentId, (a) => a.status === 'running');
      if (!target) return state;
      const pool = target.status === 'running' ? MESSAGE_POOL : PROGRESS_POOL;
      const event = makeEvent(target.id, 'message', pickOne(pool));
      return withEvent(state, event, {});
    }

    case 'simulateCompletion': {
      const target = resolveTarget(state, action.agentId, (a) => a.status === 'running');
      if (!target) return state;
      const event = makeEvent(target.id, 'completed', pickOne(COMPLETION_POOL));
      return withEvent(state, event, {
        status: 'completed',
        startedAt: null,
        // An idle agent may be chosen as a fallback; give it a task so the
        // completed entry reads coherently instead of "No active task".
        currentTask: target.currentTask ?? pickOne(TASK_POOL),
      });
    }

    case 'simulateFailure': {
      const target = resolveTarget(state, action.agentId, (a) => a.status === 'running');
      if (!target) return state;
      const event = makeEvent(target.id, 'failed', pickOne(FAILURE_POOL), {
        requiresAction: true,
      });
      return withEvent(state, event, {
        status: 'failed',
        startedAt: null,
        currentTask: target.currentTask ?? pickOne(TASK_POOL),
      });
    }

    case 'simulateApproval': {
      const target = resolveTarget(
        state,
        action.agentId,
        (a) => a.status === 'running' || a.status === 'idle',
      );
      if (!target) return state;

      const template = pickOne(APPROVAL_POOL);
      const approval: ApprovalRequest = {
        id: localId('apr'),
        agentId: target.id,
        title: template.title,
        description: template.description,
        status: 'pending',
        createdAt: nowIso(),
      };
      const event = makeEvent(target.id, 'approval_request', template.message, {
        requiresAction: true,
        approvalId: approval.id,
      });

      const next = withEvent(state, event, { status: 'needs_approval' });
      return { ...next, approvals: [...next.approvals, approval] };
    }

    /**
     * Ingests one validated event from a real or simulated transport.
     *
     * DUPLICATE RULE
     *   Identity is `eventId`, namespaced to `remote_<eventId>`. If an event
     *   with that id already exists the action is a no-op: no second Activity
     *   row, no unread increment, no extra agent. Idempotent regardless of how
     *   many times a transport redelivers it.
     *
     * ORDERING RULE (deterministic, no wall-clock reads)
     *   Each agent records `lastRemoteEventAt` — the timestamp of the newest
     *   event already APPLIED to its status.
     *     - incoming.timestamp >= lastRemoteEventAt  ->  apply to status.
     *       Ties apply, so receive order breaks equal timestamps.
     *     - incoming.timestamp <  lastRemoteEventAt  ->  STALE. Recorded in
     *       Activity for the audit trail, flagged `stale`, but it does NOT
     *       change status, task, or attention, and does not bump unread. Its
     *       `requiresAction` is cleared because a newer event has superseded it.
     *   So a 12:01 "running" arriving after a 12:05 "completed" leaves the
     *   agent Completed.
     *
     * SESSION RULE
     *   'completed' is not terminal. A later 'started' makes the agent Running
     *   again with a fresh `startedAt`. A 'running' update keeps the existing
     *   `startedAt`. A changed `taskId` also begins a new session.
     */
    case 'ingestRemoteEvent': {
      const incoming = action.event;
      const origin: EventOrigin = action.source === 'simulated' ? 'simulated' : 'remote';

      // Prefixed so a remote id can never collide with a locally generated one.
      const eventId = `remote_${incoming.eventId}`;
      if (state.events.some((e) => e.id === eventId)) return state;

      const status = mapStatus(incoming.type);
      const existing = state.agents.find((a) => a.id === incoming.agentId);

      // Stale only ever relative to what has already been applied.
      const appliedAt = existing?.lastRemoteEventAt ?? null;
      const isStale =
        appliedAt !== null &&
        new Date(incoming.timestamp).getTime() < new Date(appliedAt).getTime();

      // The Task layer is updated on every accepted event, stale or not, and
      // applies its own stale rule internally. Doing it once here means all
      // three return paths below carry it.
      //
      // FORGET RULE: a tombstone left by "Forget task" blocks re-creation from
      // events no newer than the moment of forgetting (typically a history
      // replay). A genuinely newer event means the session did more work, so
      // the tombstone is cleared and the task comes back — mirroring Accept.
      const incomingTaskId = taskIdFor(incoming);
      const tombstone = state.forgottenTasks[incomingTaskId];
      const blockedByTombstone =
        tombstone !== undefined &&
        new Date(incoming.timestamp).getTime() <= new Date(tombstone).getTime();

      let forgottenTasks = state.forgottenTasks;
      if (tombstone !== undefined && !blockedByTombstone) {
        forgottenTasks = { ...state.forgottenTasks };
        delete forgottenTasks[incomingTaskId];
      }
      const layer: TaskLayer = {
        tasks: state.tasks,
        subtasks: state.subtasks,
        projectCounters: state.projectCounters,
      };
      const { tasks, subtasks, projectCounters } = blockedByTombstone
        ? layer
        : applyToTaskLayer(layer, incoming, origin);

      const event: AgentEvent = {
        id: eventId,
        agentId: incoming.agentId,
        type: mapDomainEventType(incoming.type),
        message: incoming.message,
        timestamp: incoming.timestamp,
        // A superseded event cannot still demand action.
        requiresAction: isStale ? false : requiresUserAction(incoming.type),
        read: isStale,
        origin,
        // The RESOLVED task id, so a task's timeline is a simple filter even
        // for senders that supplied none (they fall back per taskIdentity.ts).
        taskId: taskIdFor(incoming),
        ...(incoming.subtaskId ? { subtaskId: incoming.subtaskId } : {}),
        ...(isStale ? { stale: true as const } : {}),
      };

      const withLayer = { ...state, tasks, subtasks, projectCounters, forgottenTasks };

      if (!existing) {
        // First contact with this agentId. agentId is the stable identity, so
        // agents are never merged by name: two tools reporting "Claude Code"
        // under different ids stay separate.
        const agent: Agent = {
          id: incoming.agentId,
          name: incoming.agentName,
          provider: mapProvider(incoming.provider),
          account: 'windows-pc',
          status,
          currentTask: incoming.title,
          startedAt: status === 'running' ? incoming.timestamp : null,
          lastUpdated: incoming.timestamp,
          unread: 1,
          avatar: initialsFor(incoming.agentName),
          origin,
          currentTaskId: incoming.taskId ?? null,
          lastRemoteEventAt: incoming.timestamp,
        };
        return {
          ...withLayer,
          agents: [agent, ...state.agents],
          events: [...state.events, event],
        };
      }

      if (isStale) {
        // History only: the agent row is left exactly as it is.
        return { ...withLayer, events: [...state.events, event] };
      }

      if (incoming.subtaskId) {
        // Subagent activity never drives the agent row's lifecycle either:
        // only a child that needs the user is surfaced on it, exactly as on
        // the parent task above.
        return withEvent(
          withLayer,
          event,
          isAttention(status) ? { status, lastRemoteEventAt: incoming.timestamp } : {},
        );
      }

      // A new task id, or an explicit 'started', begins a fresh session.
      const newSession =
        incoming.type === 'started' ||
        (incoming.taskId !== undefined && incoming.taskId !== existing.currentTaskId);

      const startedAt =
        status === 'running'
          ? newSession
            ? incoming.timestamp
            : (existing.startedAt ?? incoming.timestamp)
          : null;

      return withEvent(withLayer, event, {
        status,
        currentTask: incoming.title,
        startedAt,
        origin,
        currentTaskId: incoming.taskId ?? existing.currentTaskId ?? null,
        lastRemoteEventAt: incoming.timestamp,
      });
    }

    /**
     * Accept archives a FINISHED task: it leaves Home and the active counts and
     * appears in Summary. Nothing is deleted — events, metadata and the task
     * record all remain. Reversible with `unacceptTask`.
     */
    case 'acceptTask': {
      const at = nowIso();
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          t.id === action.taskId && t.acceptedAt === null ? { ...t, acceptedAt: at } : t,
        ),
      };
    }

    case 'unacceptTask':
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          t.id === action.taskId ? { ...t, acceptedAt: null } : t,
        ),
      };

    /**
     * Forget removes ONE task from this device: its record, its metadata (chat
     * link, prompt draft, custom title) and its accepted state, and leaves a
     * tombstone so a history replay cannot bring it back. It touches nothing
     * else — not events, not push state, not other tasks — and deletes nothing
     * on Claude or Windows.
     */
    case 'forgetTask': {
      if (!state.tasks.some((t) => t.id === action.taskId)) return state;
      const taskMeta = { ...state.taskMeta };
      delete taskMeta[action.taskId];
      return {
        ...state,
        tasks: state.tasks.filter((t) => t.id !== action.taskId),
        // A task's subagents go with it; they have no life of their own.
        subtasks: state.subtasks.filter((s) => s.taskId !== action.taskId),
        taskMeta,
        forgottenTasks: { ...state.forgottenTasks, [action.taskId]: nowIso() },
        // The phone's cached conversation goes too. Windows keeps its copy:
        // Forget is local-only by design.
        conversations: omitKey(state.conversations, action.taskId),
        // Counters are deliberately untouched: the number is never reused.
      };
    }

    /**
     * Titles from Windows. A task's derived title is applied ONCE (first prompt
     * wins, and the relay never changes it either); a child's likewise. Nothing
     * here creates a task or subtask: unknown ids are ignored.
     */
    case 'applyConversationSummaries': {
      const byTask = new Map(action.summaries.map((s) => [s.taskId, s]));
      return withTitles(state, byTask);
    }

    case 'setConversation': {
      const conv = action.conversation;
      const summary: ConversationSummary = {
        taskId: conv.taskId,
        title: conv.title,
        messageCount: conv.thread.messages.length,
        lastRole: null,
        updatedAt: conv.updatedAt,
        children: Object.fromEntries(
          Object.entries(conv.children).map(([id, t]) => [id, { title: t.title ?? null, messageCount: t.messages.length }]),
        ),
      };
      const next = withTitles(state, new Map([[conv.taskId, summary]]));
      return { ...next, conversations: { ...next.conversations, [conv.taskId]: conv } };
    }

    /** Merges user-authored fields. An empty string removes a field. */
    case 'setTaskMeta': {
      // Metadata belongs to a task; never create an orphan entry (for example
      // from a debounced draft save that lands after the task was forgotten).
      if (!state.tasks.some((t) => t.id === action.taskId)) return state;
      const current = state.taskMeta[action.taskId] ?? {};
      const next: TaskMeta = { ...current };
      for (const key of ['chatUrl', 'promptDraft', 'customTitle'] as const) {
        if (!(key in action.patch)) continue;
        const value = action.patch[key];
        if (value === undefined || value === '') delete next[key];
        else next[key] = value;
      }
      return { ...state, taskMeta: { ...state.taskMeta, [action.taskId]: next } };
    }

    /**
     * Restores persisted records.
     *
     * A snapshot holds only REMOTE records (see `snapshotSchema.ts`), so this
     * merges them onto freshly generated mock data rather than replacing state.
     * Persisted records win on id collision. Because history carries `eventId`,
     * restoring it also restores duplicate suppression across restarts.
     */
    case 'hydrate': {
      const persistedAgentIds = new Set(action.snapshot.agents.map((a) => a.id));
      const persistedEventIds = new Set(action.snapshot.events.map((e) => e.id));

      return {
        ...state,
        agents: [
          ...action.snapshot.agents,
          ...state.agents.filter((a) => !persistedAgentIds.has(a.id)),
        ],
        events: [
          ...state.events.filter((e) => !persistedEventIds.has(e.id)),
          ...action.snapshot.events,
        ],
        approvals: state.approvals,
      };
    }

    // Clears session state only. The durable task layer (accepted work, chat
    // links, drafts) is the user's, and a session reset must not destroy it.
    case 'reset':
      return {
        ...initialState,
        tasks: state.tasks,
        taskMeta: state.taskMeta,
        forgottenTasks: state.forgottenTasks,
        subtasks: state.subtasks,
        projectCounters: state.projectCounters,
      };

    default:
      return state;
  }
}

/** Also simulated locally: an agent asking the user a question. */
function simulateInputRequest(state: AgentState, agentId?: string): AgentState {
  const target = resolveTarget(state, agentId, (a) => a.status === 'running');
  if (!target) return state;
  const event = makeEvent(target.id, 'input_request', pickOne(INPUT_POOL), {
    requiresAction: true,
  });
  return withEvent(state, event, { status: 'needs_input' });
}

interface AgentStoreValue extends AgentState {
  approve: (approvalId: string) => void;
  reject: (approvalId: string) => void;
  answerInput: (agentId: string, answer: string) => void;
  sendMessage: (agentId: string, message: string) => void;
  markAgentRead: (agentId: string) => void;
  markAllRead: () => void;
  retryAgent: (agentId: string) => void;
  simulate: (
    kind: 'completion' | 'approval' | 'message' | 'failure' | 'startTask' | 'input',
    agentId?: string,
  ) => void;
  /**
   * Entry point for events arriving from outside the device.
   *
   * Takes `unknown` on purpose: validation happens here, so no caller can
   * insert unvalidated data into state. `source` decides whether the record is
   * labelled a real remote event or a simulated one. Returns the parse result
   * so the caller can report rejections.
   */
  ingestRemoteEvent: (raw: unknown, source?: EventSource) => ParseResult;
  /** True when agent history is lost on reload. Surfaced in Settings. */
  historyIsDurable: boolean;
  reset: () => void;
  /** Archive a finished task into Summary. Never deletes. */
  acceptTask: (taskId: string) => void;
  /** Bring an accepted task back to the active list. */
  unacceptTask: (taskId: string) => void;
  /** Save user-authored task fields (chat link, prompt draft, custom title). */
  setTaskMeta: (taskId: string, patch: TaskMeta) => void;
  /** Remove one task and its metadata from this device. Nothing else. */
  forgetTask: (taskId: string) => void;
  /** Titles + counts from the relay (never text). Applied once per task. */
  applyConversationSummaries: (summaries: ConversationSummary[]) => void;
  /** One task's full user-visible conversation, fetched from the relay. */
  setConversation: (conversation: TaskConversation) => void;
}

const AgentStoreContext = createContext<AgentStoreValue | null>(null);

/** Wraps the reducer so the input-request case can live outside the switch. */
function rootReducer(
  state: AgentState,
  action: Action | { type: 'simulateInput'; agentId?: string },
): AgentState {
  if (action.type === 'simulateInput') {
    return simulateInputRequest(state, action.agentId);
  }
  return agentReducer(state, action);
}

interface AgentStoreProviderProps {
  children: React.ReactNode;
  /**
   * Swap in a durable adapter to make history survive reloads. Defaults to
   * session-only, which loses everything on reload — see `historyIsDurable`.
   */
  persistence?: PersistenceAdapter;
}

export function AgentStoreProvider({
  children,
  persistence = sessionPersistence,
}: AgentStoreProviderProps) {
  // Lazy initialiser: the durable task layer is read synchronously from
  // localStorage before the first render (see `initialStateFromStorage`).
  const [state, dispatch] = useReducer(rootReducer, undefined, initialStateFromStorage);
  const hydrated = useRef(false);

  // Persist the task layer whenever it changes. Debounced like the session
  // snapshot below; writes are tiny and bounded (see `taskPersistence.ts`).
  useEffect(() => {
    const handle = setTimeout(
      () =>
        saveTaskStorage(
          state.tasks,
          state.taskMeta,
          state.forgottenTasks,
          state.subtasks,
          state.projectCounters,
        ),
      250,
    );
    return () => clearTimeout(handle);
  }, [state.tasks, state.taskMeta, state.forgottenTasks, state.subtasks, state.projectCounters]);

  // Restore once on mount. A no-op with session-only persistence on a cold
  // start, and the seam a durable adapter will use unchanged.
  useEffect(() => {
    let cancelled = false;
    void persistence
      .load()
      .then((raw) => {
        if (cancelled) return;
        // Migration decides whether a stored snapshot is usable; an unknown
        // version is discarded rather than risking corrupt state.
        const snapshot = migrateSnapshot(raw);
        if (snapshot) dispatch({ type: 'hydrate', snapshot });
      })
      .catch(() => {
        // A failed restore must never block startup; mock data stands in.
      })
      .finally(() => {
        hydrated.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [persistence]);

  // Persist after changes settle. Skipped until the initial load resolves so a
  // cold-start snapshot cannot overwrite restored data.
  useEffect(() => {
    if (!hydrated.current) return;
    const handle = setTimeout(() => {
      // `buildSnapshot` applies the persist allow-list: remote records only,
      // no credentials, bounded history.
      void persistence
        .save(buildSnapshot(state))
        .catch(() => {
          // Persistence is best-effort; the in-memory store remains the truth.
        });
    }, 400);
    return () => clearTimeout(handle);
  }, [persistence, state]);

  const simulate = useCallback<AgentStoreValue['simulate']>((kind, agentId) => {
    switch (kind) {
      case 'completion':
        return dispatch({ type: 'simulateCompletion', agentId });
      case 'approval':
        return dispatch({ type: 'simulateApproval', agentId });
      case 'message':
        return dispatch({ type: 'simulateMessage', agentId });
      case 'failure':
        return dispatch({ type: 'simulateFailure', agentId });
      case 'startTask':
        return dispatch({ type: 'simulateStartTask', agentId });
      case 'input':
        return dispatch({ type: 'simulateInput', agentId });
    }
  }, []);

  const ingestRemoteEvent = useCallback(
    (raw: unknown, source: EventSource = 'bridge'): ParseResult => {
      const result = parseAgentNotificationEvent(raw);
      if (result.ok) dispatch({ type: 'ingestRemoteEvent', event: result.event, source });
      return result;
    },
    [],
  );

  const value = useMemo<AgentStoreValue>(
    () => ({
      ...state,
      approve: (approvalId) => dispatch({ type: 'approve', approvalId }),
      reject: (approvalId) => dispatch({ type: 'reject', approvalId }),
      answerInput: (agentId, answer) => dispatch({ type: 'answerInput', agentId, answer }),
      sendMessage: (agentId, message) => dispatch({ type: 'sendMessage', agentId, message }),
      markAgentRead: (agentId) => dispatch({ type: 'markAgentRead', agentId }),
      markAllRead: () => dispatch({ type: 'markAllRead' }),
      retryAgent: (agentId) => dispatch({ type: 'retryAgent', agentId }),
      simulate,
      ingestRemoteEvent,
      historyIsDurable: persistence.durable,
      reset: () => dispatch({ type: 'reset' }),
      acceptTask: (taskId) => dispatch({ type: 'acceptTask', taskId }),
      unacceptTask: (taskId) => dispatch({ type: 'unacceptTask', taskId }),
      setTaskMeta: (taskId, patch) => dispatch({ type: 'setTaskMeta', taskId, patch }),
      forgetTask: (taskId) => dispatch({ type: 'forgetTask', taskId }),
      applyConversationSummaries: (summaries) => dispatch({ type: 'applyConversationSummaries', summaries }),
      setConversation: (conversation) => dispatch({ type: 'setConversation', conversation }),
    }),
    [state, simulate, ingestRemoteEvent, persistence.durable],
  );

  return <AgentStoreContext.Provider value={value}>{children}</AgentStoreContext.Provider>;
}

export function useAgentStore(): AgentStoreValue {
  const ctx = useContext(AgentStoreContext);
  if (!ctx) throw new Error('useAgentStore must be used inside AgentStoreProvider');
  return ctx;
}
