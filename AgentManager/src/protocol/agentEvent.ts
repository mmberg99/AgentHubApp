/**
 * Wire protocol shared (conceptually) by the Windows notifier and AgentHub.
 *
 * SECURITY CONTRACT — this is the trust boundary of the application.
 *
 * Events cross the public internet through push infrastructure, so a payload
 * must carry only what is needed to render a notification row:
 *
 *   NEVER include API keys, tokens, passwords, credentials, source code,
 *   prompts, file contents, customer data or any other sensitive material.
 *
 * `message` and `title` are displayed verbatim in the UI and may appear on a
 * lock screen. Treat them as public. The sender is responsible for keeping
 * secrets out; this module enforces shape and size, not secrecy.
 *
 * Communication is ONE-WAY: Windows -> AgentHub. Nothing in this protocol
 * expresses a command travelling back toward the PC, and nothing should be
 * added that does without a separate security review.
 */

export const PROTOCOL_VERSION = 1 as const;

/**
 * Status-shaped vocabulary used on the wire. This is deliberately NOT the same
 * as the app's internal `AgentEventType` in `src/types`, which is
 * activity-shaped. `src/protocol/mapToDomain.ts` translates between them so the
 * two can evolve independently.
 */
export type AgentEventType =
  | 'started'
  | 'running'
  /**
   * The agent has stopped responding but work it launched — tests, shell
   * commands, subagents, scheduled jobs — is still outstanding. Classified by
   * the sender from Claude Code's Stop payload. Not a completion; never pushed.
   */
  | 'idle'
  | 'completed'
  | 'needs_approval'
  | 'needs_input'
  | 'failed';

export type AgentEventProvider = 'claude' | 'openai' | 'custom';

export interface AgentNotificationEvent {
  version: 1;
  eventId: string;
  agentId: string;
  agentName: string;
  type: AgentEventType;
  title: string;
  message: string;
  timestamp: string;
  /**
   * Stable identity of the agent process this event belongs to. For Claude
   * Code it is a hash of the session id, so two concurrent sessions in the
   * same workspace are two tasks. Absent from older senders.
   */
  taskId?: string;
  provider?: AgentEventProvider;
  /**
   * PROJECT IDENTITY (added after v1 shipped; both optional, both backward
   * compatible — an event without them still validates).
   *
   * Derived on the sending machine from the agent's working directory:
   *   projectName  the last path segment, e.g. "RobotFramework"
   *   projectId    a short hash of the normalised path, opaque and stable
   *
   * The full filesystem path is NEVER transmitted. The sender hashes it; the
   * app only ever sees the name and the hash.
   */
  projectId?: string;
  projectName?: string;
  /**
   * SUBTASK SCOPE. Present only for child activity of `taskId` — a subagent
   * the main session launched. Derived by the sender as a hash of the main
   * session id and the agent id; neither raw value travels. Its presence is
   * the scope marker: such an event updates a child entry under the parent
   * task and can never create a task of its own or complete the parent.
   */
  subtaskId?: string;
  /** Sanitised subagent name, e.g. "Explore". Subtasks only. Never a prompt. */
  agentType?: string;
}

export const AGENT_EVENT_TYPES: readonly AgentEventType[] = [
  'started',
  'running',
  'idle',
  'completed',
  'needs_approval',
  'needs_input',
  'failed',
];

export const AGENT_EVENT_PROVIDERS: readonly AgentEventProvider[] = [
  'claude',
  'openai',
  'custom',
];

/**
 * Hard caps applied during validation. Identifiers are rejected when too long
 * (a long id signals a malformed sender); display text is truncated so an
 * over-long message degrades gracefully instead of dropping the event or
 * breaking the layout.
 */
export const FIELD_LIMITS = {
  eventId: 128,
  agentId: 128,
  agentName: 80,
  taskId: 128,
  title: 120,
  message: 500,
  projectId: 64,
  projectName: 80,
  subtaskId: 64,
  agentType: 40,
} as const;

/** Event types that should pull the user's attention in the UI. */
export const ACTIONABLE_EVENT_TYPES: readonly AgentEventType[] = [
  'needs_approval',
  'needs_input',
  'failed',
];
