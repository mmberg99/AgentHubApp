import { isToday } from '../lib/time';
import { latestAssistantMessage, type ConversationMessage, type TaskConversation } from '../protocol';
import type {
  Agent,
  AgentEvent,
  AgentStatus,
  ApprovalRequest,
  Project,
  Subtask,
  Task,
} from '../types';
import { needsAttention } from '../types';
import { isActive, visualStateFor } from './taskIdentity';

/** Lower number sorts first. Approvals outrank questions, which outrank errors. */
const ATTENTION_RANK: Record<AgentStatus, number> = {
  needs_approval: 0,
  needs_input: 1,
  failed: 2,
  running: 3,
  completed: 4,
  idle: 5,
};

function byNewest(a: { timestamp: string }, b: { timestamp: string }): number {
  return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
}

function byRecentlyUpdated(a: Agent, b: Agent): number {
  return new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime();
}

export function attentionAgents(agents: Agent[]): Agent[] {
  return agents
    .filter(needsAttention)
    .sort(
      (a, b) =>
        ATTENTION_RANK[a.status] - ATTENTION_RANK[b.status] || byRecentlyUpdated(a, b),
    );
}

export function runningAgents(agents: Agent[]): Agent[] {
  return agents.filter((a) => a.status === 'running').sort(byRecentlyUpdated);
}

export function completedTodayAgents(agents: Agent[], now?: number): Agent[] {
  return agents
    .filter((a) => a.status === 'completed' && isToday(a.lastUpdated, now))
    .sort(byRecentlyUpdated);
}

export function idleAgents(agents: Agent[]): Agent[] {
  return agents.filter((a) => a.status === 'idle').sort(byRecentlyUpdated);
}

export function eventsForAgent(events: AgentEvent[], agentId: string): AgentEvent[] {
  return events.filter((e) => e.agentId === agentId).sort(byNewest);
}

export function pendingApprovalsForAgent(
  approvals: ApprovalRequest[],
  agentId: string,
): ApprovalRequest[] {
  return approvals.filter((a) => a.agentId === agentId && a.status === 'pending');
}

export function pendingApprovals(approvals: ApprovalRequest[]): ApprovalRequest[] {
  return approvals.filter((a) => a.status === 'pending');
}

/**
 * The unified Activity inbox: every event, newest first, with the ones that
 * still demand something from the user lifted to the top.
 */
export function inboxEvents(events: AgentEvent[]): AgentEvent[] {
  const actionable = events.filter((e) => e.requiresAction).sort(byNewest);
  const rest = events.filter((e) => !e.requiresAction).sort(byNewest);
  return [...actionable, ...rest];
}

export function recentActivity(events: AgentEvent[], limit = 6): AgentEvent[] {
  return [...events].sort(byNewest).slice(0, limit);
}

export function unreadCount(events: AgentEvent[]): number {
  return events.filter((e) => !e.read).length;
}

export function actionableCount(events: AgentEvent[]): number {
  return events.filter((e) => e.requiresAction).length;
}

/** Real events delivered by a transport (not simulated), newest first. */
export function remoteEvents(events: AgentEvent[]): AgentEvent[] {
  return events.filter((e) => e.origin === 'remote').sort(byNewest);
}

/** The most recent REAL remote event, or null when none has arrived. */
export function lastRemoteEvent(events: AgentEvent[]): AgentEvent | null {
  return remoteEvents(events)[0] ?? null;
}

/** Events injected by the in-app development controls, newest first. */
export function simulatedEvents(events: AgentEvent[]): AgentEvent[] {
  return events.filter((e) => e.origin === 'simulated').sort(byNewest);
}

/** Agents that exist because a transport told us about them. */
export function remoteAgents(agents: Agent[]): Agent[] {
  return agents.filter((a) => a.origin === 'remote').sort(byRecentlyUpdated);
}

export function findAgent(agents: Agent[], id: string): Agent | undefined {
  return agents.find((a) => a.id === id);
}

/* -------------------------------------------------------------------------- */
/* Project / Task selectors                                                    */
/* -------------------------------------------------------------------------- */

