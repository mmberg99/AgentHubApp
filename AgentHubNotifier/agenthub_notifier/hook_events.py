"""Fixed events for the Claude Code hooks.

Every event sent from a hook is built here. The TEXT is entirely constant: the
event type is a literal chosen in settings.json and the title/message come from
the table below. Nothing typed into Claude, nothing Claude said, no tool input
and no file content can reach an outgoing event, because there is no parameter
through which any of it could be passed.

The one thing the hook payload may contribute is IDENTITY, and only in derived
form: a ``HookContext`` (see hook_context.py) carrying a hashed project id, the
workspace folder's name, and a hashed session id. ``HookContext`` has no field
that could hold a path, a transcript location or a raw session id, so this
module cannot forward one even by mistake.

This module performs NO input/output of any kind.
"""

from __future__ import annotations

from .event import AgentEvent, build_event, normalize_type
from .hook_context import HookContext, fallback_subtask_id, resolve_hook
from .validation import validate_or_raise

#: Stable identity for this machine's Claude Code, as the bridge expects.
AGENT_ID = "win_claude_code"
AGENT_NAME = "Claude Code"
PROVIDER = "claude"

#: The only event types a hook may send, each with fixed generic text.
#: Deliberately boring: assume every line shows on a phone lock screen.
#:
#:   SessionStart      -> idle            IDLE      (no push)  "Session open"
#:   UserPromptSubmit  -> running         RUNNING   (no push)
#:   Stop              -> completed | idle          (push only for completed;
#:                        idle when background_tasks / session_crons remain,
#:                        with the distinct "Waiting on background work" text)
#:   PermissionRequest -> needs_approval  NEEDS ACTION (push)
#:   Notification      -> needs_input     NEEDS ACTION (push)
#:   StopFailure       -> failed          NEEDS ACTION (push)
#:
#: There is deliberately NO "started" entry: this hook never reports Running
#: for merely opening a session (see hook_context.resolve_hook_type). Which
#: types push is the relay's decision (notificationPolicy.mjs); the hook only
#: reports state.
HOOK_EVENT_TEXT = {
    "running": ("Task running", "Claude Code is working."),
    "idle": ("Session open", "Claude Code is open and waiting for a prompt."),
    "needs_approval": ("Approval needed", "Claude Code needs approval."),
    "needs_input": ("Input needed", "Claude Code is waiting for your input."),
    "completed": ("Task completed", "Claude Code completed a task."),
    "failed": ("Task failed", "Claude Code failed a task."),
}

#: Same wire type as a fresh session (idle), different reason: the model
#: stopped while work it launched is still outstanding.
STOP_IDLE_TEXT = ("Waiting on background work", "Claude Code is waiting for background work to finish.")

#: Text for SUBTASK-scoped events (hooks that fired inside a subagent, and the
#: SubagentStart / SubagentStop hooks). Generic on purpose: no agent prompt, no
#: task description, no command. Which of these push is the relay's decision.
SUBTASK_EVENT_TEXT = {
    "running": ("Subtask running", "A subagent is working."),
    "idle": ("Subtask waiting", "A subagent is waiting."),
    "completed": ("Subtask completed", "A subagent finished its work."),
    "needs_approval": ("Approval needed", "A subagent needs approval."),
    "needs_input": ("Input needed", "A subagent is waiting for your input."),
    "failed": ("Subtask failed", "A subagent stopped with an error."),
}


class UnknownHookEvent(ValueError):
    """The event type is not one of the four a hook is allowed to send."""


def build_hook_event(event_type: str, context: HookContext | None = None) -> AgentEvent:
    """Return a fresh, validated event for one of the five hook types.

    ``context`` carries only derived identity (hashed project id, folder name,
    hashed task id). It is optional: without it the event is the same
    nine-field shape it has always been, and the receiver groups by agent.

    A ``Stop`` hook always passes the literal ``completed``; with a context that
    reports outstanding background or scheduled work it is reclassified to
    ``idle`` here (see hook_context.classify_stop). Other types never change.

    A new event id and UTC timestamp are generated per call. Raises
    :class:`UnknownHookEvent` for anything outside ``HOOK_EVENT_TEXT``.
    """
    requested = normalize_type(event_type)
    resolved, is_subtask = resolve_hook(event_type, context)
    normalized = normalize_type(resolved)
    ctx = context or HookContext()

    if is_subtask:
        # Child activity of the main task. taskId stays the PARENT; subtaskId
        # marks the scope, so the receiver can never treat this as a new task
        # or let it complete the parent.
        if normalized not in SUBTASK_EVENT_TEXT:
            raise UnknownHookEvent(normalized)
        title, message = SUBTASK_EVENT_TEXT[normalized]
        return validate_or_raise(
            build_event(
                normalized,
                agent_id=AGENT_ID,
                agent_name=AGENT_NAME,
                provider=PROVIDER,
                title=title,
                message=message,
                task_id=ctx.task_id,
                # Never a project on a child: the parent's project is the
                # main session's, and the receiver already has it (or will
                # have it when the main session's own event arrives).
                project_id=None,
                project_name=None,
                subtask_id=ctx.subtask_id or fallback_subtask_id(ctx),
                agent_type=ctx.agent_type,
            )
        )

    if normalized not in HOOK_EVENT_TEXT:
        raise UnknownHookEvent(normalized)
    # A Stop that was reclassified to idle explains itself differently from a
    # session that has simply been opened.
    title, message = (
        STOP_IDLE_TEXT if requested == "completed" and normalized == "idle" else HOOK_EVENT_TEXT[normalized]
    )
    return validate_or_raise(
        build_event(
            normalized,
            agent_id=AGENT_ID,
            agent_name=AGENT_NAME,
            provider=PROVIDER,
            title=title,
            message=message,
            task_id=ctx.task_id,
            project_id=ctx.project_id,
            project_name=ctx.project_name,
        )
    )
