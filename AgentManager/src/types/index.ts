/**
 * Provider-neutral domain models for AgentHub.
 *
 * Nothing in here is specific to OpenAI, Anthropic, Google or any other
 * vendor. Real integrations should map their own payloads onto these types
 * inside `src/providers/*` so the UI never learns provider details.
 */

export type ProviderId = 'openai' | 'anthropic' | 'google' | 'custom';

export type AgentStatus =
  | 'needs_approval'
  | 'needs_input'
  | 'running'
  | 'completed'
  | 'idle'
  | 'failed';

export type AgentEventType =
  | 'started'
  | 'message'
  | 'progress'
  /** Paused on outstanding background or scheduled work; not finished. */
  | 'idle'
  | 'approval_request'
  | 'input_request'
  | 'completed'
  | 'failed'
  | 'approved'
  | 'rejected';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

/**
 * Where a record came from.
 *
 * 'mock'      - seeded demo data that ships with the app.
 * 'simulated' - injected by the in-app development controls.
 * 'remote'    - arrived from a real transport (today the Windows bridge).
 *
 * 'remote' and 'simulated' are kept distinct so a real Windows event can never
 * be labelled simulated, or the reverse. Neither is locally actionable:
 * AgentHub has no command path back to the machine that produced them.
 */
export type EventOrigin = 'mock' | 'simulated' | 'remote';

/**
 * Which transport delivered an event. Declared here, rather than in the
 * notification service, so the store can consume it without importing the
 * service layer (which imports the store).
 */
export type EventSource = 'bridge' | 'simulated' | 'push';

export interface Agent {
  id: string;
  name: string;
  provider: ProviderId;
  /** Which account/workspace this agent runs under, e.g. "personal@openai". */
  account: string;
  status: AgentStatus;
  /** Null when the agent is idle. */
  currentTask: string | null;
  /** ISO timestamp for when the current task began; null when idle. */
  startedAt: string | null;
  /** ISO timestamp of the most recent change of any kind. */
  lastUpdated: string;
  /** Count of unread events belonging to this agent. */
  unread: number;
  /** Short initials rendered in the agent avatar. */
  avatar: string;
  /** Defaults to 'mock' when absent. */
  origin?: EventOrigin;
  /** Task identifier reported by the notifier, when it supplies one. */
  currentTaskId?: string | null;
  /**
   * Timestamp of the newest remote event that has been APPLIED to this agent's
   * status. Used to reject stale, out-of-order arrivals. See the ordering rule
   * in `agentStore.tsx`.
   */
  lastRemoteEventAt?: string | null;
}

