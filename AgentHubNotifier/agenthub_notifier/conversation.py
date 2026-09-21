"""Conversation capture: the USER-VISIBLE prompt/response text, and nothing else.

PRIVACY SCOPE (explicitly approved 2026-09-21)
    Two hook payload keys may now leave the machine as display text:

        prompt                  on UserPromptSubmit  (hook argument ``running``)
        last_assistant_message  on Stop / SubagentStop (``completed`` / ``subagent-stop``)

    Each is read by name, only for the hook it belongs to, and travels in its
    own ConversationMessage record -- never inside a status event and never
    inside a Web Push payload. Everything else in the payload keeps its old
    status: ``transcript_path``, ``tool_input``, ``tool_output``, ``tool_name``,
    commands, environment data, raw ``cwd`` / ``session_id`` / ``agent_id`` are
    never read for this purpose and never leave. Hidden reasoning is not part
    of any hook payload and is therefore never available here at all.

IDENTITY
    A message points at the parent task (hashed session id) and, when the hook
    fired inside a subagent, at the child (hashed session id | agent id). A
    child prompt is never a main-task prompt; a SubagentStop response is never
    the parent's response.

IDENTITY OF A MESSAGE = ONE HOOK INVOCATION
    Claude Code's hook payload carries no per-invocation identifier (checked
    against the installed 2.1.x: ``prompt_id`` names the TURN, and a Stop can
    fire more than once per turn via ``stop_hook_active``, so it cannot tell
    two visible responses apart). Therefore ``messageId`` is a fresh
    cryptographically random id minted ONCE per hook invocation and reused for
    every delivery attempt of that invocation. A retry is the same message and
    the relay keeps one copy; a separate invocation -- even with byte-identical
    text -- is a separate turn and is kept. Nothing is ever deduplicated by
    text.

SIZE
    A message longer than MAX_MESSAGE_CHARS is cut at that length and marked
    ``truncated: true`` -- explicitly, never silently.
"""

from __future__ import annotations

import re
import secrets
from dataclasses import dataclass

from .hook_context import HookContext

#: Longest text carried in one message. Above this the text is cut and marked.
MAX_MESSAGE_CHARS = 20_000
#: Derived title length cap (characters) and word cap.
MAX_TITLE_CHARS = 60
MAX_TITLE_WORDS = 8
MIN_TITLE_WORDS = 3

#: Which hook argument yields which payload key and role. Nothing else is read.
CONVERSATION_SOURCES = {
    "running": ("prompt", "user"),
    "completed": ("last_assistant_message", "assistant"),
    "subagent_stop": ("last_assistant_message", "assistant"),
}


def _normalize_arg(value: object) -> str:
    return str(value or "").strip().lower().replace("-", "_")

ROLES = ("user", "assistant")

_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


@dataclass(frozen=True)
class ConversationMessage:
    message_id: str
    task_id: str
    role: str
    text: str
    timestamp: str
    subtask_id: str | None = None
    truncated: bool = False
    #: Only on a role=user message: the title derived from THIS prompt. The
    #: receiver applies it once (first prompt wins) and never overwrites.
    title: str | None = None

    def to_dict(self) -> dict:
        body = {
            "version": 1,
            "messageId": self.message_id,
            "taskId": self.task_id,
            "role": self.role,
            "text": self.text,
            "timestamp": self.timestamp,
        }
        if self.subtask_id:
            body["subtaskId"] = self.subtask_id
        if self.truncated:
            body["truncated"] = True
        if self.title:
            body["title"] = self.title
        return body


# ------------------------------------------------------------------ title

_LEADING_NOISE = [
    r"hey claude[,!]?",
    r"hi claude[,!]?",
    r"claude[,:]",
    r"please",
    r"pls",
    r"ok(?:ay)?[,]?",
    r"so[,]?",
    r"now[,]?",
    r"next[,]?",
    r"also[,]?",
    r"then[,]?",
    r"can you",
    r"could you",
    r"would you",
    r"will you",
    r"i want you to",
    r"i'd like you to",
    r"i would like you to",
    r"i need you to",
    r"i want to",
    r"i'd like to",
    r"i would like to",
    r"i need to",
    r"let's",
    r"lets",
    r"go ahead and",
    r"try to",
]
_LEADING_NOISE_RE = re.compile(r"^(?:" + "|".join(_LEADING_NOISE) + r")\s+", re.IGNORECASE)

