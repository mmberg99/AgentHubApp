"""Project/task identity: what the hook may learn, and what may never leave.

Standard library only. Nothing here touches the network: delivery is captured
by a fake opener and the launcher is exercised in-process against a fake stdin.

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

from agenthub_notifier import hook_context  # noqa: E402
from agenthub_notifier.event import build_event  # noqa: E402
from agenthub_notifier.hook_context import (  # noqa: E402
    HookContext,
    derive_project,
    derive_task_id,
    extract_hook_context,
)
from agenthub_notifier.hook_events import HOOK_EVENT_TEXT, build_hook_event  # noqa: E402
from agenthub_notifier.notifiers import lan_bridge  # noqa: E402
from agenthub_notifier.notifiers.lan_bridge import BridgeConfig, LanBridgeNotifier  # noqa: E402
from agenthub_notifier.validation import validate  # noqa: E402

# A realistic payload. The FULL path and the RAW session id must never leave;
# the folder name "RobotFramework" is the only path-derived string allowed out.
CWD = "C:\\Users\\mmarc\\source\\repos\\RobotFramework"
SESSION_ID = "7f3c9e2a-1b4d-4c8e-9a6f-0d2e5b7c1a9f"
#: Background work as Claude Code reports it on Stop. Every string inside is a
#: secret for the purposes of these tests: only the fact that the lists are
#: non-empty may influence anything, and none of it may leave.
BACKGROUND_TASKS = [
    {
        "description": "BG-SECRET-DESC run the payroll regression suite",
        "command": "pytest tests/ --db=postgres://BG-SECRET-DSN",
        "agent_type": "BG-SECRET-AGENT-TYPE",
        "server": "BG-SECRET-SERVER",
        "tool": "Bash",
        "status": "running",
    }
]
SESSION_CRONS = [
    {"schedule": "*/5 * * * *", "prompt": "CRON-SECRET-PROMPT check the deploy", "id": "cron-SECRET-1"},
]

REALISTIC_PAYLOAD = {
    "session_id": SESSION_ID,
    "transcript_path": "C:\\Users\\mmarc\\.claude\\projects\\SECRET-TRANSCRIPT.jsonl",
    "cwd": CWD,
    "hook_event_name": "Stop",
    "permission_mode": "acceptEdits",
    "tool_name": "Write",
    "tool_input": {"file_path": "contract.docx", "content": "API_KEY=sk-leakme-12345"},
    "tool_output": {"output": "wrote 4kb"},
    "last_assistant_message": "I edited the contract and the password is hunter2",
    "prompt": "please refactor the payroll module",
    "response": "Done, here is the diff",
    "env": {"AWS_SECRET_ACCESS_KEY": "AKIA-NOT-REAL"},
    "some_future_field": "MUST-BE-IGNORED",
    "background_tasks": BACKGROUND_TASKS,
    "session_crons": SESSION_CRONS,
}

#: The same payload with nothing outstanding: a genuine completion.
FINISHED_PAYLOAD = {**REALISTIC_PAYLOAD, "background_tasks": [], "session_crons": []}

#: A hook that fired INSIDE A SUBAGENT of the same main session. Everything that
#: identifies or describes the subagent beyond its sanitised type is secret.
AGENT_ID = "agent-SECRET-0001-7c3e"
SUBAGENT_PAYLOAD = {
    **FINISHED_PAYLOAD,
    "agent_id": AGENT_ID,
    "agent_type": "Explore",
    "agent_transcript_path": "C:\\Users\\mmarc\\.claude\\projects\\AGENT-SECRET-TRANSCRIPT.jsonl",
    "hook_event_name": "SubagentStop",
}

#: Every one of these must be absent from anything that reaches the wire.
MUST_NEVER_LEAVE = [
    CWD,
    "C:\\Users",
    "C:/Users",
    "mmarc",
    "source\\repos",
    "source/repos",
    SESSION_ID,
    "SECRET-TRANSCRIPT",
    "transcript_path",
    "contract.docx",
    "sk-leakme-12345",
    "tool_input",
    "tool_output",
    "hunter2",
    "last_assistant_message",
    "payroll",
    "here is the diff",
    "AKIA-NOT-REAL",
    "AWS_SECRET",
    "MUST-BE-IGNORED",
    "acceptEdits",
    # background_tasks / session_crons contents
    "BG-SECRET",
    "pytest tests/",
    "postgres://",
    "BG-SECRET-AGENT-TYPE",
    "BG-SECRET-SERVER",
    "CRON-SECRET",
    "*/5 * * * *",
    "cron-SECRET-1",
    "background_tasks",
    "session_crons",
    "description",
    "command",
    # subagent identity / transcript
    AGENT_ID,
    "agent-SECRET",
    "agent_id",
    "agent_transcript_path",
    "AGENT-SECRET-TRANSCRIPT",
]

NINE = {"version", "eventId", "agentId", "agentName", "provider", "type", "title", "message", "timestamp"}
TWELVE = NINE | {"taskId", "projectId", "projectName"}
#: A child event: parent task + child id + safe type. NO project fields.
CHILD_TWELVE = NINE | {"taskId", "subtaskId", "agentType"}


class _FakeOpener:
    def __init__(self):
        self.calls = []

    def open(self, request, timeout=None):
        self.calls.append(request.data)

        class _Resp(io.BytesIO):
            status = 202

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def getcode(self):
                return 202

        return _Resp(b"{}")


def _delivered_body(event) -> str:
    opener = _FakeOpener()
    config = BridgeConfig(endpoint="http://127.0.0.1:8781/events", token="unit-test-token-0000")
    LanBridgeNotifier(config, opener=opener).deliver(event)
    return opener.calls[0].decode("utf-8")


# --------------------------------------------------------------------------
# Derivation
# --------------------------------------------------------------------------


class TestProjectIdentity(unittest.TestCase):
    def test_project_name_is_the_folder_basename_only(self):
        _, name = derive_project(CWD)
        self.assertEqual(name, "RobotFramework")

    def test_project_id_is_prefixed_short_hash(self):
        pid, _ = derive_project(CWD)
        self.assertRegex(pid, r"^p-[a-f0-9]{12}$")

    def test_project_id_is_stable_across_case_separator_and_trailing_slash(self):
        variants = [
            "C:\\Users\\mmarc\\source\\repos\\RobotFramework",
            "c:/users/mmarc/source/repos/robotframework/",
            "C:\\USERS\\MMARC\\SOURCE\\REPOS\\RobotFramework\\",
        ]
        ids = {derive_project(v)[0] for v in variants}
        self.assertEqual(len(ids), 1, ids)

    def test_different_workspaces_get_different_ids(self):
        a, _ = derive_project("C:\\Users\\mmarc\\source\\repos\\RobotFramework")
        b, _ = derive_project("C:\\Users\\mmarc\\source\\repos\\AgentHub")
        self.assertNotEqual(a, b)

    def test_project_id_does_not_reveal_the_path(self):
        pid, name = derive_project(CWD)
        for needle in ("Users", "mmarc", "repos", "\\", "/"):
            self.assertNotIn(needle, pid)
            self.assertNotIn(needle, name)

    def test_bare_drive_or_empty_yields_no_project(self):
        for bad in ["C:\\", "C:", "/", "", "   ", None, 42, "x" * 5000]:
            with self.subTest(bad=bad):
                self.assertEqual(derive_project(bad), (None, None))

    def test_malformed_cwd_that_would_fail_validation_yields_no_project(self):
        """Garbage in -> no project out, never a path-like name that the
        validator would refuse (which would drop the whole notification)."""
        for bad in ["C:garbage", "C:UsersSomeone", ".", "..", "D:."]:
            with self.subTest(bad=bad):
                self.assertEqual(derive_project(bad), (None, None))


class TestTaskIdentity(unittest.TestCase):
    def test_task_id_is_prefixed_short_hash(self):
        self.assertRegex(derive_task_id(SESSION_ID), r"^s-[a-f0-9]{16}$")

    def test_task_id_is_stable_for_the_same_session(self):
        self.assertEqual(derive_task_id(SESSION_ID), derive_task_id(SESSION_ID))

    def test_two_sessions_in_one_workspace_are_two_tasks(self):
        ctx_a = extract_hook_context({"cwd": CWD, "session_id": "session-A"})
        ctx_b = extract_hook_context({"cwd": CWD, "session_id": "session-B"})
        self.assertEqual(ctx_a.project_id, ctx_b.project_id)
        self.assertNotEqual(ctx_a.task_id, ctx_b.task_id)

    def test_task_id_does_not_contain_the_raw_session_id(self):
        self.assertNotIn(SESSION_ID, derive_task_id(SESSION_ID))

    def test_unusable_session_id_yields_none(self):
        for bad in ["", "  ", None, 7, "x" * 5000]:
            with self.subTest(bad=bad):
                self.assertIsNone(derive_task_id(bad))


# --------------------------------------------------------------------------
# The allow-list
# --------------------------------------------------------------------------


class TestAllowList(unittest.TestCase):
    def test_exactly_six_keys_are_permitted(self):
        self.assertEqual(
            set(hook_context.ALLOWED_HOOK_KEYS),
            {"cwd", "session_id", "background_tasks", "session_crons", "agent_id", "agent_type"},
        )

    def test_context_has_no_field_that_could_hold_a_path_raw_id_or_list_contents(self):
        fields = set(HookContext.__dataclass_fields__)
        self.assertEqual(
            fields,
            {"project_id", "project_name", "task_id", "has_background_work", "has_scheduled_work", "subtask_id", "agent_type"},
        )
        ctx = extract_hook_context(REALISTIC_PAYLOAD)
        self.assertIs(ctx.has_background_work, True)
        self.assertIs(ctx.has_scheduled_work, True)
        # Booleans, not the lists: nothing here can carry a description or command.
        self.assertEqual(type(ctx.has_background_work), bool)
        self.assertEqual(type(ctx.has_scheduled_work), bool)

    def test_list_elements_are_never_accessed(self):
        """len() is the only operation applied to background_tasks / session_crons."""
        accessed = []

        class SpyList(list):
            def __getitem__(self, i):
                accessed.append(("getitem", i))
                return super().__getitem__(i)

            def __iter__(self):
                accessed.append(("iter", None))
                return super().__iter__()

        payload = {
            "cwd": CWD,
            "session_id": SESSION_ID,
            "background_tasks": SpyList(BACKGROUND_TASKS),
            "session_crons": SpyList(SESSION_CRONS),
        }
        ctx = extract_hook_context(payload)
        self.assertTrue(ctx.has_outstanding_work)
        self.assertEqual(accessed, [], f"list contents were touched: {accessed}")

    def test_only_cwd_and_session_id_are_read_from_the_payload(self):
        """Instrument the dict: any key other than the two allowed is a failure."""
        touched = []

        class Spy(dict):
            def get(self, key, default=None):
                touched.append(key)
                return super().get(key, default)

            def __getitem__(self, key):
                touched.append(key)
                return super().__getitem__(key)

            def __iter__(self):  # pragma: no cover - would indicate iteration over all keys
                touched.append("<ITERATION>")
                return super().__iter__()

            def items(self):  # pragma: no cover
                touched.append("<ITEMS>")
                return super().items()

            def values(self):  # pragma: no cover
                touched.append("<VALUES>")
                return super().values()

        allowed = {"cwd", "session_id", "background_tasks", "session_crons", "agent_id", "agent_type"}
        # A main session: agent_type is only consulted for a genuine subagent.
        extract_hook_context(Spy(REALISTIC_PAYLOAD))
        self.assertEqual(set(touched), allowed - {"agent_type"}, touched)
        # Inside a subagent the cwd is not even read: a child can never
        # establish a project, so there is nothing to derive from it.
        touched.clear()
        extract_hook_context(Spy({**REALISTIC_PAYLOAD, **SUBAGENT_PAYLOAD}))
        self.assertEqual(set(touched), allowed - {"cwd"}, touched)

    def test_transcript_path_tool_input_and_message_are_ignored(self):
        ctx = extract_hook_context(REALISTIC_PAYLOAD)
        dumped = json.dumps(ctx.__dict__)
        for needle in ("SECRET-TRANSCRIPT", "contract.docx", "sk-leakme", "hunter2", "payroll", "AKIA"):
            self.assertNotIn(needle, dumped)

    def test_unknown_extra_fields_do_not_change_the_result(self):
        """Only the six allow-listed keys influence the context; every other
        field in the realistic payload is inert."""
        minimal = extract_hook_context({
            "cwd": CWD,
            "session_id": SESSION_ID,
            "background_tasks": BACKGROUND_TASKS,
            "session_crons": SESSION_CRONS,
        })
        full = extract_hook_context(REALISTIC_PAYLOAD)
        self.assertEqual(minimal, full)


# --------------------------------------------------------------------------
# Subagents: children of the main task, never tasks of their own
# --------------------------------------------------------------------------


def _sub(event_type, **extra):
    return build_hook_event(event_type, extract_hook_context({**SUBAGENT_PAYLOAD, **extra}))


class TestSubagents(unittest.TestCase):
    def test_agent_id_marks_subtask_scope(self):
        ctx = extract_hook_context(SUBAGENT_PAYLOAD)
        self.assertTrue(ctx.is_subtask)
        self.assertRegex(ctx.subtask_id, r"^t-[a-f0-9]{16}$")
        self.assertEqual(ctx.agent_type, "Explore")
        self.assertFalse(extract_hook_context(FINISHED_PAYLOAD).is_subtask)

    def test_subtask_keeps_the_PARENT_task_and_project_identity(self):
        main = extract_hook_context(FINISHED_PAYLOAD)
        sub = extract_hook_context(SUBAGENT_PAYLOAD)
        self.assertEqual(sub.task_id, main.task_id, "taskId is the parent session")
        self.assertIsNone(sub.project_id, "a child carries NO project: the parent's is the main session's")
        self.assertIsNone(sub.project_name)
        self.assertNotEqual(sub.subtask_id, sub.task_id)

    def test_a_child_cwd_can_never_establish_or_move_the_parent_project(self):
        """Regression: main session A in .../AgentHub; a subagent of A runs in
        .../SomeOtherWorkspace. The child event must not carry that workspace
        in any form, and must still point at A."""
        main_cwd = "C:/Users/testuser/source/repos/AgentHub"
        child_cwd = "C:/Users/testuser/source/repos/SomeOtherWorkspace"
        main = extract_hook_context({"cwd": main_cwd, "session_id": "sess-A"})
        child = extract_hook_context({"cwd": child_cwd, "session_id": "sess-A", "agent_id": "ag-1", "agent_type": "Explore"})
        self.assertEqual(main.project_name, "AgentHub")
        self.assertEqual(child.task_id, main.task_id)
        self.assertIsNone(child.project_id)
        self.assertIsNone(child.project_name)
        for arg in ["subagent-start", "subagent-stop", "needs-approval", "completed"]:
            body = _delivered_body(build_hook_event(arg, child))
            sent = json.loads(body)
            with self.subTest(arg=arg):
                self.assertNotIn("SomeOtherWorkspace", body)
                self.assertNotIn("projectId", sent)
                self.assertNotIn("projectName", sent)
                self.assertEqual(sent["taskId"], main.task_id)
                self.assertIn("subtaskId", sent)
        # The child's cwd changing between events is irrelevant to identity.
        child2 = extract_hook_context({"cwd": main_cwd, "session_id": "sess-A", "agent_id": "ag-1"})
        self.assertEqual(child2.subtask_id, child.subtask_id)
        self.assertIsNone(child2.project_id)

    def test_two_subagents_in_one_session_are_two_children_of_one_parent(self):
        a1 = extract_hook_context({**SUBAGENT_PAYLOAD, "agent_id": "agent-A1"})
        a2 = extract_hook_context({**SUBAGENT_PAYLOAD, "agent_id": "agent-A2"})
        self.assertEqual(a1.task_id, a2.task_id)
        self.assertNotEqual(a1.subtask_id, a2.subtask_id)

    def test_repeated_events_from_one_subagent_share_one_subtask_id(self):
        ids = {extract_hook_context(SUBAGENT_PAYLOAD).subtask_id for _ in range(20)}
        self.assertEqual(len(ids), 1)

    def test_a_subagent_stop_completes_the_SUBAGENT_not_the_parent(self):
        """SubagentStop -> 'subagent-stop': type completed, scoped to the subtask."""
        event = _sub("subagent-stop")
        self.assertEqual(event.type, "completed")
        self.assertIsNotNone(event.subtask_id, "scope marker present")
        self.assertEqual(event.task_id, extract_hook_context(FINISHED_PAYLOAD).task_id)
        self.assertEqual(event.title, "Subtask completed")

    def test_subagent_stop_is_subtask_scoped_even_without_agent_id(self):
        event = build_hook_event("subagent-stop", extract_hook_context(FINISHED_PAYLOAD))
        self.assertEqual(event.type, "completed")
        self.assertIsNotNone(event.subtask_id, "must never be mistaken for the parent finishing")

    def test_subagent_start_is_running_in_subtask_scope(self):
        event = _sub("subagent-start")
        self.assertEqual((event.type, event.title), ("running", "Subtask running"))
        self.assertIsNotNone(event.subtask_id)

    def test_background_work_never_turns_a_subagent_completion_into_idle(self):
        event = _sub("completed", background_tasks=BACKGROUND_TASKS)
        self.assertEqual(event.type, "completed")
        self.assertIsNotNone(event.subtask_id)

    def test_any_hook_inside_a_subagent_is_subtask_scoped(self):
        for arg, expected in [("needs-approval", "needs_approval"), ("needs-input", "needs_input"), ("failed", "failed"), ("completed", "completed"), ("started", "running")]:
            with self.subTest(arg=arg):
                event = _sub(arg)
                self.assertEqual(event.type, expected)
                self.assertIsNotNone(event.subtask_id)

    def test_subtask_wire_shape_adds_exactly_two_fields(self):
        sent = json.loads(_delivered_body(_sub("subagent-stop")))
        self.assertEqual(set(sent), CHILD_TWELVE)
        self.assertNotIn("projectId", sent)
        self.assertNotIn("projectName", sent)
        self.assertEqual(sent["agentType"], "Explore")
        self.assertRegex(sent["subtaskId"], r"^t-[a-f0-9]{16}$")
        self.assertRegex(sent["taskId"], r"^s-[a-f0-9]{16}$")

    def test_raw_agent_id_and_agent_transcript_never_leave(self):
        for arg in ["subagent-start", "subagent-stop", "needs-approval", "failed"]:
            body = _delivered_body(_sub(arg))
            for needle in MUST_NEVER_LEAVE:
                with self.subTest(arg=arg, needle=needle):
                    self.assertNotIn(needle, body)

    def test_unsafe_agent_type_is_dropped_not_trimmed(self):
        for bad in ["C:\\Users\\x\\agent", "../evil", "name\x07bell", "<script>","x" * 80, "", 42, None]:
            with self.subTest(bad=bad):
                ctx = extract_hook_context({**SUBAGENT_PAYLOAD, "agent_type": bad})
                self.assertIsNone(ctx.agent_type)
                self.assertTrue(ctx.is_subtask, "identity survives without a type")

    def test_agent_type_is_not_exposed_for_main_sessions(self):
        """`claude --agent X` sets agent_type on the MAIN session; that is not a subagent."""
        ctx = extract_hook_context({**FINISHED_PAYLOAD, "agent_type": "Explore"})
        self.assertFalse(ctx.is_subtask)
        self.assertIsNone(ctx.agent_type)
        sent = json.loads(_delivered_body(build_hook_event("completed", ctx)))
        self.assertEqual(set(sent), TWELVE)

    def test_main_session_events_are_unaffected(self):
        done = build_hook_event("completed", extract_hook_context(FINISHED_PAYLOAD))
        self.assertIsNone(done.subtask_id)
        self.assertEqual(done.title, "Task completed")

    def test_the_hierarchy(self):
        """AgentHub: session A (A1, A2), session B (B1). RobotFramework: session C (C1)."""
        ws_a = "C:\\Users\\testuser\\source\\repos\\AgentHub"
        ws_b = "C:\\Users\\testuser\\source\\repos\\RobotFramework"
        mk = lambda cwd, sid, agent=None: extract_hook_context({"cwd": cwd, "session_id": sid, **({"agent_id": agent, "agent_type": "Explore"} if agent else {})})
        A, A1, A2 = mk(ws_a, "sess-A"), mk(ws_a, "sess-A", "ag-1"), mk(ws_a, "sess-A", "ag-2")
        B, B1 = mk(ws_a, "sess-B"), mk(ws_a, "sess-B", "ag-1")
        C, C1 = mk(ws_b, "sess-C"), mk(ws_b, "sess-C", "ag-9")
        self.assertEqual(A.project_id, B.project_id)
        self.assertNotEqual(A.task_id, B.task_id)
        for child in (A1, A2, B1, C1):
            self.assertIsNone(child.project_id, "children never carry a project")
        self.assertEqual({A1.task_id, A2.task_id}, {A.task_id})
        self.assertEqual(B1.task_id, B.task_id)
        self.assertNotEqual(A1.subtask_id, A2.subtask_id)
        self.assertNotEqual(A1.subtask_id, B1.subtask_id, "same agent_id under a different session is a different child")
        self.assertNotEqual(C.project_id, A.project_id)
        self.assertEqual(C1.task_id, C.task_id)
        self.assertEqual(len({A.task_id, B.task_id, C.task_id}), 3)
        self.assertEqual(len({A1.subtask_id, A2.subtask_id, B1.subtask_id, C1.subtask_id}), 4)

    def test_launcher_routes_subagent_hooks_to_subtask_scope(self):
        launcher = _load_launcher()
        for argv, expected_type in [(["subagent-stop"], "completed"), (["subagent-start"], "running"), (["needs-approval", "--agent", "Claude", "--quiet"], "needs_approval")]:
            captured = {}

            class _Notifier:
                def deliver(self, event):
                    captured["body"] = json.dumps(event.to_dict())

            fake_stdin = io.TextIOWrapper(io.BytesIO(json.dumps(SUBAGENT_PAYLOAD).encode("utf-8")))
            with mock.patch.object(sys, "stdin", fake_stdin), mock.patch.object(
                lan_bridge.LanBridgeNotifier, "from_env", staticmethod(lambda: _Notifier())
            ):
                launcher.main(argv)
            sent = json.loads(captured["body"])
            with self.subTest(argv=argv):
                self.assertEqual(sent["type"], expected_type)
                self.assertIn("subtaskId", sent)
                for needle in MUST_NEVER_LEAVE:
                    self.assertNotIn(needle, captured["body"])

    def test_non_dict_payload_yields_empty_context(self):
        for bad in [None, "string", 12, [1, 2], b"bytes"]:
            with self.subTest(bad=bad):
                self.assertEqual(extract_hook_context(bad), HookContext())


# --------------------------------------------------------------------------
# What reaches the wire
# --------------------------------------------------------------------------


class TestWireBody(unittest.TestCase):
    def _body_with_context(self, etype="completed") -> str:
        return _delivered_body(build_hook_event(etype, extract_hook_context(REALISTIC_PAYLOAD)))

    def test_full_cwd_never_appears_in_outgoing_json(self):
        body = self._body_with_context()
        self.assertNotIn(CWD, body)
        self.assertNotIn(CWD.replace("\\", "\\\\"), body)
        self.assertNotIn(CWD.replace("\\", "/"), body)

    def test_raw_session_id_never_appears_in_outgoing_json(self):
        self.assertNotIn(SESSION_ID, self._body_with_context())

    def test_nothing_from_the_forbidden_list_appears_for_any_event_type(self):
        for etype in HOOK_EVENT_TEXT:
            body = self._body_with_context(etype)
            for needle in MUST_NEVER_LEAVE:
                with self.subTest(etype=etype, needle=needle):
                    self.assertNotIn(needle, body)

    def test_only_project_and_task_fields_are_added(self):
        # REALISTIC_PAYLOAD carries outstanding work, so a Stop is reported idle;
        # the field set is what this test is about.
        sent = json.loads(self._body_with_context())
        self.assertEqual(set(sent), TWELVE)
        self.assertEqual(sent["type"], "idle")
        self.assertEqual(sent["projectName"], "RobotFramework")
        self.assertRegex(sent["projectId"], r"^p-[a-f0-9]{12}$")
        self.assertRegex(sent["taskId"], r"^s-[a-f0-9]{16}$")

    def test_event_text_is_unchanged_by_context(self):
        # A context WITHOUT outstanding work, so 'completed' stays 'completed'.
        ctx = extract_hook_context(FINISHED_PAYLOAD)
        for etype, (title, message) in HOOK_EVENT_TEXT.items():
            with self.subTest(etype=etype):
                sent = json.loads(_delivered_body(build_hook_event(etype, ctx)))
                self.assertEqual(sent["type"], etype)
                self.assertEqual(sent["title"], title)
                self.assertEqual(sent["message"], message)
                self.assertNotIn("RobotFramework", sent["title"])
                self.assertNotIn("RobotFramework", sent["message"])

    def test_event_id_behaviour_is_unchanged(self):
        ctx = extract_hook_context(REALISTIC_PAYLOAD)
        ids = {build_hook_event("completed", ctx).event_id for _ in range(100)}
        self.assertEqual(len(ids), 100)
        for eid in ids:
            self.assertRegex(eid, r"^evt-[a-f0-9]{32}$")


class TestBackwardCompatibility(unittest.TestCase):
    def test_event_without_context_is_the_original_nine_field_shape(self):
        sent = json.loads(_delivered_body(build_hook_event("completed")))
        self.assertEqual(set(sent), NINE)

    def test_event_without_context_still_validates(self):
        self.assertEqual(validate(build_hook_event("started")), [])

    def test_empty_context_is_identical_to_no_context(self):
        a = json.loads(_delivered_body(build_hook_event("failed")))
        b = json.loads(_delivered_body(build_hook_event("failed", HookContext())))
        for key in ("eventId", "timestamp"):
            a.pop(key), b.pop(key)
        self.assertEqual(a, b)

    def test_partial_context_sends_only_what_it_has(self):
        sent = json.loads(_delivered_body(build_hook_event("completed", HookContext(task_id="s-0123456789abcdef"))))
        self.assertEqual(set(sent), NINE | {"taskId"})


# --------------------------------------------------------------------------
# Validation refuses a path in projectName
# --------------------------------------------------------------------------


class TestProjectNameCannotBeAPath(unittest.TestCase):
    def _errors_for(self, name):
        return validate(build_event("completed", agent_name="Claude Code", project_name=name))

    def test_full_windows_path_is_refused(self):
        errors = self._errors_for(CWD)
        self.assertTrue(any("projectName" in e and "path" in e for e in errors), errors)

    def test_posix_path_is_refused(self):
        errors = self._errors_for("/Users/mmarc/source/repos/RobotFramework")
        self.assertTrue(any("projectName" in e for e in errors), errors)

    def test_drive_prefix_and_parent_refs_are_refused(self):
        for bad in ["C:RobotFramework", "..", "."]:
            with self.subTest(bad=bad):
                self.assertTrue(any("projectName" in e for e in self._errors_for(bad)))

    def test_plain_folder_name_is_accepted(self):
        for good in ["RobotFramework", "agent-hub", "My Project 2", "проект"]:
            with self.subTest(good=good):
                self.assertEqual([e for e in self._errors_for(good) if "projectName" in e], [])

    def test_hook_never_builds_an_event_with_a_path_name(self):
        """Even a malicious cwd cannot smuggle a path: the basename step strips it."""
        ctx = extract_hook_context({"cwd": "C:\\evil\\..\\..\\Windows\\System32", "session_id": "x"})
        self.assertEqual(ctx.project_name, "System32")
        self.assertEqual(validate(build_hook_event("completed", ctx)), [])


# --------------------------------------------------------------------------
# Stop classification: idle vs completed, decided structurally
# --------------------------------------------------------------------------


def _stop_with(background_tasks, session_crons):
    payload = {**REALISTIC_PAYLOAD, "background_tasks": background_tasks, "session_crons": session_crons}
    return build_hook_event("completed", extract_hook_context(payload))


class TestStopClassification(unittest.TestCase):
    def test_user_prompt_submit_is_running(self):
        event = build_hook_event("running", extract_hook_context(REALISTIC_PAYLOAD))
        self.assertEqual(event.type, "running")

    def test_stop_with_one_background_task_is_idle(self):
        self.assertEqual(_stop_with(BACKGROUND_TASKS, []).type, "idle")

    def test_stop_with_a_session_cron_is_idle(self):
        self.assertEqual(_stop_with([], SESSION_CRONS).type, "idle")

    def test_stop_with_both_outstanding_is_idle(self):
        self.assertEqual(_stop_with(BACKGROUND_TASKS, SESSION_CRONS).type, "idle")

    def test_stop_with_nothing_outstanding_is_completed(self):
        self.assertEqual(_stop_with([], []).type, "completed")

    def test_missing_or_non_list_values_count_as_nothing_outstanding(self):
        for bg, cron in [(None, None), ("not a list", 0), ({}, {}), (0, ""), ([], None)]:
            with self.subTest(bg=bg, cron=cron):
                self.assertEqual(_stop_with(bg, cron).type, "completed")

    def test_stop_without_any_payload_is_completed(self):
        """Old behaviour is preserved when there is no context at all."""
        self.assertEqual(build_hook_event("completed").type, "completed")
        self.assertEqual(build_hook_event("completed", HookContext()).type, "completed")

    def test_background_work_never_downgrades_other_hooks(self):
        busy = extract_hook_context(REALISTIC_PAYLOAD)
        self.assertTrue(busy.has_outstanding_work)
        for etype in ["running", "needs_approval", "needs_input", "failed"]:
            with self.subTest(etype=etype):
                self.assertEqual(build_hook_event(etype, busy).type, etype)

    def test_idle_texts_distinguish_session_open_from_background_wait(self):
        opened = build_hook_event("idle", extract_hook_context(FINISHED_PAYLOAD))
        waiting = _stop_with(BACKGROUND_TASKS, [])
        self.assertEqual(opened.type, "idle")
        self.assertEqual(waiting.type, "idle")
        self.assertEqual(opened.title, "Session open")
        self.assertEqual(waiting.title, "Waiting on background work")
        self.assertNotEqual(opened.message, waiting.message)

    def test_idle_and_completed_are_the_same_task(self):
        idle = _stop_with(BACKGROUND_TASKS, [])
        done = _stop_with([], [])
        self.assertEqual(idle.task_id, done.task_id)
        self.assertEqual(idle.project_id, done.project_id)

    def test_background_task_contents_never_leave_the_hook(self):
        body = _delivered_body(_stop_with(BACKGROUND_TASKS, SESSION_CRONS))
        for needle in ("BG-SECRET", "pytest tests/", "postgres://", "BG-SECRET-AGENT-TYPE", "BG-SECRET-SERVER", "background_tasks", "description", "command"):
            with self.subTest(needle=needle):
                self.assertNotIn(needle, body)
        sent = json.loads(body)
        self.assertEqual(set(sent), TWELVE)
        self.assertEqual(sent["type"], "idle")

    def test_cron_contents_never_leave_the_hook(self):
        body = _delivered_body(_stop_with([], SESSION_CRONS))
        for needle in ("CRON-SECRET", "*/5 * * * *", "cron-SECRET-1", "session_crons", "schedule", "prompt"):
            with self.subTest(needle=needle):
                self.assertNotIn(needle, body)

    def test_idle_text_is_generic(self):
        sent = json.loads(_delivered_body(_stop_with(BACKGROUND_TASKS, [])))
        self.assertEqual(sent["title"], "Waiting on background work")
        self.assertEqual(sent["message"], "Claude Code is waiting for background work to finish.")

    def test_the_lifecycle_sequence(self):
        """running -> idle (bg work) -> running -> completed, one task throughout."""
        prompt = extract_hook_context({**REALISTIC_PAYLOAD, "hook_event_name": "UserPromptSubmit"})
        steps = [
            build_hook_event("running", prompt),
            _stop_with(BACKGROUND_TASKS, []),
            build_hook_event("running", prompt),
            _stop_with([], []),
        ]
        self.assertEqual([e.type for e in steps], ["running", "idle", "running", "completed"])
        self.assertEqual(len({e.task_id for e in steps}), 1)
        self.assertEqual(len({e.event_id for e in steps}), 4)


# --------------------------------------------------------------------------
# SessionStart: opening Claude is Idle, never Running, never a notification
# --------------------------------------------------------------------------


class TestSessionStart(unittest.TestCase):
    """The exact user experience, at the source.

    settings.json may pass either the recommended ``idle`` or a legacy
    ``started`` for SessionStart; both must mean Idle.
    """

    def test_recommended_idle_argument_is_idle(self):
        event = build_hook_event("idle", extract_hook_context(FINISHED_PAYLOAD))
        self.assertEqual(event.type, "idle")
        self.assertEqual(event.title, "Session open")

    def test_legacy_started_argument_is_idle_too(self):
        event = build_hook_event("started", extract_hook_context(FINISHED_PAYLOAD))
        self.assertEqual(event.type, "idle")
        self.assertEqual(event.title, "Session open")

    def test_no_hook_argument_can_produce_the_started_wire_type(self):
        ctx = extract_hook_context(FINISHED_PAYLOAD)
        for arg in ["started", "idle", "running", "completed", "needs-approval", "needs-input", "failed", "STARTED", "Started"]:
            with self.subTest(arg=arg):
                self.assertNotEqual(build_hook_event(arg, ctx).type, "started")

    def test_session_start_never_says_task_started(self):
        for arg in ["started", "idle"]:
            sent = build_hook_event(arg, extract_hook_context(FINISHED_PAYLOAD)).to_dict()
            self.assertNotIn("Task started", (sent["title"], sent["message"]))
            self.assertNotIn("started", sent["title"].lower())

    def test_open_then_prompt_is_one_task_idle_then_running(self):
        opened = build_hook_event("idle", extract_hook_context(FINISHED_PAYLOAD))
        prompt = build_hook_event("running", extract_hook_context({**FINISHED_PAYLOAD, "hook_event_name": "UserPromptSubmit"}))
        self.assertEqual((opened.type, prompt.type), ("idle", "running"))
        self.assertEqual(opened.task_id, prompt.task_id)
        self.assertEqual(opened.project_id, prompt.project_id)

    def test_the_exact_user_experience(self):
        """open -> prompt -> stop(bg) -> prompt -> stop(done): one task, right types."""
        ctx_open = extract_hook_context(FINISHED_PAYLOAD)
        ctx_prompt = extract_hook_context({**FINISHED_PAYLOAD, "hook_event_name": "UserPromptSubmit"})
        steps = [
            build_hook_event("idle", ctx_open),                 # SessionStart
            build_hook_event("running", ctx_prompt),            # UserPromptSubmit
            _stop_with(BACKGROUND_TASKS, []),                   # Stop, tests running
            build_hook_event("running", ctx_prompt),            # UserPromptSubmit
            _stop_with([], []),                                 # Stop, nothing outstanding
        ]
        self.assertEqual([e.type for e in steps], ["idle", "running", "idle", "running", "completed"])
        self.assertEqual(len({e.task_id for e in steps}), 1, "repeated prompts never create another task")
        self.assertEqual(len({e.event_id for e in steps}), 5)
        self.assertEqual(steps[0].title, "Session open")
        self.assertEqual(steps[2].title, "Waiting on background work")
        self.assertEqual(steps[4].title, "Task completed")

    def test_launcher_started_argument_yields_idle(self):
        launcher = _load_launcher()
        captured = {}

        class _Notifier:
            def deliver(self, event):
                captured["event"] = event.to_dict()

        fake_stdin = io.TextIOWrapper(io.BytesIO(json.dumps(FINISHED_PAYLOAD).encode("utf-8")))
        with mock.patch.object(sys, "stdin", fake_stdin), mock.patch.object(
            lan_bridge.LanBridgeNotifier, "from_env", staticmethod(lambda: _Notifier())
        ):
            launcher.main(["started", "--agent", "Claude", "--quiet"])
        self.assertEqual(captured["event"]["type"], "idle")
        self.assertEqual(captured["event"]["title"], "Session open")


# --------------------------------------------------------------------------
# Workspace / session matrix: the product model's identity rules
# --------------------------------------------------------------------------

WS_A = "C:\\Users\\testuser\\source\\repos\\WorkspaceAlpha"
WS_B = "C:\\Users\\testuser\\source\\repos\\WorkspaceBeta"
S1 = "11111111-aaaa-4bbb-8ccc-000000000001"
S2 = "11111111-aaaa-4bbb-8ccc-000000000002"
S3 = "11111111-aaaa-4bbb-8ccc-000000000003"


def _ctx(cwd, session_id):
    return extract_hook_context({"cwd": cwd, "session_id": session_id, "transcript_path": "C:\\x\\SECRET.jsonl"})


class TestWorkspaceSessionMatrix(unittest.TestCase):
    """A: workspace A / session 1.  B: workspace A / session 2.  C: workspace B / session 3.

    Expected on the phone:   WorkspaceAlpha -> Task 1, Task 2     WorkspaceBeta -> Task 1
    """

    def test_same_workspace_two_sessions_share_project_identity(self):
        a, b = _ctx(WS_A, S1), _ctx(WS_A, S2)
        self.assertEqual(a.project_id, b.project_id)
        self.assertEqual(a.project_name, b.project_name)
        self.assertEqual(a.project_name, "WorkspaceAlpha")

    def test_same_workspace_two_sessions_are_two_tasks(self):
        a, b = _ctx(WS_A, S1), _ctx(WS_A, S2)
        self.assertNotEqual(a.task_id, b.task_id)

    def test_different_workspace_is_a_different_project(self):
        a, c = _ctx(WS_A, S1), _ctx(WS_B, S3)
        self.assertNotEqual(a.project_id, c.project_id)
        self.assertEqual(c.project_name, "WorkspaceBeta")
        self.assertNotEqual(a.task_id, c.task_id)

    def test_task_identity_is_stable_across_many_events_from_one_session(self):
        """Ten hook firings from one session -> ten fresh eventIds, ONE taskId."""
        ctx = _ctx(WS_A, S1)
        events = [build_hook_event(t, ctx) for t in ["started", "completed", "needs_input", "completed", "failed"] * 2]
        self.assertEqual({e.task_id for e in events}, {ctx.task_id})
        self.assertEqual({e.project_id for e in events}, {ctx.project_id})
        self.assertEqual(len({e.event_id for e in events}), 10)

    def test_no_task_is_invented_per_notification(self):
        """Five events across three sessions must yield exactly three task ids."""
        plan = [(WS_A, S1, "started"), (WS_A, S1, "completed"), (WS_A, S2, "started"), (WS_B, S3, "started"), (WS_B, S3, "needs_input")]
        events = [build_hook_event(t, _ctx(cwd, sid)) for cwd, sid, t in plan]
        self.assertEqual(len({e.task_id for e in events}), 3)
        self.assertEqual(len({e.project_id for e in events}), 2)
        self.assertEqual(len({e.event_id for e in events}), 5)

    def test_matrix_wire_bodies_carry_no_path_or_raw_session(self):
        for cwd, sid in [(WS_A, S1), (WS_A, S2), (WS_B, S3)]:
            body = _delivered_body(build_hook_event("completed", _ctx(cwd, sid)))
            for needle in (cwd, cwd.replace("\\", "\\\\"), cwd.replace("\\", "/"), sid, "testuser", "source", "repos", "SECRET"):
                with self.subTest(cwd=cwd[-14:], needle=needle):
                    self.assertNotIn(needle, body)
            self.assertIn('"projectName":"Workspace', body)


# --------------------------------------------------------------------------
# The launcher, end to end against a fake stdin
# --------------------------------------------------------------------------


def _load_launcher():
    spec = importlib.util.spec_from_file_location("agenthub_hook", PROJECT_ROOT / "agenthub-hook.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestLauncher(unittest.TestCase):
    def _run(self, stdin_bytes, argv=("completed", "--agent", "Claude", "--quiet")):
        launcher = _load_launcher()
        captured = {}

        class _Notifier:
            def deliver(self, event):
                captured["body"] = json.dumps(event.to_dict())

        fake_stdin = io.TextIOWrapper(io.BytesIO(stdin_bytes))
        with mock.patch.object(sys, "stdin", fake_stdin), mock.patch.object(
            lan_bridge.LanBridgeNotifier, "from_env", staticmethod(lambda: _Notifier())
        ):
            launcher.main(list(argv))
        return captured.get("body", "")

    def test_launcher_forwards_only_derived_identity(self):
        body = self._run(json.dumps(REALISTIC_PAYLOAD).encode("utf-8"))
        sent = json.loads(body)
        self.assertEqual(set(sent), TWELVE)
        self.assertEqual(sent["projectName"], "RobotFramework")
        self.assertEqual(sent["type"], "idle", "Stop with outstanding work is idle")
        for needle in MUST_NEVER_LEAVE:
            self.assertNotIn(needle, body)

    def test_launcher_reports_completed_when_nothing_is_outstanding(self):
        body = self._run(json.dumps(FINISHED_PAYLOAD).encode("utf-8"))
        sent = json.loads(body)
        self.assertEqual(sent["type"], "completed")
        self.assertEqual(sent["title"], "Task completed")
        for needle in MUST_NEVER_LEAVE:
            self.assertNotIn(needle, body)

    def test_launcher_running_argument_is_never_reclassified(self):
        body = self._run(json.dumps(REALISTIC_PAYLOAD).encode("utf-8"), argv=("running", "--agent", "Claude", "--quiet"))
        self.assertEqual(json.loads(body)["type"], "running")

    def test_launcher_with_garbage_stdin_still_sends_the_plain_event(self):
        sent = json.loads(self._run(b"this is not json"))
        self.assertEqual(set(sent), NINE)

    def test_launcher_with_empty_stdin_still_sends_the_plain_event(self):
        sent = json.loads(self._run(b""))
        self.assertEqual(set(sent), NINE)

    def test_environment_variables_never_reach_the_wire(self):
        """The process environment is full of things that must not leave: put
        canaries in it and prove none of them appear in the event."""
        canaries = {
            "AGENTHUB_TEST_CANARY": "canary-env-value-7f3e9a",
            "AWS_SECRET_ACCESS_KEY": "AKIA-CANARY-NOT-REAL",
            "OPENAI_API_KEY": "sk-canary-not-real-0000",
            "USERNAME": "canary-user",
        }
        import os

        with mock.patch.dict(os.environ, canaries):
            body = self._run(json.dumps(REALISTIC_PAYLOAD).encode("utf-8"))
        for value in canaries.values():
            self.assertNotIn(value, body)
        self.assertNotIn("AGENTHUB_BRIDGE_TOKEN", body)

    def test_malformed_cwd_never_drops_the_notification(self):
        """Identity is best-effort; delivery is not. A cwd that yields no valid
        project must still produce an event (with whatever else was derivable)."""
        body = self._run(json.dumps({"cwd": "C:garbage-no-separators", "session_id": "sess-1"}).encode("utf-8"))
        self.assertTrue(body, "event was dropped")
        sent = json.loads(body)
        self.assertEqual(set(sent), NINE | {"taskId"})
        self.assertNotIn("garbage", body)

    def test_launcher_reads_nothing_beyond_the_cap(self):
        huge = b'{"cwd": "' + b"A" * (2 * 1024 * 1024) + b'", "session_id": "x"}'
        sent = json.loads(self._run(huge))
        self.assertEqual(set(sent), NINE)


if __name__ == "__main__":
    unittest.main(verbosity=2)
