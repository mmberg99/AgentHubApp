"""Launcher that lets an agent hook report an AgentHub event.

Spawned directly (no shell) by a Claude Code hook, e.g.:

    python.exe agenthub-hook.py completed

The first argument is the event type and is the ONLY argument that matters; any
further arguments are ignored, so an existing settings.json that still passes
`--agent Claude --quiet` keeps working. The agent identity is fixed (see
hook_events.py), not taken from the command line.

Four properties matter here, and all four are enforced below:

1. The hook payload is read for EXACTLY SIX identity/state KEYS -- plus ONE
   approved conversation key on the three conversation-bearing hooks (see
   ``conversation.py``: ``prompt`` on UserPromptSubmit, ``last_assistant_message``
   on Stop / SubagentStop; the user-visible text, explicitly approved for
   display in the authenticated PWA) -- and then discarded. Claude
   Code writes a JSON object to this process's stdin containing
   `transcript_path`, `cwd`, `session_id`, `tool_input`,
   `last_assistant_message`, `background_tasks`, `session_crons`, `agent_id`,
   `agent_type` and similar. `read_hook_context()` decodes it, hands it to
   `extract_hook_context()` -- which reads `cwd`, `session_id`,
   `background_tasks`, `session_crons`, `agent_id` and `agent_type` by name and
   nothing else -- and deletes the object. What survives is a `HookContext`
   holding a hashed project id, the workspace folder's name, a hashed session
   id, two booleans ("is background work outstanding?", "is scheduled work
   outstanding?"), and -- only when the hook fired inside a subagent -- a
   hashed subagent id plus a sanitised agent name. The raw path, the raw
   session id, the raw agent id and the CONTENTS of the two lists are never
   logged, never stored, and never placed in the outgoing event. No other
   field is ever looked at. Any failure to read or decode simply yields an
   empty context and the event goes out as a plain event.

   `agent_id` decides SCOPE: with it present the event is child activity of
   the main task (a "subtask") and can never create a task of its own or
   complete the parent. The SubagentStart/SubagentStop hooks use the dedicated
   arguments `subagent-start` / `subagent-stop`, which are subtask-scoped
   even if `agent_id` were ever missing.

   The two booleans decide one thing: a `Stop` (argument `completed`) with
   outstanding work is reported as `idle` instead, so a pause for running
   tests or subagents is never announced as "Task completed".

2. Nothing is written to stdout or stderr. Claude Code parses a hook's stdout
   as control JSON (`decision`, `additionalContext`, ...), so the notifier's
   output must not go there.

3. This process ALWAYS exits 0. A notification is passive: it must never block
   a tool call, fail a turn, or feed anything back to the model. An unreachable
   relay, a missing token and a malformed URL are all silent no-ops.

4. Delivery is one attempt with a 2 second timeout, to a private address only.
   Well inside the hook's 5 second budget.
"""

from __future__ import annotations

import json
import pathlib
import sys

#: Stop reading long before memory is a concern. A real hook payload is a few
#: kilobytes; anything past this cap is drained and thrown away undecoded.
_MAX_READ_BYTES = 1 * 1024 * 1024
_MAX_DRAIN_BYTES = 4 * 1024 * 1024


def _read_stdin_bytes() -> bytes:
    """Return up to ``_MAX_READ_BYTES`` of stdin, draining the remainder.

    Returns b"" when stdin is a terminal or unavailable, since there would be no
    payload and reading would block. Draining keeps the parent's write from
    failing with EPIPE.
    """
    stream = getattr(sys, "stdin", None)
    if stream is None:
        return b""
    try:
        if stream.isatty():
            return b""
        buffer = stream.buffer
    except Exception:
        return b""

    chunks: list[bytes] = []
    total = 0
    try:
        while total < _MAX_DRAIN_BYTES:
            chunk = buffer.read(65536)
            if not chunk:
                break
            total += len(chunk)
            if total <= _MAX_READ_BYTES:
                chunks.append(chunk)
            # Past the read cap: keep draining, keep nothing.
            del chunk
    except Exception:
        pass
    return b"".join(chunks) if total <= _MAX_READ_BYTES else b""


def read_hook_input(hook_arg: str | None):
    """Decode the payload ONCE; keep the derived context and, for the three
    conversation-bearing hooks, the one approved text field; drop the rest.

    Returns ``(HookContext, ConversationMessage | None)``.
    """
    from agenthub_notifier.conversation import extract_conversation
    from agenthub_notifier.event import utc_now_iso
    from agenthub_notifier.hook_context import HookContext, extract_hook_context

    raw = _read_stdin_bytes()
    if not raw:
        return HookContext(), None
    try:
        payload = json.loads(raw)
    except Exception:
        return HookContext(), None
    finally:
        del raw
    try:
        context = extract_hook_context(payload)
    except Exception:
        del payload
        return HookContext(), None
    message = None
    if hook_arg:
        try:
            message = extract_conversation(payload, hook_arg, context, utc_now_iso())
        except Exception:
            message = None
    del payload
    return context, message


def read_hook_context():
    """Backward-compatible alias: context only."""
    return read_hook_input(None)[0]


def main(argv: list[str]) -> None:
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
    hook_arg = argv[0] if argv else None
    context, message = read_hook_input(hook_arg)
    if not hook_arg:
        return

    from agenthub_notifier.hook_events import UnknownHookEvent, build_hook_event
    from agenthub_notifier.notifiers.lan_bridge import (
        BridgeConfigurationError,
        LanBridgeNotifier,
    )

    try:
        event = build_hook_event(hook_arg, context)
    except UnknownHookEvent:
        return
    try:
        notifier = LanBridgeNotifier.from_env()
    except BridgeConfigurationError:
        return
    notifier.deliver(event)
    # The visible conversation text travels as its own small record to the
    # SAME loopback relay. Status first, so the task exists before its message.
    if message is not None:
        try:
            notifier.deliver_message(message)
        except Exception:
            pass


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except Exception:
        # Deliberately silent and deliberately successful: see property 3.
        pass
    raise SystemExit(0)
