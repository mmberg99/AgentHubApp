import {
  PROTOCOL_VERSION,
  type AgentNotificationEvent,
  type AgentEventType,
  type ConversationMessage,
  type MessageSummary,
  type TaskConversation,
} from '../../protocol';
import type {
  DeviceRegistration,
  NotificationService,
  NotificationStatus,
  PermissionStatus,
  RawEventListener,
  StatusListener,
} from './types';

const UNREGISTERED: DeviceRegistration = {
  registered: false,
  token: null,
  registeredAt: null,
  simulated: true,
};

/**
 * In-memory notification service.
 *
 * Receives nothing from the network. It exists so the whole event pipeline —
 * validation, mapping, store ingestion, UI — can be exercised and proven
 * before any push infrastructure or credentials are introduced.
 *
 * It never claims a real registration: `simulated` is true everywhere and the
 * placeholder token is obviously fake, so Settings cannot mislead.
 */
class MockNotificationService implements NotificationService {
  readonly id = 'mock';
  readonly simulated = true;

  private listeners = new Set<RawEventListener>();
  private statusListeners = new Set<StatusListener>();

  private status: NotificationStatus = {
    serviceId: 'mock',
    simulated: true,
    transport: 'simulated',
    connectionState: 'simulated',
    endpoint: null,
    lastError: null,
    lastContactAt: null,
    enabled: true,
    permission: 'undetermined',
    registration: UNREGISTERED,
    lastEventAt: null,
    lastEventTitle: null,
    lastRealEventAt: null,
    lastRealEventTitle: null,
    realEventCount: 0,
    rejectedCount: 0,
  };

  getStatus(): NotificationStatus {
    return this.status;
  }

  private setStatus(patch: Partial<NotificationStatus>): void {
    this.status = { ...this.status, ...patch };
    this.statusListeners.forEach((listener) => listener(this.status));
  }

  subscribeStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  subscribe(listener: RawEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async requestPermissions(): Promise<PermissionStatus> {
    // No OS prompt is shown; this only records that the flow was exercised.
    this.setStatus({ permission: 'granted' });
    return 'granted';
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.setStatus({ enabled });
  }

  async register(): Promise<DeviceRegistration> {
    const registration: DeviceRegistration = {
      registered: true,
      // Deliberately not token-shaped, so it can never be mistaken for real.
      token: 'simulated-device-no-push-infrastructure',
      registeredAt: new Date().toISOString(),
      simulated: true,
    };
    this.setStatus({ registration });
    return registration;
  }

  async unregister(): Promise<void> {
    this.setStatus({ registration: UNREGISTERED });
  }

  deliverSimulated(raw: unknown): void {
    if (!this.status.enabled) return;

    const title =
      typeof raw === 'object' && raw !== null && typeof (raw as { title?: unknown }).title === 'string'
        ? ((raw as { title: string }).title)
        : 'Unknown event';

    this.setStatus({
      lastEventAt: new Date().toISOString(),
      lastEventTitle: title,
    });

    // Always 'simulated': this service has no transport and never receives a
    // real event, so it cannot mislabel one.
    this.listeners.forEach((listener) => listener(raw, 'simulated'));
  }

  reportRejected(): void {
    this.setStatus({ rejectedCount: this.status.rejectedCount + 1 });
  }

  async checkNow(): Promise<void> {
    // Nothing to contact; the simulated transport is always "up".
  }
}

export const mockNotificationService: NotificationService = new MockNotificationService();

/* ------------------------------------------------------------------------ */
/* Simulated Windows payloads                                                */
/* ------------------------------------------------------------------------ */

let simulatedCounter = 0;

/**
 * A stand-in for an agent running on the Windows PC. Deliberately distinct
 * from the nine mock agents so remote events are easy to tell apart.
 */
const WINDOWS_AGENT = {
  agentId: 'win_claude_code',
  agentName: 'Claude Code',
  provider: 'claude',
} as const;

interface SimulatedTemplate {
  type: AgentEventType;
  title: string;
  message: string;
}

/**
 * Copy follows the security contract: status only, never task contents,
 * file paths, prompts or credentials.
 */
/**
 * Mirrors the real Claude lifecycle so the simulate controls exercise the same
 * states a real session produces: open (idle) -> prompt (running) ->
 * stop with background work (idle) -> stop when done (completed).
 */
export type SimulatedEventKey =
  | 'session_open'
  | 'running'
  | 'idle'
  | 'completed'
  | 'needs_approval'
  | 'needs_input'
  | 'failed'
  /** Child activity under the current simulated task; never a task itself. */
  | 'subagent_start'
  | 'subagent_needs_approval'
  | 'subagent_stop';

export const SIMULATED_WINDOWS_EVENTS: Record<SimulatedEventKey, SimulatedTemplate> = {
  subagent_start: {
    type: 'running',
    title: 'Subtask running',
    message: 'A subagent is working.',
  },
  subagent_needs_approval: {
    type: 'needs_approval',
    title: 'Subtask needs approval',
    message: 'A subagent is waiting for your approval.',
  },
  subagent_stop: {
    type: 'completed',
    title: 'Subtask completed',
    message: 'A subagent finished its work.',
  },
  session_open: {
    type: 'idle',
    title: 'Claude Code session opened',
    message: 'A Claude session was opened on your Windows PC; no prompt yet.',
  },
  running: {
    type: 'running',
    title: 'Claude Code is working',
    message: 'A prompt was submitted; the agent is working on your Windows PC.',
  },
  idle: {
    type: 'idle',
    title: 'Claude Code is waiting on background work',
    message: 'The agent paused while tests or background work run on your Windows PC.',
  },
  completed: {
    type: 'completed',
    title: 'Claude Code finished a task',
    message: 'The task completed successfully on your Windows PC.',
  },
  needs_approval: {
    type: 'needs_approval',
    title: 'Claude Code needs approval',
    message: 'A step is waiting for your approval on your Windows PC.',
  },
  needs_input: {
    type: 'needs_input',
    title: 'Claude Code needs input',
    message: 'A question is waiting for your answer on your Windows PC.',
  },
  failed: {
    type: 'failed',
    title: 'Claude Code failed',
    message: 'A task stopped with an error on your Windows PC.',
  },
};

/**
 * Fake projects for the simulate controls, so the Project -> Task grouping can
 * be exercised on a phone with no Windows events in sight. Clearly labelled;
 * the ids can never collide with a real sender's hashed ids.
 */
const SIMULATED_PROJECTS = [
  { projectId: 'sim-project-a', projectName: 'Sample Workspace A' },
  { projectId: 'sim-project-b', projectName: 'Sample Workspace B' },
] as const;

/**
 * The simulated task the next event applies to.
 *
 * `session_open` begins a NEW task (alternating between the two sample
 * projects), exactly as a real SessionStart does; every other key updates the
 * most recent one. That reproduces a real session — one task changing colour —
 * instead of minting a task per tap.
 */
let simulatedTaskCounter = 0;
let currentSimulatedTask: { taskId: string; projectId: string; projectName: string } | null = null;
/** Subagents of the current simulated task: start opens a new one, the others update it. */
let simulatedSubagentCounter = 0;
let currentSimulatedSubtask: string | null = null;

function nextSimulatedTask() {
  simulatedTaskCounter += 1;
  const project = SIMULATED_PROJECTS[simulatedTaskCounter % SIMULATED_PROJECTS.length];
  currentSimulatedTask = { taskId: `sim-task-${simulatedTaskCounter}`, ...project };
  currentSimulatedSubtask = null;
  return currentSimulatedTask;
}

function nextSimulatedSubtask(taskId: string) {
  simulatedSubagentCounter += 1;
  currentSimulatedSubtask = `${taskId}-sub-${simulatedSubagentCounter}`;
  return currentSimulatedSubtask;
}

/** The simulated task the next conversation sample attaches to (null before any session). */
export function currentSimulatedTaskId(): string | null {
  return currentSimulatedTask?.taskId ?? null;
}

const SAMPLE_TURNS: ReadonlyArray<readonly [string, string]> = [
  [
    [
      'Fix the push notification lifecycle so Claude is idle while background tests are still running.',
      '',
      '- Stop with outstanding work should report Idle',
      '- Stop with nothing outstanding should report Completed',
      '- Do not change the existing push policy',
      '- Add tests covering both paths',
      '',
      'Build and stage it, then stop for approval before deploying anything.',
    ].join('\n'),
    [
      '## Summary',
      '',
      'Implemented the **corrected lifecycle**. `Stop` with work outstanding now reports *Idle*,',
      'and only a `Stop` with nothing outstanding reports **Completed**.',
      '',
      '- `hook_context.py` classifies the stop',
      '- `notificationPolicy.mjs` decides the push',
      '',
      '```ts',
      'const state = outstanding ? "idle" : "completed";',
      '// markup in code stays literal: <script>alert(1)</script>',
      '```',
      '',
      '> All suites pass.',
      '',
      'See [the notes](https://example.test/notes) for details.',
    ].join('\n'),
  ],
  [
    'Now make subagents children of the task.',
    [
      'Implemented the hierarchy:',
      '',
      '1. Subagents attach under the parent task',
      '2. They never create projects',
      '3. Their completion never finishes the parent',
    ].join('\n'),
  ],
  [
    'Add conversation-aware tasks.',
    'Conversation capture is in place: prompts and visible responses are stored on Windows and read by the PWA over the authenticated `/api` route.',
  ],
];

/**
 * A local, clearly simulated conversation for the current simulated task: one
 * more prompt/response pair each call, titled from the first prompt exactly as
 * the notifier would. Never leaves the device; nothing is sent anywhere.
 */
export function buildSimulatedConversation(
  existing: TaskConversation | undefined,
  taskId: string,
): TaskConversation {
  const prior = existing?.thread.messages ?? [];
  const turn = SAMPLE_TURNS[Math.floor(prior.length / 2) % SAMPLE_TURNS.length];
  const now = Date.now();
  const mk = (role: 'user' | 'assistant', text: string, offset: number): ConversationMessage => ({
    messageId: `sim-msg-${taskId}-${prior.length + offset}`,
    taskId,
    role,
    text,
    timestamp: new Date(now + offset).toISOString(),
  });
  const nextUser = mk('user', turn[0], 0);
  const nextAssistant = mk('assistant', turn[1], 1);
  const messages = [...prior, nextUser, nextAssistant];

  // Stand-ins for the cards the Windows summariser writes, so the simulate
  // controls exercise the same rendering path a real summary uses. Local
  // only; nothing is sent anywhere and no model is called.
  const card = (message: ConversationMessage, index: number): MessageSummary | null =>
    SAMPLE_CARDS[index] ? { ...SAMPLE_CARDS[index], messageId: message.messageId } : null;
  const summaries: Record<string, MessageSummary> = { ...(existing?.summaries ?? {}) };
  const turnIndex = Math.floor(prior.length / 2) % SAMPLE_TURNS.length;
  const userCard = card(nextUser, turnIndex * 2);
  const assistantCard = card(nextAssistant, turnIndex * 2 + 1);
  if (userCard) summaries[nextUser.messageId] = userCard;
  if (assistantCard) summaries[nextAssistant.messageId] = assistantCard;

  return {
    taskId,
    title: existing?.title ?? 'Fix push notification lifecycle',
    updatedAt: new Date(now + 1).toISOString(),
    thread: { messages, trimmed: 0 },
    children: existing?.children ?? {},
    summaries,
  };
}

/**
 * Sample cards paired with SAMPLE_TURNS, in prompt/response order. Only the
 * first pair has them, so the simulate controls show both an AI card and the
 * local fallback side by side.
 */
const SAMPLE_CARDS: ReadonlyArray<Omit<MessageSummary, 'messageId'> | null> = [
  // The long prompt deliberately has no card, so the simulate controls show
  // the Windows-written card and the local fallback next to each other.
  null,
  {
    title: 'Corrected lifecycle implemented',
    style: 'bullets',
    paragraph: '',
    bullets: [
      'Stop now reports Idle while work is outstanding',
      'hook_context.py classifies the stop, notificationPolicy.mjs decides the push',
      'All suites pass',
    ],
  },
  null,
  null,
  null,
  null,
];

/** Builds a protocol-valid event for local testing. */
export function buildSimulatedEvent(key: SimulatedEventKey): AgentNotificationEvent {
  const template = SIMULATED_WINDOWS_EVENTS[key];
  simulatedCounter += 1;

  const task =
    key === 'session_open' || currentSimulatedTask === null
      ? nextSimulatedTask()
      : currentSimulatedTask;

  const isSubagent = key.startsWith('subagent_');
  const subtaskId = isSubagent
    ? key === 'subagent_start' || currentSimulatedSubtask === null
      ? nextSimulatedSubtask(task.taskId)
      : currentSimulatedSubtask
    : undefined;

  return {
    version: PROTOCOL_VERSION,
    eventId: `sim_${Date.now().toString(36)}_${simulatedCounter}`,
    agentId: WINDOWS_AGENT.agentId,
    agentName: WINDOWS_AGENT.agentName,
    type: template.type,
    title: template.title,
    message: template.message,
    timestamp: new Date().toISOString(),
    taskId: task.taskId,
    // Same shape the notifier sends. A child event carries the PARENT task
    // id, a child id and a safe type name — and NO project: the project
    // belongs to the main session, never to a subagent's working directory.
    ...(subtaskId
      ? { subtaskId, agentType: 'Explore' }
      : { projectId: task.projectId, projectName: task.projectName }),
    provider: WINDOWS_AGENT.provider,
  };
}