function byRecentlyUpdatedTask(a: Task, b: Task): number {
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

/** Tasks the user has not accepted, most recently updated first. */
export function activeTasks(tasks: Task[]): Task[] {
  return tasks.filter(isActive).sort(byRecentlyUpdatedTask);
}

/** Accepted tasks, most recently accepted first. */
export function acceptedTasks(tasks: Task[]): Task[] {
  return tasks
    .filter((t) => t.acceptedAt !== null)
    .sort(
      (a, b) =>
        new Date(b.acceptedAt as string).getTime() - new Date(a.acceptedAt as string).getTime(),
    );
}

export interface ProjectGroup {
  project: Project;
  tasks: Task[];
  running: number;
  /** Paused on background/scheduled work. Active, but neither running nor finished. */
  idle: number;
  finished: number;
  action: number;
}

/**
 * Groups tasks under their project, newest activity first within and across
 * groups. Counts are per visual state. Works for any task list, so Home passes
 * active tasks and Summary passes accepted ones.
 */
export function groupTasksByProject(tasks: Task[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();

  for (const task of [...tasks].sort(byRecentlyUpdatedTask)) {
    let group = groups.get(task.projectId);
    if (!group) {
      group = {
        project: { id: task.projectId, name: task.projectName },
        tasks: [],
        running: 0,
        idle: 0,
        finished: 0,
        action: 0,
      };
      groups.set(task.projectId, group);
    }
    group.tasks.push(task);
    group[visualStateFor(task.status)] += 1;
  }

  // Projects with something red first, then by most recent activity.
  return [...groups.values()].sort((a, b) => {
    if ((a.action > 0) !== (b.action > 0)) return a.action > 0 ? -1 : 1;
    return byRecentlyUpdatedTask(a.tasks[0], b.tasks[0]);
  });
}

/** GREEN header card: task/process instances currently running. Idle and Finished are excluded. */
export function runningTaskCount(tasks: Task[]): number {
  return tasks.filter((t) => isActive(t) && visualStateFor(t.status) === 'running').length;
}

/** YELLOW header card: projects with at least one unaccepted task. */
export function activeProjectCount(tasks: Task[]): number {
  return new Set(tasks.filter(isActive).map((t) => t.projectId)).size;
}

/** RED header card: unaccepted tasks in needs_approval / needs_input / failed. */
export function needsActionCount(tasks: Task[]): number {
  return tasks.filter((t) => isActive(t) && visualStateFor(t.status) === 'action').length;
}

export function findTask(tasks: Task[], id: string): Task | undefined {
  return tasks.find((t) => t.id === id);
}

/**
 * A task's timeline, newest first. Includes its subagents' events, which
 * carry `subtaskId` so the UI can label them as child activity.
 */
export function eventsForTask(events: AgentEvent[], taskId: string): AgentEvent[] {
  return events.filter((e) => e.taskId === taskId).sort(byNewest);
}

/**
 * A task's subagents in the order they were first seen ("Subagent 1, 2, …").
 *
 * Subtasks live in their own slice, so none of the Home counts above can ever
 * include one: `runningTaskCount`, `activeProjectCount` and `needsActionCount`
 * count top-level tasks only, by construction.
 */
export function subtasksFor(subtasks: Subtask[], taskId: string): Subtask[] {
  return subtasks.filter((s) => s.taskId === taskId).sort((a, b) => a.ordinal - b.ordinal);
}

/**
 * The Notifications feed: everything that arrived from outside the device,
 * newest first. Remote and simulated are both external; neither is demo data.
 */
export function externalEvents(events: AgentEvent[]): AgentEvent[] {
  return events
    .filter((e) => e.origin === 'remote' || e.origin === 'simulated')
    .sort(byNewest);
}

/* -------------------------------------------------------------------------- */
/* Conversation selectors                                                      */
/* -------------------------------------------------------------------------- */

/** The task's own visible turns, oldest first. Children are never mixed in. */
export function conversationFor(
  conversations: Record<string, TaskConversation>,
  taskId: string,
): ConversationMessage[] {
  return conversations[taskId]?.thread.messages ?? [];
}

/**
 * "Latest output": the newest assistant message of the main thread. It is the
 * same record that closes the Conversation view; nothing is stored twice.
 */
export function latestOutputFor(
  conversations: Record<string, TaskConversation>,
  taskId: string,
): ConversationMessage | null {
  return latestAssistantMessage(conversations[taskId]);
}

/** A subagent's own thread (its prompts, if exposed, and its final output). */
export function childConversationFor(
  conversations: Record<string, TaskConversation>,
  taskId: string,
  subtaskId: string,
): ConversationMessage[] {
  return conversations[taskId]?.children[subtaskId]?.messages ?? [];
}

/** A subagent's final visible output (its newest assistant message). */
export function childOutputFor(
  conversations: Record<string, TaskConversation>,
  taskId: string,
  subtaskId: string,
): ConversationMessage | null {
  const messages = childConversationFor(conversations, taskId, subtaskId);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'assistant') return messages[i];
  }
  return null;
}
