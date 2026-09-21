import type { AgentNotificationEvent } from '../protocol';
import { clockTime } from '../lib/time';
import type { AgentStatus, Project, Task, TaskVisualState } from '../types';

/**
 * IDENTITY RULES — how an incoming event finds (or creates) its Task.
 *
 * The sender is the authority. When the notifier supplies `projectId` /
 * `projectName` / `taskId`, they are used verbatim: for Claude Code that is a
 * hash of the workspace path and a hash of the session id, computed on the
 * Windows side so neither the path nor the raw session id ever reaches the
 * phone. Two concurrent sessions in one workspace therefore become two tasks
 * under one project, which is the behaviour the product model needs.
 *
 * FALLBACK — events without those fields (older senders, other tools). One
 * rolling task per agent, grouped under a project named after the agent. This
 * is exactly how the app behaved before projects existed, so nothing that
 * worked yesterday regresses. Nothing here invents a fresh id per event: the
 * fallback is deterministic from `agentId`, so repeated events still land on
 * the same task.
 */

const FALLBACK_PROJECT_PREFIX = 'agent:';

export function projectFor(event: AgentNotificationEvent): Project {
  if (event.projectId) {
    return { id: event.projectId, name: event.projectName ?? event.projectId };
  }
  return { id: `${FALLBACK_PROJECT_PREFIX}${event.agentId}`, name: event.agentName };
}

export function taskIdFor(event: AgentNotificationEvent): string {
  return event.taskId ?? `${FALLBACK_PROJECT_PREFIX}${event.agentId}`;
}

/** True when the task's identity came from the sender rather than the fallback. */
export function hasSenderIdentity(task: Task): boolean {
  return !task.id.startsWith(FALLBACK_PROJECT_PREFIX);
}

/**
 * Default task name: "Task N", numbered within the project in the order
 * AgentHub first saw each main session. Hook payloads deliberately carry no
 * prompt text, so there is nothing more descriptive to use; the user can
 * rename it via `TaskMeta.customTitle` (seam already in place).
 */
export function defaultTaskTitle(ordinal: number): string {
  return `Task ${ordinal}`;
}

/** Default subtask name: "Subagent N", numbered within the parent task. */
export function defaultSubtaskTitle(ordinal: number): string {
  return `Subagent ${ordinal}`;
}

/**
 * Display name of a subagent: its own first prompt's title when Claude exposed
 * one through a hook, else the safe "<agentType> N" / "Subagent N" fallback.
 * Never guessed from its output.
 */
export function subtaskTitle(subtask: {
  ordinal: number;
  agentType?: string;
  autoTitle?: string | null;
}): string {
  if (subtask.autoTitle) return subtask.autoTitle;
  return subtask.agentType ? `${subtask.agentType} ${subtask.ordinal}` : defaultSubtaskTitle(subtask.ordinal);
}

/** Kept for callers that still want a time-based label. */
export function sessionLabel(event: AgentNotificationEvent): string {
  return `Session ${clockTime(event.timestamp)}`;
}

/* ---------------------------------------------------------- visual state */

export function visualStateFor(status: AgentStatus): TaskVisualState {
  switch (status) {
    case 'running':
      return 'running';
    case 'idle':
      return 'idle';
    case 'completed':
      return 'finished';
    case 'needs_approval':
    case 'needs_input':
    case 'failed':
      return 'action';
  }
}

/** Labels shown on cards. Red tasks keep their specific reason. */
export function statusLabel(status: AgentStatus): string {
  switch (status) {
    case 'running':
      return 'Running';
    case 'idle':
      return 'Idle';
    case 'completed':
      return 'Finished';
    case 'needs_approval':
      return 'Needs approval';
    case 'needs_input':
      return 'Needs input';
    case 'failed':
      return 'Failed';
  }
}

export const VISUAL_STATE_LABEL: Record<TaskVisualState, string> = {
  running: 'Running',
  idle: 'Idle',
  finished: 'Finished',
  action: 'Needs action',
};

export function isActive(task: Task): boolean {
  return task.acceptedAt === null;
}
