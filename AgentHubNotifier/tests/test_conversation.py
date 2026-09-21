"""Conversation capture: exactly the approved text crosses, nothing else.

Run from the project root:  python -m unittest discover -s tests -v
"""

from __future__ import annotations

import importlib.util
import io
import json
import pathlib
import sys
import unittest
from unittest import mock

PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agenthub_notifier import conversation  # noqa: E402
from agenthub_notifier.conversation import (  # noqa: E402
    MAX_MESSAGE_CHARS,
    ConversationMessage,
    derive_title,
    extract_conversation,
    new_message_id,
)
from agenthub_notifier.hook_context import extract_hook_context  # noqa: E402
from agenthub_notifier.notifiers import lan_bridge  # noqa: E402
from agenthub_notifier.notifiers.lan_bridge import BridgeConfig, LanBridgeNotifier  # noqa: E402

CWD = "C:/Users/mmarc/source/repos/AgentHub"
SESSION_ID = "9c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f"
AGENT_ID = "agent-SECRET-77"
PROMPT = "Fix the push notification lifecycle so Claude is idle while background tests are still running"
ANSWER = "Implemented the corrected lifecycle.\n\n```ts\nconst x = 1;\n```\nAll 59 tests pass."
NOW = "2026-09-21T20:00:00Z"

#: A realistic UserPromptSubmit payload with every forbidden neighbour present.
PROMPT_PAYLOAD = {
    "session_id": SESSION_ID,
    "transcript_path": "C:/Users/mmarc/.claude/projects/SECRET-TRANSCRIPT.jsonl",
    "cwd": CWD,
    "hook_event_name": "UserPromptSubmit",
    "permission_mode": "acceptEdits",
    "prompt": PROMPT,
    "tool_input": {"command": "rm -rf SECRET-CMD", "file_path": "secret.env"},
    "tool_output": {"output": "TOOL-SECRET-OUTPUT"},
    "tool_name": "Bash",
    "last_assistant_message": "STALE-ASSISTANT-TEXT-MUST-NOT-BE-READ-HERE",
    "env": {"AWS_SECRET_ACCESS_KEY": "AKIA-NOT-REAL"},
    "reasoning": "HIDDEN-CHAIN-OF-THOUGHT",
}
STOP_PAYLOAD = {
    **PROMPT_PAYLOAD,
    "hook_event_name": "Stop",
    "prompt": "STALE-PROMPT-MUST-NOT-BE-READ-ON-STOP",
    "last_assistant_message": ANSWER,
    "stop_hook_active": False,
    "background_tasks": [{"command": "pytest BG-SECRET"}],
    "session_crons": [],
}
SUBAGENT_STOP_PAYLOAD = {
    **STOP_PAYLOAD,
    "hook_event_name": "SubagentStop",
    "agent_id": AGENT_ID,
    "agent_type": "Explore",
    "agent_transcript_path": "C:/Users/mmarc/.claude/projects/AGENT-SECRET.jsonl",
    "last_assistant_message": "Found the Stop hook issue in hook_context.py.",
}
SUBAGENT_PROMPT_PAYLOAD = {
    **PROMPT_PAYLOAD,
    "agent_id": AGENT_ID,
    "agent_type": "Explore",
    "prompt": "Investigate how the Stop hook classifies background work",
}

MUST_NEVER_LEAVE = [
    SESSION_ID,
    AGENT_ID,
    "agent-SECRET",
    CWD,
    "C:/Users",
    "mmarc",
    "SECRET-TRANSCRIPT",
    "AGENT-SECRET",
    "transcript_path",
    "SECRET-CMD",
    "secret.env",
    "TOOL-SECRET-OUTPUT",
    "tool_input",
    "tool_output",
    "AKIA-NOT-REAL",
    "HIDDEN-CHAIN-OF-THOUGHT",
    "reasoning",
    "STALE-ASSISTANT-TEXT",
    "STALE-PROMPT",
    "BG-SECRET",
    "acceptEdits",
    "permission_mode",
]


def ctx(payload):
    return extract_hook_context(payload)


