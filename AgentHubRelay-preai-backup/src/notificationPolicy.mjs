/**
 * Relay-side port of AgentManager's
 * `src/services/notifications/notificationPolicy.ts`.
 *
 * That file says, in its own words:
 *
 *   "The future relay MUST derive `title`/`body` with this function and MUST
 *    NOT copy `event.title` or `event.message` into them."
 *
 * This is that relay, and this module is how it obeys.
 *
 * A push notification is rendered by iOS before the device is unlocked, copied
 * into Notification Centre and possibly mirrored to a Watch. Everything here is
 * therefore treated as public. The lock screen gets only WHICH agent and WHAT
 * KIND of state change — never the event's own prose, never a filename, never a
 * path, never model output, never a hook payload.
 *
 * `event.message` is deliberately unused even though it is validated and
 * redacted: it is free text from a notifier we do not control, so it stays
 * inside the app where the device is unlocked. Activity still shows it in full.
 */

/** Fixed, non-interpolated bodies. One per event type, no free text ever. */
const BODY_BY_TYPE = {
  started: 'Task started',
  running: 'Working on a task',
  // Never pushed. Covers both "session open, no prompt yet" and "stopped while
  // background work runs"; the app shows the specific reason, the lock screen
  // never sees either.
  idle: 'Idle',
  completed: 'Task completed',
  needs_approval: 'Needs your approval',
  needs_input: 'Needs your input',
  failed: 'Task failed',
};

/**
 * WHICH EVENTS REACH THE LOCK SCREEN
 *
 * Only transitions the user must know about right now. State-keeping events
 * (started, running, idle) still flow to the app so Home shows the right
 * colour, but they never wake the phone:
 *
 *   completed       genuinely finished, nothing outstanding      -> push
 *   needs_approval  blocked on the user                          -> push
 *   needs_input     blocked on the user                          -> push
 *   failed          needs attention                              -> push
 *   started/running working                                      -> silent
 *   idle            paused on background or scheduled work       -> silent
 *
 * A Stop with outstanding background_tasks/session_crons arrives as `idle`
 * (classified on Windows, structurally), so a pause for running tests or
 * subagents is never announced as "Task completed".
 */
const PUSH_TYPES = new Set(['completed', 'needs_approval', 'needs_input', 'failed']);

export function shouldPush(eventType) {
  return PUSH_TYPES.has(eventType);
}

/**
 * Second guard for `completed`: exactly ONE push per completion transition.
 *
 * A repeat `completed` for the same task with no activity in between (the
 * previous recorded type is already `completed`) is not a new completion and
 * does not push again. Any intervening state -- running, idle, needs_* -- makes
 * the next `completed` a fresh transition that pushes once.
 */
export function isFreshTransition(eventType, previousType) {
  if (eventType !== 'completed') return true;
  return previousType !== 'completed';
}

/**
 * Bodies for SUBTASK-scoped events (child activity of a task: a subagent).
 * Same rule -- fixed strings by type, never input. The parent task/project
 * context travels in data.agentEvent (taskId), never in this text.
 */
const SUBTASK_BODY_BY_TYPE = {
  started: 'Subtask started',
  running: 'Subtask running',
  idle: 'Subtask waiting',
  completed: 'Subtask completed',
  needs_approval: 'Needs your approval',
  needs_input: 'Needs your input',
  failed: 'Subtask failed',
};

const MAX_TITLE_LENGTH = 40;

/** True when the event is child activity of a task rather than the task itself. */
export function isSubtaskEvent(event) {
  return typeof event.subtaskId === 'string' && event.subtaskId.length > 0;
}

/**
 * Per-device delivery filter, applied after `shouldPush` and
 * `isFreshTransition` have already decided the event is push-worthy.
 *
 * The ONLY thing a preference can suppress is a subagent's completion. A
 * child that needs approval or input, a child failure, and every main-task
 * notification are unaffected, because those are the ones that need the user.
 * Suppressing here, per subscription, keeps the event, its history and the
 * task hierarchy exactly as they are: only the push is withheld.
 */
export function allowsPush(record, event) {
  const isSubtaskCompletion = isSubtaskEvent(event) && event.type === 'completed';
  if (!isSubtaskCompletion) return true;
  return record?.preferences?.subtaskCompletionPush !== false;
}

/**
 * The only text permitted to reach a lock screen.
 *
 * `title` is the agent's name (operator-chosen, already length-capped and
 * redacted by the validator). `body` is selected from the tables above by
 * scope and event type — it is never built from input.
 */
export function toLockScreenNotification(event) {
  const name = String(event.agentName ?? '').trim();
  const title =
    name.length === 0
      ? 'Agent'
      : name.length > MAX_TITLE_LENGTH
        ? `${name.slice(0, MAX_TITLE_LENGTH - 1)}…`
        : name;

  const table = isSubtaskEvent(event) ? SUBTASK_BODY_BY_TYPE : BODY_BY_TYPE;
  return { title, body: table[event.type] ?? 'Agent update' };
}

/**
 * True when `body` is one of the fixed strings above.
 *
 * Exists so the relay can assert the policy at send time and the tests can
 * prove it, rather than relying on code review to catch a regression that
 * would leak prose onto a lock screen.
 */
export function isPolicyApprovedBody(body) {
  return Object.values(BODY_BY_TYPE).includes(body) || Object.values(SUBTASK_BODY_BY_TYPE).includes(body);
}

export const LOCK_SCREEN_BODIES = [
  ...Object.values(BODY_BY_TYPE),
  ...Object.values(SUBTASK_BODY_BY_TYPE),
];