export interface AgentEvent {
  id: string;
  agentId: string;
  type: AgentEventType;
  message: string;
  timestamp: string;
  /** True when the user must do something before the agent can continue. */
  requiresAction: boolean;
  read: boolean;
  /** Set when this event was raised by an approval request. */
  approvalId?: string;
  /** Defaults to 'mock' when absent. */
  origin?: EventOrigin;
  /** Task identifier from the notifier, preserved when present. */
  taskId?: string;
  /** Set when the event is child activity (a subagent) of `taskId`. */
  subtaskId?: string;
  /**
   * True when this event arrived after a newer one had already been applied.
   * Stale events are kept as history but never change agent status.
   */
  stale?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Project / Task model                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The product hierarchy is Project -> Task -> events.
 *
 * A PROJECT is the workspace an agent is operating in. A TASK is one agent
 * process inside it (for Claude Code: one session). Events update the task
 * they belong to rather than creating new ones, so a session that goes
 * started -> completed -> needs_input -> completed is ONE task changing colour.
 */
export interface Project {
  /** Opaque, stable, derived by the sender from the workspace path. */
  id: string;
  /** Last path segment of the workspace, e.g. "RobotFramework". */
  name: string;
}

/**
 * The colours the UI reasons in. The detailed `AgentStatus` is kept
 * underneath so a red task can still say WHY it is red.
 *
 *   running   green   started, running
 *   idle      gray    idle — stopped responding, but background or scheduled
 *                     work it launched is still outstanding; not finished
 *   finished  yellow  completed — stays until explicitly accepted
 *   action    red     needs_approval, needs_input, failed
 *
 * Idle counts toward Active projects, never toward Running agents or Needs
 * action, never offers Accept, and never triggers a push.
 */
export type TaskVisualState = 'running' | 'idle' | 'finished' | 'action';

export interface Task {
  /** From the wire when present; otherwise derived per `taskIdentity.ts`. */
  id: string;
  /**
   * The workspace the MAIN session was launched in. Pinned when the task is
   * first seen and never changed by later events: a `cd`, a worktree, or a
   * subagent working elsewhere must not move the task to another project.
   */
  projectId: string;
  projectName: string;
  /**
   * Display number within its project ("Task 3"), assigned when AgentHub first
   * sees a new main session and never reassigned. Accepting or forgetting
   * other tasks does not renumber; the per-project counter only increases.
   */
  ordinal: number;
  agentId: string;
  agentName: string;
  provider: ProviderId;
  /** Detailed status. Map to a colour with `visualStateFor`. */
  status: AgentStatus;
  /** Derived default. A user-chosen name lives in `TaskMeta.customTitle`. */
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Newest event timestamp applied to this task; drives the stale rule. */
  lastRemoteEventAt: string;
  /**
   * Set when the user pressed Accept. An accepted task leaves Home and the
   * active counts and appears in Summary. It is archived, never deleted. A
   * genuinely new event arriving after this time re-activates the task.
   */
  acceptedAt: string | null;
  origin: EventOrigin;
  /**
   * Set while the task's Needs-action status was raised by a subagent rather
   * than by the main session: the id of that subtask. Cleared when the main
   * session's own next event applies, or when that child moves on (then
   * either another waiting child takes over or the task returns to Running).
   * A red set by the main session itself is never overridden by a child.
   */
  escalatedBy?: string | null;
  /**
   * Title derived on Windows from the FIRST prompt of this session, applied
   * once and never changed by later prompts. Display precedence:
   * `TaskMeta.customTitle` (manual) > `autoTitle` > `title` ("Task N").
   * The ordinal underneath is kept regardless.
   */
  autoTitle?: string | null;
}

/**
 * Child activity of a Task: one subagent the main session launched.
 *
 * A subtask is never a task. It cannot create a project, cannot be numbered
 * as a task, and its completion never completes the parent. It lives under
 * the parent's project no matter where the subagent itself was working.
 */
export interface Subtask {
  /** From the wire (`subtaskId`): hash of main session id + agent id. */
  id: string;
  /**
   * The parent task. A subtask has NO project identity of its own: the
   * project is the parent's, and the parent's is the main session's. Until
   * the main session's first event arrives the parent may not exist yet; the
   * subtask is then held unresolved (never surfaced as a task or project) and
   * becomes visible under the parent the moment it is created.
   */
  taskId: string;
  /** Display number within the parent ("Subagent 2"). Never reassigned. */
  ordinal: number;
  /** Sanitised subagent name from the sender, when it chose to expose one. */
  agentType?: string;
  /**
   * Title from the child's own first prompt, when Claude exposes one through
   * a hook. Absent otherwise; the display then falls back to "<agentType> N".
   */
  autoTitle?: string | null;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
  lastRemoteEventAt: string;
  origin: EventOrigin;
}

/**
 * User-authored metadata attached to a task. Persisted in browser-local
 * storage so it survives closing and reopening the PWA. None of it comes from
 * a hook payload — every field is typed by the user on the phone.
 */
export interface TaskMeta {
  /** ChatGPT conversation URL, manually entered. HTTPS only. */
  chatUrl?: string;
  /** Follow-up prompt draft. Stored locally; sending is a separate phase. */
  promptDraft?: string;
  /** Optional rename of the derived task title. */
  customTitle?: string;
}

export interface ApprovalRequest {
  id: string;
  agentId: string;
  title: string;
  description: string;
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt?: string | null;
}

/** Statuses that should pull the user's eye. Single source of truth. */
export const ATTENTION_STATUSES: readonly AgentStatus[] = [
  'needs_approval',
  'needs_input',
  'failed',
];

export function needsAttention(agent: Agent): boolean {
  return ATTENTION_STATUSES.includes(agent.status);
}

/** True for records that arrived from a real transport. */
export function isRemote(record: { origin?: EventOrigin }): boolean {
  return record.origin === 'remote';
}

/** True for records injected by the in-app development controls. */
export function isSimulated(record: { origin?: EventOrigin }): boolean {
  return record.origin === 'simulated';
}

/** True for anything that did not originate on this device's mock data. */
export function isExternal(record: { origin?: EventOrigin }): boolean {
  return record.origin === 'remote' || record.origin === 'simulated';
}