class TestTitleDerivation(unittest.TestCase):
    def test_examples_from_the_specification(self):
        self.assertEqual(derive_title(PROMPT), "Fix push notification lifecycle")
        self.assertEqual(
            derive_title("Add a project/task hierarchy and put Fable subagents underneath the parent task"),
            "Add project/task hierarchy",
        )
        self.assertEqual(derive_title("Implement Web Push"), "Implement Web Push")
        self.assertEqual(derive_title("Now fix duplicate subscriptions"), "Fix duplicate subscriptions")

    def test_noise_whitespace_and_length(self):
        self.assertEqual(derive_title("  please   can you\n\nfix the\tlogin  page?  "), "Fix login page")
        self.assertEqual(derive_title("Hey Claude, I want you to refactor the payroll module."), "Refactor payroll module")
        long = "Investigate " + " ".join(f"component{i}" for i in range(30))
        title = derive_title(long)
        self.assertLessEqual(len(title), 60)
        self.assertLessEqual(len(title.split()), 8)
        self.assertFalse(title.endswith((".", ",", " ")))

    def test_short_or_odd_inputs(self):
        self.assertEqual(derive_title("continue"), "Continue")
        self.assertEqual(derive_title("/code-review ultra"), "Code-review ultra")
        self.assertIsNone(derive_title(""))
        self.assertIsNone(derive_title("   \n  "))
        self.assertIsNone(derive_title(None))
        self.assertIsNone(derive_title(42))

    def test_deterministic(self):
        self.assertEqual(derive_title(PROMPT), derive_title(PROMPT))

    def test_control_characters_never_survive(self):
        self.assertEqual(derive_title("Fix\x00 the\x07 build"), "Fix build")


