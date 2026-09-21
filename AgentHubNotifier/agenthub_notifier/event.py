"""Provider-neutral agent event model.

Deliberately minimal: an event carries only what is needed to show a single
line on a phone lock screen. There is no free-form payload field, so no agent
can smuggle code, logs, file contents or secrets through this structure.

This module performs NO input/output of any kind.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

#: Wire-protocol version. Bump only on a breaking change to the structure.
PROTOCOL_VERSION = 1

#: The seven event types every provider must map onto. ``idle`` means the agent
#: has stopped responding but work it launched is still outstanding.
EVENT_TYPES = (
    "started",
    "running",
    "idle",
    "completed",
    "needs_approval",
    "needs_input",
    "failed",
)

#: Recognised providers. "custom" is the catch-all for anything else.
PROVIDERS = ("claude", "openai", "custom")

# Conservative limits: these strings may end up on a lock screen.
MAX_TITLE_LENGTH = 100
MAX_MESSAGE_LENGTH = 300
MAX_AGENT_NAME_LENGTH = 64
MAX_AGENT_ID_LENGTH = 64
MAX_TASK_ID_LENGTH = 64
MAX_EVENT_ID_LENGTH = 64
MAX_PROJECT_ID_LENGTH = 64
MAX_PROJECT_NAME_LENGTH = 80
MAX_SUBTASK_ID_LENGTH = 64
MAX_AGENT_TYPE_LENGTH = 40

AGENT_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
TASK_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]+$")
EVENT_ID_PATTERN = re.compile(r"^evt-[a-f0-9]{8,}$")
PROJECT_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]+$")
SUBTASK_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]+$")
#: A subagent type is a short plain name ("Explore", "security-reviewer").
AGENT_TYPE_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.-]*$")
#: A project NAME is a folder name. Anything that looks like a path -- a
#: separator, a drive prefix, a parent reference -- is refused outright rather
#: than trimmed, so a full path can never validate its way onto the wire.
PROJECT_NAME_FORBIDDEN = re.compile(r"[\\/]|^[A-Za-z]:|^\.\.?$")

# Default one-liners per event type. "{agent}" is the display name.
DEFAULT_TITLES = {
    "started": "Task started",
    "running": "Task running",
    "idle": "Waiting on background work",
    "completed": "Task completed",
    "needs_approval": "Approval needed",
    "needs_input": "Input needed",
    "failed": "Task failed",
}

DEFAULT_MESSAGES = {
    "started": "{agent} started a task.",
    "running": "{agent} is working.",
    "idle": "{agent} is waiting for background work to finish.",
    "completed": "{agent} finished its task.",
    "needs_approval": "{agent} needs approval.",
    "needs_input": "{agent} needs input.",
    "failed": "{agent} failed.",
}


def new_event_id() -> str:
    """Return a fresh, unique event id such as ``evt-3f9c...``."""
    return "evt-" + uuid.uuid4().hex


def utc_now_iso() -> str:
    """Return the current time as a UTC ISO-8601 string, e.g. ``2026-09-20T12:00:00Z``."""
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def normalize_type(raw: str) -> str:
    """Accept CLI-friendly spellings (``needs-approval``) for the canonical name."""
    return (raw or "").strip().lower().replace("-", "_")


def collapse_whitespace(text: str) -> str:
    """Flatten any run of whitespace to a single space and trim the ends.

    This is a normalisation helper, not a security control: control characters
    that survive it are rejected outright by the validator.
    """
    return " ".join((text or "").split())


def slugify_agent_id(name: str) -> str:
    """Derive a stable, safe agent id from a display name."""
    slug = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    return (slug or "agent")[:MAX_AGENT_ID_LENGTH]


def infer_provider(agent_name: str) -> str:
    """Best-effort provider guess from the display name; falls back to ``custom``."""
    lowered = (agent_name or "").lower()
    if "claude" in lowered or "anthropic" in lowered:
        return "claude"
    if "codex" in lowered or "openai" in lowered or "gpt" in lowered:
        return "openai"
    return "custom"


@dataclass(frozen=True)
class AgentEvent:
    """One normalised status event. Immutable once built."""

    event_id: str
    agent_id: str
    agent_name: str
    provider: str
    type: str
    title: str
    message: str
    timestamp: str
    task_id: str | None = None
    #: Optional workspace identity (see hook_context.py). Never a path.
    project_id: str | None = None
    project_name: str | None = None
    #: Set only for child activity of ``task_id`` (a subagent). Its presence is
    #: the scope marker: such an event may never create or complete a task.
    subtask_id: str | None = None
    #: Sanitised subagent name, subtasks only. Never a prompt or command.
    agent_type: str | None = None
    version: int = PROTOCOL_VERSION

    def to_dict(self) -> dict:
        """Return the wire form.

        Key order is stable. ``taskId``, ``projectId`` and ``projectName`` are
        omitted when unset, so an event without them is byte-for-byte the same
        nine-field shape as before those fields existed.
        """
        data = {
            "version": self.version,
            "eventId": self.event_id,
            "agentId": self.agent_id,
            "agentName": self.agent_name,
            "provider": self.provider,
            "type": self.type,
            "title": self.title,
            "message": self.message,
            "timestamp": self.timestamp,
        }
        if self.task_id:
            data["taskId"] = self.task_id
        if self.project_id:
            data["projectId"] = self.project_id
        if self.project_name:
            data["projectName"] = self.project_name
        if self.subtask_id:
            data["subtaskId"] = self.subtask_id
        if self.agent_type:
            data["agentType"] = self.agent_type
        return data


def build_event(
    event_type: str,
    *,
    agent_name: str | None = None,
    agent_id: str | None = None,
    provider: str | None = None,
    task_id: str | None = None,
    title: str | None = None,
    message: str | None = None,
    timestamp: str | None = None,
    event_id: str | None = None,
    project_id: str | None = None,
    project_name: str | None = None,
    subtask_id: str | None = None,
    agent_type: str | None = None,
) -> AgentEvent:
    """Assemble an event, filling in safe defaults.

    Nothing here rejects bad input -- that is the validator's job, so that the
    same checks apply no matter how an event was constructed.
    """
    etype = normalize_type(event_type)
    name = collapse_whitespace(agent_name) if agent_name else "Agent"
    resolved_provider = (provider or infer_provider(name)).strip().lower()

    resolved_title = collapse_whitespace(title) if title else DEFAULT_TITLES.get(etype, "Agent update")
    if message:
        resolved_message = collapse_whitespace(message)
    else:
        template = DEFAULT_MESSAGES.get(etype, "{agent} sent an update.")
        resolved_message = template.format(agent=name)

    return AgentEvent(
        event_id=event_id or new_event_id(),
        agent_id=(agent_id.strip().lower() if agent_id else slugify_agent_id(name)),
        agent_name=name,
        provider=resolved_provider,
        type=etype,
        title=resolved_title,
        message=resolved_message,
        timestamp=timestamp or utc_now_iso(),
        task_id=collapse_whitespace(task_id) if task_id else None,
        project_id=collapse_whitespace(project_id) if project_id else None,
        project_name=collapse_whitespace(project_name) if project_name else None,
        subtask_id=collapse_whitespace(subtask_id) if subtask_id else None,
        agent_type=collapse_whitespace(agent_type) if agent_type else None,
    )