#: Where the first clause ends. Sentence punctuation first, then joiners that
#: usually introduce the "why" or a second instruction.
_SENTENCE_END_RE = re.compile(r"[.!?;:]\s|\s[-–—]\s|\n")
_CLAUSE_JOINER_RE = re.compile(
    r"\s(?:so that|so|because|since|while|when|whenever|where|which|in order to|such that|and then|and|but|to make sure|making sure)\s",
    re.IGNORECASE,
)
_ARTICLE_RE = re.compile(r"\b(?:a|an|the)\s+", re.IGNORECASE)
_TRAILING_PUNCT_RE = re.compile(r"[\s.,;:!?\-–—(\[{\"'`]+$")


def derive_title(prompt: object) -> str | None:
    """A concise, deterministic title from the FIRST prompt of a conversation.

    Whitespace is collapsed, obvious leading conversational noise dropped, the
    first clause taken, articles removed, then capped at MAX_TITLE_WORDS words
    and MAX_TITLE_CHARS characters on a word boundary. Purely local; no model.
    """
    if not isinstance(prompt, str):
        return None
    text = " ".join(_CONTROL.sub(" ", prompt).split())
    if not text:
        return None

    # A bare slash command names itself.
    if text.startswith("/"):
        text = text[1:]

    # Strip stacked leading noise ("ok, please can you ...").
    for _ in range(4):
        stripped = _LEADING_NOISE_RE.sub("", text, count=1)
        if stripped == text:
            break
        text = stripped
    if not text:
        return None

    first = _SENTENCE_END_RE.split(text, maxsplit=1)[0]
    clause = _CLAUSE_JOINER_RE.split(first, maxsplit=1)[0]
    # A clause that is too short to mean anything falls back to the sentence.
    candidate = clause if len(clause.split()) >= MIN_TITLE_WORDS else first
    if len(candidate.split()) < MIN_TITLE_WORDS:
        candidate = text

    candidate = _ARTICLE_RE.sub("", candidate)
    words = candidate.split()[:MAX_TITLE_WORDS]
    title = " ".join(words)
    if len(title) > MAX_TITLE_CHARS:
        cut = title[: MAX_TITLE_CHARS + 1]
        title = cut[: cut.rfind(" ")] if " " in cut else cut[:MAX_TITLE_CHARS]
    title = _TRAILING_PUNCT_RE.sub("", title).strip()
    if not title:
        return None
    return title[0].upper() + title[1:]


# ----------------------------------------------------------------- extract


def new_message_id() -> str:
    """A fresh 128-bit random id for ONE hook invocation. Never content-derived."""
    return "m-" + secrets.token_hex(16)


def clean_text(value: str) -> str:
    """Drop C0 control characters (except newline / tab), normalise CRLF."""
    return _CONTROL.sub("", value.replace("\r\n", "\n").replace("\r", "\n")).strip()


def extract_conversation(
    payload: object,
    hook_arg: str,
    context: HookContext,
    timestamp: str,
    message_id: str | None = None,
) -> ConversationMessage | None:
    """Read ONLY the one conversation key that ``hook_arg`` permits.

    Returns None when the hook carries no conversation text (SessionStart,
    PermissionRequest, SubagentStart, empty prompt, ...), when the identity is
    missing, or when the payload is not a dict. Nothing else is inspected.

    ``message_id`` identifies THIS hook invocation; when omitted a fresh random
    one is minted. The launcher calls this exactly once per invocation, so the
    id is shared by every delivery attempt of that invocation and by nothing
    else.
    """
    source = CONVERSATION_SOURCES.get(_normalize_arg(hook_arg))
    if source is None or not isinstance(payload, dict) or not context.task_id:
        return None
    key, role = source
    raw = payload.get(key)
    # Claude Code 2.1.x sends the submitted text as `prompt`; the published
    # reference also names `user_input`. Both are the same user-visible text,
    # so the documented alias is accepted when `prompt` is absent.
    if raw is None and key == "prompt":
        raw = payload.get("user_input")
    if not isinstance(raw, str):
        return None
    text = clean_text(raw)
    if not text:
        return None

    truncated = False
    if len(text) > MAX_MESSAGE_CHARS:
        text = text[:MAX_MESSAGE_CHARS]
        truncated = True

    # Scope follows the status event exactly: agent_id present -> child.
    return ConversationMessage(
        message_id=message_id or new_message_id(),
        task_id=context.task_id,
        subtask_id=context.subtask_id if context.is_subtask else None,
        role=role,
        text=text,
        timestamp=timestamp,
        truncated=truncated,
        title=derive_title(text) if role == "user" else None,
    )