class TestExtract(unittest.TestCase):
    def test_main_prompt_becomes_a_user_message_with_a_title(self):
        m = extract_conversation(PROMPT_PAYLOAD, "running", ctx(PROMPT_PAYLOAD), NOW)
        self.assertIsNotNone(m)
        self.assertEqual(m.role, "user")
        self.assertEqual(m.text, PROMPT)
        self.assertEqual(m.title, "Fix push notification lifecycle")
        self.assertIsNone(m.subtask_id)
        self.assertRegex(m.task_id, r"^s-[a-f0-9]{16}$")
        self.assertRegex(m.message_id, r"^m-[a-f0-9]{32}$")
        self.assertFalse(m.truncated)

    def test_main_stop_becomes_an_assistant_message_without_a_title(self):
        m = extract_conversation(STOP_PAYLOAD, "completed", ctx(STOP_PAYLOAD), NOW)
        self.assertEqual(m.role, "assistant")
        self.assertEqual(m.text, ANSWER, "code blocks and blank lines preserved")
        self.assertIsNone(m.title)
        self.assertIsNone(m.subtask_id)

    def test_idle_stop_still_records_the_response(self):
        """Stop with background work is reported as idle, but the visible
        response is captured either way -- the whole conversation is wanted."""
        c = ctx(STOP_PAYLOAD)
        self.assertTrue(c.has_outstanding_work)
        m = extract_conversation(STOP_PAYLOAD, "completed", c, NOW)
        self.assertEqual(m.role, "assistant")
        self.assertEqual(m.text, ANSWER)

    def test_hook_argument_decides_which_single_key_is_read(self):
        # On UserPromptSubmit the stale last_assistant_message is ignored...
        m = extract_conversation(PROMPT_PAYLOAD, "running", ctx(PROMPT_PAYLOAD), NOW)
        self.assertNotIn("STALE", m.text)
        # ...and on Stop the stale prompt is ignored.
        m = extract_conversation(STOP_PAYLOAD, "completed", ctx(STOP_PAYLOAD), NOW)
        self.assertNotIn("STALE", m.text)
        # Hooks without conversation text yield nothing, whatever the payload holds.
        for arg in ["idle", "needs-approval", "needs-input", "failed", "subagent-start", "started", "nonsense", ""]:
            with self.subTest(arg=arg):
                self.assertIsNone(extract_conversation(STOP_PAYLOAD, arg, ctx(STOP_PAYLOAD), NOW))

    def test_subagent_stop_output_attaches_to_the_child_never_the_parent(self):
        c = ctx(SUBAGENT_STOP_PAYLOAD)
        m = extract_conversation(SUBAGENT_STOP_PAYLOAD, "subagent-stop", c, NOW)
        self.assertEqual(m.role, "assistant")
        self.assertEqual(m.task_id, ctx(STOP_PAYLOAD).task_id, "parent task id")
        self.assertEqual(m.subtask_id, c.subtask_id, "scoped to the child")
        self.assertIsNotNone(m.subtask_id)
        self.assertEqual(m.text, "Found the Stop hook issue in hook_context.py.")

    def test_child_prompt_if_ever_delivered_is_a_child_message_with_a_child_title(self):
        c = ctx(SUBAGENT_PROMPT_PAYLOAD)
        m = extract_conversation(SUBAGENT_PROMPT_PAYLOAD, "running", c, NOW)
        self.assertEqual(m.role, "user")
        self.assertEqual(m.subtask_id, c.subtask_id)
        self.assertEqual(m.title, "Investigate how Stop hook classifies background work")

    def test_a_message_id_names_one_hook_invocation_never_its_text(self):
        """Identical text on two separate invocations = two turns (two ids).
        Nothing is content-derived, so nothing can collapse by accident."""
        a = extract_conversation(PROMPT_PAYLOAD, "running", ctx(PROMPT_PAYLOAD), NOW)
        b = extract_conversation(PROMPT_PAYLOAD, "running", ctx(PROMPT_PAYLOAD), NOW)
        self.assertEqual(a.text, b.text)
        self.assertNotEqual(a.message_id, b.message_id, "same text, separate invocations, separate turns")
        self.assertRegex(a.message_id, r"^m-[a-f0-9]{32}$")
        ids = {new_message_id() for _ in range(500)}
        self.assertEqual(len(ids), 500)
        # The same invocation reuses its id for every delivery attempt.
        fixed = new_message_id()
        r1 = extract_conversation(STOP_PAYLOAD, "completed", ctx(STOP_PAYLOAD), NOW, message_id=fixed)
        r2 = extract_conversation(STOP_PAYLOAD, "completed", ctx(STOP_PAYLOAD), NOW, message_id=fixed)
        self.assertEqual(r1.message_id, r2.message_id, fixed)
        # Identical assistant text on two Stops is likewise two turns.
        s1 = extract_conversation(STOP_PAYLOAD, "completed", ctx(STOP_PAYLOAD), NOW)
        s2 = extract_conversation(STOP_PAYLOAD, "completed", ctx(STOP_PAYLOAD), NOW)
        self.assertNotEqual(s1.message_id, s2.message_id)

    def test_a_retry_of_one_invocation_puts_the_same_id_on_the_wire(self):
        m = extract_conversation(PROMPT_PAYLOAD, "running", ctx(PROMPT_PAYLOAD), NOW)
        opener = _FakeOpener()
        notifier = LanBridgeNotifier(BridgeConfig(endpoint="http://127.0.0.1:8781/events", token="unit-test-token-0000"), opener=opener)
        notifier.deliver_message(m)
        notifier.deliver_message(m)  # a retry of the same record
        ids = [json.loads(body)["messageId"] for body in opener.calls]
        self.assertEqual(len(ids), 2)
        self.assertEqual(ids[0], ids[1], "the relay can dedupe this replay")

    def test_oversized_text_is_cut_and_marked_never_silently(self):
        big = {**PROMPT_PAYLOAD, "prompt": "x" * (MAX_MESSAGE_CHARS + 5000)}
        m = extract_conversation(big, "running", ctx(big), NOW)
        self.assertTrue(m.truncated)
        self.assertEqual(len(m.text), MAX_MESSAGE_CHARS)
        self.assertTrue(m.to_dict()["truncated"])
        self.assertNotIn("truncated", extract_conversation(PROMPT_PAYLOAD, "running", ctx(PROMPT_PAYLOAD), NOW).to_dict())

    def test_empty_or_non_string_text_yields_nothing(self):
        for bad in ["", "   \n", None, 12, ["list"], {"d": 1}]:
            with self.subTest(bad=bad):
                p = {**PROMPT_PAYLOAD, "prompt": bad}
                self.assertIsNone(extract_conversation(p, "running", ctx(p), NOW))
        self.assertIsNone(extract_conversation("not a dict", "running", ctx(PROMPT_PAYLOAD), NOW))
        # Without a session there is no task to attach to.
        self.assertIsNone(extract_conversation({**PROMPT_PAYLOAD, "session_id": None}, "running", ctx({**PROMPT_PAYLOAD, "session_id": None}), NOW))

    def test_only_the_approved_key_is_read(self):
        """Instrument the payload: for each hook exactly one conversation key is
        touched, plus the identity keys. tool_input, transcript_path, reasoning
        and friends are never even looked at."""
        for payload, arg, expected_key in [
            (PROMPT_PAYLOAD, "running", "prompt"),
            (STOP_PAYLOAD, "completed", "last_assistant_message"),
            (SUBAGENT_STOP_PAYLOAD, "subagent-stop", "last_assistant_message"),
        ]:
            touched = []

            class Spy(dict):
                def get(self, key, default=None):
                    touched.append(key)
                    return super().get(key, default)

                def __getitem__(self, key):
                    touched.append(key)
                    return super().__getitem__(key)

                def __iter__(self):  # pragma: no cover
                    touched.append("<ITERATION>")
                    return super().__iter__()

                def items(self):  # pragma: no cover
                    touched.append("<ITEMS>")
                    return super().items()

            extract_conversation(Spy(payload), arg, ctx(payload), NOW)
            with self.subTest(arg=arg):
                self.assertEqual(set(touched), {expected_key}, touched)


