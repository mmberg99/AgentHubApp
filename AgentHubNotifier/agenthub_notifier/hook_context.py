"""Project/task identity and Stop classification from the Claude Code hook payload.

THE ALLOW-LIST
    Exactly four keys are read from the JSON Claude Code writes to a hook's
    stdin, by name, in ``extract_hook_context`` and nowhere else:

        cwd               -> projectId / projectName (derived; see below)
        session_id        -> taskId (derived)
        background_tasks  -> ONE boolean: is the list non-empty?
        session_crons     -> ONE boolean: is the list non-empty?

    Nothing else is inspected, stored, logged or forwarded -- not
    ``transcript_path``, not ``tool_input``, not ``last_assistant_message``,
    not any future field.

    For the two lists the question answered is only "is there outstanding
    work?". Their ELEMENTS are never read: a background task's description,
    shell command, agent type, server or tool name, and a cron's prompt or
    schedule, never leave the list they arrived in. ``len()`` on a list does
    not touch its elements, and that is the only operation applied.

STOP CLASSIFICATION (structural, never from prose)
    Claude Code fires ``Stop`` whenever the model stops responding -- including
    while tests, shell commands, subagents or scheduled work it launched are
    still running. Treating every Stop as "done" would notify too early, so:

        Stop + outstanding background or scheduled work  -> idle       (no push)
        Stop + nothing outstanding                       -> completed  (push)

    Decided from the payload at that instant. No timers, no grace period, no
    waiting on anything outside that session.

WHAT LEAVES THE MACHINE
    Only derived values, and only these three:

        projectName   the workspace folder's own name, e.g. "RobotFramework"
        projectId     "p-" + sha256(normalised cwd)[:12]
        taskId        "s-" + sha256(session_id)[:16]

    The full working directory and the raw session id never appear on the
    returned object. ``HookContext`` has no attribute that could hold them, so
    a caller cannot forward what it was never given.

WHY HASH
    The path hash gives a stable project identity across events without the
    path. Windows paths are case-insensitive, so the hash is taken over a
    case-folded, separator-normalised form: ``C:\\Repos\\X`` and ``c:/repos/x/``
    are the same project. The session hash gives a stable task identity so two
    concurrent sessions in one workspace are two tasks under one project.

This module performs NO input/output of any kind.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass

from .event import PROJECT_NAME_FORBIDDEN

#: The complete set of hook payload keys this package is permitted to read.
#:
#:   agent_id    present only when a hook fires INSIDE A SUBAGENT. Used for two
#:               things and nothing else: to route the event as child activity
#:               of the main task (never as a task of its own), and, hashed
#:               together with the session id, to give that subagent a stable
#:               identity. The raw value never leaves.
#:   agent_type  the subagent's name, e.g. "Explore". Exposed only when it is a
#:               short plain identifier (see sanitize_agent_type) and only for
#:               subagents.
ALLOWED_HOOK_KEYS = ("cwd", "session_id", "background_tasks", "session_crons", "agent_id", "agent_type")

PROJECT_ID_PREFIX = "p-"
TASK_ID_PREFIX = "s-"
SUBTASK_ID_PREFIX = "t-"
PROJECT_HASH_CHARS = 12
TASK_HASH_CHARS = 16
SUBTASK_HASH_CHARS = 16

#: A safe agent type is a short plain name. Anything else is dropped, not trimmed.
MAX_AGENT_TYPE_LENGTH = 40
_AGENT_TYPE_OK = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.-]*$")

#: Longer than any sane path or id; anything bigger is treated as absent.
MAX_INPUT_LENGTH = 4096

#: Matches the wire limit in event.py; a longer folder name is truncated.
MAX_PROJECT_NAME_LENGTH = 80

_DRIVE_ONLY = re.compile(r"^[A-Za-z]:$")


@dataclass(frozen=True)
class HookContext:
    """The derived identity handed to the event builder.

    Every field is optional so an event can still be sent when the payload is
    missing, malformed or lacks a key -- the receiver then falls back to its
    per-agent grouping, exactly as before this module existed.

    Deliberately has NO ``cwd`` and NO ``session_id`` field, and holds the
    background/scheduled work as two booleans -- never the lists themselves.
    """

    project_id: str | None = None
    project_name: str | None = None
    task_id: str | None = None
    has_background_work: bool = False
    has_scheduled_work: bool = False
    #: Set only when the hook fired inside a subagent: hash(session_id | agent_id).
    #: Its presence means "child activity of task_id", never a task of its own.
    subtask_id: str | None = None
    #: Sanitised subagent name, or None. Never a prompt, path or command.
    agent_type: str | None = None

    @property
    def has_outstanding_work(self) -> bool:
        return self.has_background_work or self.has_scheduled_work

    @property
    def is_subtask(self) -> bool:
        return self.subtask_id is not None


def _sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def normalise_workspace_path(cwd: str) -> str:
    """Canonical form used for hashing: forward slashes, no trailing slash, case-folded."""
    text = cwd.strip().replace("\\", "/")
    text = re.sub(r"/+", "/", text)
    text = text.rstrip("/")
    return text.casefold()


def project_name_from_path(cwd: str) -> str | None:
    """The last path segment, or None when there is no meaningful name (a bare drive)."""
    norm = cwd.strip().replace("\\", "/").rstrip("/")
    base = norm.rsplit("/", 1)[-1].strip()
    if not base or _DRIVE_ONLY.match(base):
        return None
    name = " ".join(base.split())[:MAX_PROJECT_NAME_LENGTH]
    # A "basename" that still looks like a path -- a drive prefix with no
    # separator, "." or ".." -- means the input was not a real directory path.
    # Report NO project rather than hand the validator something it will
    # refuse: the validator rejects the whole event, and a notification must
    # never be lost over identity metadata.
    if PROJECT_NAME_FORBIDDEN.search(name):
        return None
    return name


def derive_project(cwd: object) -> tuple[str | None, str | None]:
    """Return ``(project_id, project_name)`` for a working directory, or ``(None, None)``."""
    if not isinstance(cwd, str) or not cwd.strip() or len(cwd) > MAX_INPUT_LENGTH:
        return (None, None)
    name = project_name_from_path(cwd)
    if name is None:
        return (None, None)
    digest = _sha256_hex(normalise_workspace_path(cwd))
    return (PROJECT_ID_PREFIX + digest[:PROJECT_HASH_CHARS], name)


def derive_task_id(session_id: object) -> str | None:
    """Return the opaque task id for a session id, or None when unusable."""
    if not isinstance(session_id, str) or not session_id.strip() or len(session_id) > MAX_INPUT_LENGTH:
        return None
    return TASK_ID_PREFIX + _sha256_hex(session_id.strip())[:TASK_HASH_CHARS]


def derive_subtask_id(session_id: object, agent_id: object) -> str | None:
    """Stable, opaque identity for one subagent within one main session.

    Hashes the parent session id together with the agent id, so the same
    subagent maps to the same id across all of its events, two subagents in
    one session never collide, and neither raw value is recoverable.
    """
    if not isinstance(session_id, str) or not session_id.strip() or len(session_id) > MAX_INPUT_LENGTH:
        return None
    if not isinstance(agent_id, str) or not agent_id.strip() or len(agent_id) > MAX_INPUT_LENGTH:
        return None
    return SUBTASK_ID_PREFIX + _sha256_hex(f"{session_id.strip()}|{agent_id.strip()}")[:SUBTASK_HASH_CHARS]


def sanitize_agent_type(value: object) -> str | None:
    """Return a short plain agent name, or None when the value is anything else."""
    if not isinstance(value, str):
        return None
    name = " ".join(value.split())
    if not name or len(name) > MAX_AGENT_TYPE_LENGTH or not _AGENT_TYPE_OK.match(name):
        return None
    return name


def has_items(value: object) -> bool:
    """True when ``value`` is a non-empty list. The elements are never touched."""
    return isinstance(value, list) and len(value) > 0


def extract_hook_context(payload: object) -> HookContext:
    """Read ONLY the six allow-listed keys from a decoded hook payload.

    Anything that is not a dict yields an empty context. Unknown keys are never
    iterated, so an unexpected field cannot influence the result even by
    accident. The two list-valued keys reduce to booleans here and their
    contents go no further.
    """
    if not isinstance(payload, dict):
        return HookContext()
    session_id = payload.get("session_id")
    task_id = derive_task_id(session_id)
    subtask_id = derive_subtask_id(session_id, payload.get("agent_id"))
    # THE PROJECT BELONGS TO THE MAIN SESSION. A hook that fired inside a
    # subagent may be running in another directory (a worktree, a cd); its
    # cwd must never establish or move the parent's project, so a child
    # context carries no project identity at all. The receiver attaches the
    # child to its parent by task_id and takes the project from there.
    if subtask_id:
        project_id, project_name = None, None
    else:
        project_id, project_name = derive_project(payload.get("cwd"))
    return HookContext(
        project_id=project_id,
        project_name=project_name,
        task_id=task_id,
        has_background_work=has_items(payload.get("background_tasks")),
        has_scheduled_work=has_items(payload.get("session_crons")),
        subtask_id=subtask_id,
        # agent_type is also set for `claude --agent` main sessions; it is
        # exposed only for genuine subagents.
        agent_type=sanitize_agent_type(payload.get("agent_type")) if subtask_id else None,
    )


def classify_stop(context: HookContext) -> str:
    """``Stop`` becomes ``idle`` when work is still outstanding, else ``completed``."""
    return "idle" if context.has_outstanding_work else "completed"


#: Hook arguments reserved for the SubagentStart / SubagentStop hooks. They are
#: subtask-scoped by construction -- even if agent_id were missing from the
#: payload -- so a subagent finishing can never be mistaken for the main
#: session finishing.
SUBAGENT_ARGS = {"subagent_start": "running", "subagent_stop": "completed"}


def resolve_hook(event_type: str, context: HookContext | None) -> tuple[str, bool]:
    """Map a hook's literal argument to ``(wire_type, is_subtask)``.

    SUBTASK SCOPE (child activity of the main task; never a task of its own)
        ``subagent-start`` -> running, ``subagent-stop`` -> completed, always.
        Any other argument whose payload carried ``agent_id`` (a hook that fired
        inside a subagent, e.g. a PermissionRequest) passes through with its own
        type, scoped to the subtask. In this scope nothing is reclassified: a
        subagent's ``completed`` completes the SUBAGENT, not the parent.

    MAIN SCOPE
        ``started`` (SessionStart) -> ``idle``: opening Claude is not working.
        A legacy ``started`` is mapped here so a stale configuration cannot
        produce Running either; this Claude-specific hook never emits the
        ``started`` wire type (still valid for other providers).
        ``completed`` (Stop) -> ``idle`` or ``completed`` (classify_stop).
        Everything else passes through, so ``failed``, ``needs_input`` and
        ``needs_approval`` can never be downgraded by background work.
    """
    normalized = (event_type or "").strip().lower().replace("-", "_")
    if normalized in SUBAGENT_ARGS:
        return SUBAGENT_ARGS[normalized], True
    if context is not None and context.is_subtask:
        return ("running" if normalized == "started" else normalized), True
    if normalized == "started":
        return "idle", False
    if normalized == "completed" and context is not None:
        return classify_stop(context), False
    return normalized, False


def resolve_hook_type(event_type: str, context: HookContext | None) -> str:
    """The wire type alone; see :func:`resolve_hook`."""
    return resolve_hook(event_type, context)[0]


def fallback_subtask_id(context: HookContext | None) -> str:
    """Subtask id for a subagent hook whose payload lacked ``agent_id``.

    Rare, but the scope must still be a subtask (never the parent), so the
    child is attributed to a single anonymous subagent of the parent task.
    """
    parent = context.task_id if context is not None and context.task_id else "unknown"
    return SUBTASK_ID_PREFIX + _sha256_hex(f"{parent}|subagent")[:SUBTASK_HASH_CHARS]
