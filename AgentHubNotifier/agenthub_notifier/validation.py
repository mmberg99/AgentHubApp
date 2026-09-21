"""Validation for agent events.

Every event is checked here before any notifier sees it. The rules are
deliberately strict: an event that cannot be shown safely on a lock screen is
rejected rather than trimmed, so a caller never silently ships something it did
not intend.

This module performs NO input/output of any kind.
"""

from __future__ import annotations

from datetime import datetime, timezone

from .event import (
    AGENT_ID_PATTERN,
    EVENT_ID_PATTERN,
    EVENT_TYPES,
    MAX_AGENT_ID_LENGTH,
    MAX_AGENT_NAME_LENGTH,
    MAX_EVENT_ID_LENGTH,
    AGENT_TYPE_PATTERN,
    MAX_AGENT_TYPE_LENGTH,
    MAX_MESSAGE_LENGTH,
    MAX_PROJECT_ID_LENGTH,
    MAX_PROJECT_NAME_LENGTH,
    MAX_SUBTASK_ID_LENGTH,
    MAX_TASK_ID_LENGTH,
    MAX_TITLE_LENGTH,
    PROJECT_ID_PATTERN,
    PROJECT_NAME_FORBIDDEN,
    PROTOCOL_VERSION,
    PROVIDERS,
    SUBTASK_ID_PATTERN,
    TASK_ID_PATTERN,
    AgentEvent,
)


class ValidationError(Exception):
    """Raised when an event fails validation. Carries every problem found."""

    def __init__(self, errors: list[str]) -> None:
        self.errors = list(errors)
        super().__init__("; ".join(self.errors))


def _has_control_characters(text: str) -> bool:
    """True if the string contains control characters (newlines, tabs, escapes...).

    These are barred because they enable log/notification spoofing and are the
    usual sign that raw terminal output or a file has been pasted in.
    """
    return any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in text)


def _check_text(value, field: str, max_length: int, errors: list[str], *, required: bool = True) -> None:
    if value is None:
        if required:
            errors.append(f"{field}: missing required field")
        return
    if not isinstance(value, str):
        errors.append(f"{field}: must be a string")
        return
    if required and not value.strip():
        errors.append(f"{field}: missing required field")
        return
    if _has_control_characters(value):
        errors.append(f"{field}: must not contain control characters or line breaks")
    if len(value) > max_length:
        errors.append(f"{field}: exceeds maximum length of {max_length} characters (got {len(value)})")


def validate_timestamp(value) -> list[str]:
    """Check that the timestamp is an ISO-8601 instant expressed in UTC."""
    if not isinstance(value, str) or not value.strip():
        return ["timestamp: missing required field"]
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return ["timestamp: must be an ISO-8601 UTC timestamp, e.g. 2026-09-20T12:00:00Z"]
    if parsed.tzinfo is None:
        return ["timestamp: must include a timezone and be in UTC"]
    if parsed.utcoffset() != timezone.utc.utcoffset(None):
        return ["timestamp: must be in UTC (offset +00:00 or trailing Z)"]
    return []


def validate(event: AgentEvent) -> list[str]:
    """Return a list of problems with the event. Empty list means it is valid."""
    errors: list[str] = []

    if not isinstance(event, AgentEvent):
        return ["event: must be an AgentEvent instance"]

    if event.version != PROTOCOL_VERSION:
        errors.append(
            f"version: unsupported protocol version {event.version!r} (this build speaks {PROTOCOL_VERSION})"
        )

    if event.type not in EVENT_TYPES:
        errors.append(f"type: unknown event type {event.type!r} (expected one of {', '.join(EVENT_TYPES)})")

    if event.provider not in PROVIDERS:
        errors.append(f"provider: unsupported provider {event.provider!r} (expected one of {', '.join(PROVIDERS)})")

    _check_text(event.event_id, "eventId", MAX_EVENT_ID_LENGTH, errors)
    if isinstance(event.event_id, str) and event.event_id and not EVENT_ID_PATTERN.match(event.event_id):
        errors.append("eventId: must look like 'evt-' followed by lowercase hex")

    _check_text(event.agent_id, "agentId", MAX_AGENT_ID_LENGTH, errors)
    if isinstance(event.agent_id, str) and event.agent_id.strip() and not AGENT_ID_PATTERN.match(event.agent_id):
        errors.append("agentId: may contain only lowercase letters, digits, dot, dash and underscore")

    _check_text(event.agent_name, "agentName", MAX_AGENT_NAME_LENGTH, errors)
    _check_text(event.title, "title", MAX_TITLE_LENGTH, errors)
    _check_text(event.message, "message", MAX_MESSAGE_LENGTH, errors)

    if event.task_id is not None:
        _check_text(event.task_id, "taskId", MAX_TASK_ID_LENGTH, errors, required=False)
        if isinstance(event.task_id, str) and event.task_id.strip() and not TASK_ID_PATTERN.match(event.task_id):
            errors.append("taskId: may contain only letters, digits, dot, dash, colon and underscore")

    if event.project_id is not None:
        _check_text(event.project_id, "projectId", MAX_PROJECT_ID_LENGTH, errors, required=False)
        if isinstance(event.project_id, str) and event.project_id.strip() and not PROJECT_ID_PATTERN.match(event.project_id):
            errors.append("projectId: may contain only letters, digits, dot, dash, colon and underscore")

    if event.project_name is not None:
        _check_text(event.project_name, "projectName", MAX_PROJECT_NAME_LENGTH, errors, required=False)
        if isinstance(event.project_name, str) and PROJECT_NAME_FORBIDDEN.search(event.project_name.strip()):
            # A path here would put directory structure on a phone. Refuse it
            # entirely rather than trim it -- the sender has a bug to fix.
            errors.append("projectName: must be a folder name, not a path")

    if event.subtask_id is not None:
        _check_text(event.subtask_id, "subtaskId", MAX_SUBTASK_ID_LENGTH, errors, required=False)
        if isinstance(event.subtask_id, str) and event.subtask_id.strip() and not SUBTASK_ID_PATTERN.match(event.subtask_id):
            errors.append("subtaskId: may contain only letters, digits, dot, dash, colon and underscore")
        if not event.task_id:
            # A subtask without a parent could be misread as a task of its own.
            errors.append("subtaskId: requires taskId (the parent task)")

    if event.agent_type is not None:
        _check_text(event.agent_type, "agentType", MAX_AGENT_TYPE_LENGTH, errors, required=False)
        if isinstance(event.agent_type, str) and event.agent_type.strip() and not AGENT_TYPE_PATTERN.match(event.agent_type):
            errors.append("agentType: must be a short plain name")

    errors.extend(validate_timestamp(event.timestamp))
    return errors


def validate_or_raise(event: AgentEvent) -> AgentEvent:
    """Return the event unchanged, or raise :class:`ValidationError`."""
    errors = validate(event)
    if errors:
        raise ValidationError(errors)
    return event


class EventValidator:
    """Object wrapper around the module-level functions, for callers that prefer one."""

    def validate(self, event: AgentEvent) -> list[str]:
        return validate(event)

    def validate_or_raise(self, event: AgentEvent) -> AgentEvent:
        return validate_or_raise(event)

    def is_valid(self, event: AgentEvent) -> bool:
        return not validate(event)