class TestWireBody(unittest.TestCase):
    def _delivered(self, message):
        opener = _FakeOpener()
        notifier = LanBridgeNotifier(
            BridgeConfig(endpoint="http://127.0.0.1:8781/events", token="unit-test-token-0000"),
            opener=opener,
        )
        result = notifier.deliver_message(message)
        return result, opener

    def test_message_goes_to_the_same_loopback_relay_on_messages(self):
        m = extract_conversation(PROMPT_PAYLOAD, "running", ctx(PROMPT_PAYLOAD), NOW)
        result, opener = self._delivered(m)
        self.assertTrue(result.delivered)
        self.assertEqual(opener.urls, ["http://127.0.0.1:8781/messages"])
        self.assertEqual(opener.headers[0]["Authorization"].split(" ")[0], "Bearer")

    def test_wire_shape_is_exactly_the_conversation_record(self):
        m = extract_conversation(PROMPT_PAYLOAD, "running", ctx(PROMPT_PAYLOAD), NOW)
        _, opener = self._delivered(m)
        sent = json.loads(opener.calls[0])
        self.assertEqual(set(sent), {"version", "messageId", "taskId", "role", "text", "timestamp", "title"})
        self.assertEqual(sent["version"], 1)
        self.assertEqual(sent["text"], PROMPT)
        child = extract_conversation(SUBAGENT_STOP_PAYLOAD, "subagent-stop", ctx(SUBAGENT_STOP_PAYLOAD), NOW)
        _, opener = self._delivered(child)
        sent = json.loads(opener.calls[0])
        self.assertEqual(set(sent), {"version", "messageId", "taskId", "subtaskId", "role", "text", "timestamp"})

    def test_privacy_boundary_only_the_approved_text_crosses(self):
        for payload, arg in [(PROMPT_PAYLOAD, "running"), (STOP_PAYLOAD, "completed"), (SUBAGENT_STOP_PAYLOAD, "subagent-stop"), (SUBAGENT_PROMPT_PAYLOAD, "running")]:
            m = extract_conversation(payload, arg, ctx(payload), NOW)
            _, opener = self._delivered(m)
            body = opener.calls[0].decode("utf-8")
            for needle in MUST_NEVER_LEAVE:
                with self.subTest(arg=arg, needle=needle):
                    self.assertNotIn(needle, body)
            # Only the approved text, verbatim.
            approved = payload["prompt"] if arg == "running" else payload["last_assistant_message"]
            self.assertIn(json.dumps(approved, ensure_ascii=False)[1:-1][:40], body)


