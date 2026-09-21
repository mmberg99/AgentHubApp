import type { AgentEventType, AgentNotificationEvent } from '../../protocol';

/**
 * LOCK-SCREEN PRIVACY POLICY
 *
 * A push notification is displayed by iOS before the device is unlocked, is
 * copied into Notification Centre, and may be mirrored to a Mac or a Watch.
 * Anything placed in `title` or `body` must therefore be treated as public.
 *
 * The rule this module enforces: the lock screen shows only WHICH agent and
 * WHAT KIND of state change. Never the event's own prose.
 *
 *   ALLOWED            "Claude Code" / "Task completed"
 *                      "Codex" / "Task failed"
 *                      "Claude Code" / "Needs your approval"
 *
 *   NEVER              source code, prompts, filenames, filesystem paths,
 *                      terminal output, model responses, error strings, API
 *                      keys, repository or customer secrets, account names
 *
 * `event.message` is deliberately NOT used for the lock screen even though it
 * is already validated and redacted. It is free text authored by a notifier we
 * do not control, so it stays inside the app where the device is unlocked. The
 * richer message continues to appear in Activity, unchanged.
 */

export interface LockScreenNotification {
  title: string;
  body: string;
}

/** Fixed, non-interpolated bodies. One per event type, no free text. */
const BODY_BY_TYPE: Record<AgentEventType, string> = {
  started: 'Task started',
  running: 'Working on a task',
  // Never pushed by the relay; listed so the table stays total and any
  // future sender of `idle` still produces policy-approved text. Covers both
  // "session open" and "waiting on background work".
  idle: 'Idle',
  completed: 'Task completed',
  needs_approval: 'Needs your approval',
  needs_input: 'Needs your input',
  failed: 'Task failed',
};

/** Agent names are short and operator-chosen, but still capped for display. */
const MAX_TITLE_LENGTH = 40;

/**
 * Builds the only text permitted to reach a lock screen.
 *
 * The future relay MUST derive `title`/`body` with this function and MUST NOT
 * copy `event.title` or `event.message` into them.
 */
export function toLockScreenNotification(event: AgentNotificationEvent): LockScreenNotification {
  const name = event.agentName.trim();
  const title =
    name.length === 0
      ? 'Agent'
      : name.length > MAX_TITLE_LENGTH
        ? `${name.slice(0, MAX_TITLE_LENGTH - 1)}…`
        : name;

  return { title, body: BODY_BY_TYPE[event.type] };
}

/**
 * True when the text matches the policy above: one of the fixed bodies.
 *
 * Exists so the relay (and tests) can assert that nothing else ever reaches a
 * notification body, rather than trusting review alone.
 */
export function isPolicyApprovedBody(body: string): boolean {
  return Object.values(BODY_BY_TYPE).includes(body);
}

export const LOCK_SCREEN_BODIES: readonly string[] = Object.values(BODY_BY_TYPE);