class TestLauncherEndToEnd(unittest.TestCase):
    """The real launcher, in-process: one status event, one message, in that order."""

    def _run(self, argv, payload):
        spec = importlib.util.spec_from_file_location("agenthub_hook_conv", PROJECT_ROOT / "agenthub-hook.py")
        launcher = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(launcher)
        sent = []

        class _Notifier:
            def deliver(self, event):
                sent.append(("event", json.dumps(event.to_dict())))

            def deliver_message(self, message):
                sent.append(("message", json.dumps(message.to_dict(), ensure_ascii=False)))

        fake_stdin = io.TextIOWrapper(io.BytesIO(json.dumps(payload).encode("utf-8")))
        with mock.patch.object(sys, "stdin", fake_stdin), mock.patch.object(
            lan_bridge.LanBridgeNotifier, "from_env", staticmethod(lambda: _Notifier())
        ):
            launcher.main(argv)
        return sent

    def test_prompt_then_stop_then_subagent_stop(self):
        sent = self._run(["running", "--agent", "Claude", "--quiet"], PROMPT_PAYLOAD)
        self.assertEqual([k for k, _ in sent], ["event", "message"])
        self.assertEqual(json.loads(sent[0][1])["type"], "running")
        self.assertEqual(json.loads(sent[1][1])["role"], "user")
        self.assertEqual(json.loads(sent[1][1])["title"], "Fix push notification lifecycle")

        sent = self._run(["completed"], STOP_PAYLOAD)
        self.assertEqual([k for k, _ in sent], ["event", "message"])
        self.assertEqual(json.loads(sent[0][1])["type"], "idle", "background work outstanding")
        self.assertEqual(json.loads(sent[1][1])["role"], "assistant")

        sent = self._run(["subagent-stop"], SUBAGENT_STOP_PAYLOAD)
        self.assertEqual([k for k, _ in sent], ["event", "message"])
        self.assertIn("subtaskId", json.loads(sent[0][1]))
        self.assertIn("subtaskId", json.loads(sent[1][1]))
        self.assertEqual(json.loads(sent[1][1])["taskId"], json.loads(sent[0][1])["taskId"])

    def test_hooks_without_conversation_text_send_only_the_event(self):
        for argv in [["idle"], ["needs-approval"], ["subagent-start"], ["failed"]]:
            sent = self._run(argv, SUBAGENT_STOP_PAYLOAD if argv == ["subagent-start"] else STOP_PAYLOAD)
            with self.subTest(argv=argv):
                self.assertEqual([k for k, _ in sent], ["event"])

    def test_nothing_forbidden_leaves_through_the_launcher(self):
        for argv, payload in [(["running"], PROMPT_PAYLOAD), (["completed"], STOP_PAYLOAD), (["subagent-stop"], SUBAGENT_STOP_PAYLOAD)]:
            for kind, body in self._run(argv, payload):
                for needle in MUST_NEVER_LEAVE:
                    with self.subTest(argv=argv, kind=kind, needle=needle):
                        self.assertNotIn(needle, body)

    def test_a_status_event_never_carries_conversation_text(self):
        for argv, payload in [(["running"], PROMPT_PAYLOAD), (["completed"], STOP_PAYLOAD)]:
            event_body = self._run(argv, payload)[0][1]
            self.assertNotIn(PROMPT[:30], event_body)
            self.assertNotIn(ANSWER[:30], event_body)
            self.assertNotIn("text", json.loads(event_body))


class _FakeOpener:
    def __init__(self):
        self.calls = []
        self.urls = []
        self.headers = []

    def open(self, request, timeout=None):
        self.calls.append(request.data)
        self.urls.append(request.full_url)
        self.headers.append(dict(request.header_items()))

        class _Resp(io.BytesIO):
            status = 202

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def getcode(self):
                return 202

        return _Resp(b"{}")


if __name__ == "__main__":
    unittest.main()
