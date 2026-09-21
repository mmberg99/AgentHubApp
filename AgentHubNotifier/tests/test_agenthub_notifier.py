"""Local test suite for AgentHub Notifier. Standard library only.

Run from the project root:  python -m unittest discover -s tests -v
"""

from __future__ import annotations

import ast
import io
import json
import os
import pathlib
import subprocess
import sys
import unittest
from datetime import datetime, timezone

PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agenthub_notifier import cli, validation  # noqa: E402
from agenthub_notifier.event import (  # noqa: E402
    EVENT_TYPES,
    MAX_MESSAGE_LENGTH,
    MAX_TITLE_LENGTH,
    AgentEvent,
    build_event,
    new_event_id,
)
from agenthub_notifier.notifiers import ConsoleNotifier  # noqa: E402


def run_cli(argv, notifier=None):
    """Run the CLI in-process and return (exit_code, stdout, stderr)."""
    out, err = io.StringIO(), io.StringIO()
    code = cli.run(argv, notifier=notifier, stdout=out, stderr=err)
    return code, out.getvalue(), err.getvalue()


def replace(event, **changes):
    """Build a variant of an event, bypassing build_event's defaults."""
    fields = {
        "event_id": event.event_id,
        "agent_id": event.agent_id,
        "agent_name": event.agent_name,
        "provider": event.provider,
        "type": event.type,
        "title": event.title,
        "message": event.message,
        "timestamp": event.timestamp,
        "task_id": event.task_id,
        "version": event.version,
    }
    fields.update(changes)
    return AgentEvent(**fields)


class TestValidEventTypes(unittest.TestCase):
    def test_all_seven_event_types_are_accepted(self):
        self.assertEqual(len(EVENT_TYPES), 7)
        for etype in EVENT_TYPES:
            with self.subTest(etype=etype):
                event = build_event(etype, agent_name="Claude Code")
                self.assertEqual(validation.validate(event), [])
                self.assertEqual(event.type, etype)

    def test_all_six_event_types_work_through_the_cli(self):
        for etype in EVENT_TYPES:
            for spelling in (etype, etype.replace("_", "-")):
                with self.subTest(spelling=spelling):
                    code, out, _ = run_cli([spelling, "--agent", "Claude Code"])
                    self.assertEqual(code, 0)
                    self.assertEqual(json.loads(out)["type"], etype)

    def test_default_message_is_short_and_generic(self):
        event = build_event("completed", agent_name="Claude Code")
        self.assertEqual(event.message, "Claude Code finished its task.")
        self.assertEqual(event.title, "Task completed")

    def test_optional_task_id_round_trips(self):
        event = build_event("running", task_id="build-42")
        self.assertEqual(validation.validate(event), [])
        self.assertEqual(event.to_dict()["taskId"], "build-42")


class TestInvalidEventTypes(unittest.TestCase):
    def test_unknown_type_is_rejected_by_the_validator(self):
        errors = validation.validate(build_event("exploded", agent_name="Claude"))
        self.assertTrue(any("unknown event type" in e for e in errors), errors)

    def test_unknown_type_is_rejected_by_the_cli(self):
        code, out, _ = run_cli(["exploded"])
        self.assertEqual(code, cli.EXIT_INVALID)
        self.assertEqual(out, "")

    def test_empty_type_is_rejected(self):
        self.assertTrue(validation.validate(build_event("")))


class TestLengthLimits(unittest.TestCase):
    def test_title_at_the_limit_is_accepted(self):
        event = build_event("completed", title="t" * MAX_TITLE_LENGTH)
        self.assertEqual(validation.validate(event), [])

    def test_title_over_the_limit_fails(self):
        errors = validation.validate(build_event("completed", title="t" * (MAX_TITLE_LENGTH + 1)))
        self.assertTrue(any(e.startswith("title:") and "maximum length" in e for e in errors), errors)

    def test_message_at_the_limit_is_accepted(self):
        event = build_event("completed", message="m" * MAX_MESSAGE_LENGTH)
        self.assertEqual(validation.validate(event), [])

    def test_message_over_the_limit_fails(self):
        errors = validation.validate(build_event("completed", message="m" * (MAX_MESSAGE_LENGTH + 1)))
        self.assertTrue(any(e.startswith("message:") and "maximum length" in e for e in errors), errors)

    def test_cli_rejects_an_oversized_message_and_prints_nothing(self):
        code, out, err = run_cli(["completed", "--message", "m" * 400])
        self.assertEqual(code, cli.EXIT_INVALID)
        self.assertEqual(out, "")
        self.assertIn("message:", err)

    def test_cli_rejects_an_oversized_title_and_prints_nothing(self):
        code, out, err = run_cli(["failed", "--title", "t" * 150])
        self.assertEqual(code, cli.EXIT_INVALID)
        self.assertEqual(out, "")
        self.assertIn("title:", err)


class TestPrivacyGuards(unittest.TestCase):
    def test_control_characters_and_line_breaks_are_rejected(self):
        # A pasted terminal log or file dump lands here; it must not pass.
        event = replace(build_event("failed"), message="line one\nline two")
        errors = validation.validate(event)
        self.assertTrue(any("control characters" in e for e in errors), errors)

    def test_multiline_cli_input_is_flattened_to_one_line(self):
        code, out, _ = run_cli(["failed", "--message", "first line\nsecond line"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["message"], "first line second line")

    def test_event_has_no_free_form_payload_field(self):
        keys = set(build_event("completed").to_dict())
        self.assertEqual(
            keys,
            {"version", "eventId", "agentId", "agentName", "provider",
             "type", "title", "message", "timestamp"},
        )

    def test_unknown_cli_flags_are_refused(self):
        code, out, _ = run_cli(["completed", "--payload", '{"secret":"x"}'])
        self.assertEqual(code, cli.EXIT_INVALID)
        self.assertEqual(out, "")


class TestTimestamps(unittest.TestCase):
    def test_generated_timestamp_is_valid_utc_iso8601(self):
        event = build_event("running")
        self.assertEqual(validation.validate_timestamp(event.timestamp), [])
        self.assertTrue(event.timestamp.endswith("Z"), event.timestamp)
        parsed = datetime.fromisoformat(event.timestamp.replace("Z", "+00:00"))
        self.assertEqual(parsed.utcoffset(), timezone.utc.utcoffset(None))

    def test_malformed_timestamp_fails(self):
        for bad in ["not-a-date", "2026-13-45T99:00:00Z", "", "20260920", "yesterday"]:
            with self.subTest(bad=bad):
                self.assertTrue(validation.validate_timestamp(bad))

    def test_naive_and_non_utc_timestamps_fail(self):
        self.assertTrue(validation.validate_timestamp("2026-09-20T12:00:00"))
        self.assertTrue(validation.validate_timestamp("2026-09-20T12:00:00+02:00"))

    def test_cli_rejects_a_bad_timestamp_override(self):
        code, out, err = run_cli(["completed", "--timestamp", "yesterday"])
        self.assertEqual(code, cli.EXIT_INVALID)
        self.assertEqual(out, "")
        self.assertIn("timestamp:", err)


class TestEventIds(unittest.TestCase):
    def test_ids_are_generated_and_well_formed(self):
        event = build_event("started")
        self.assertTrue(event.event_id.startswith("evt-"))
        self.assertEqual(validation.validate(event), [])

    def test_ids_are_unique(self):
        ids = {new_event_id() for _ in range(2000)}
        self.assertEqual(len(ids), 2000)

    def test_cli_generates_a_distinct_id_per_invocation(self):
        _, first, _ = run_cli(["completed"])
        _, second, _ = run_cli(["completed"])
        self.assertNotEqual(json.loads(first)["eventId"], json.loads(second)["eventId"])

    def test_malformed_id_is_rejected(self):
        errors = validation.validate(build_event("started", event_id="12345"))
        self.assertTrue(any(e.startswith("eventId:") for e in errors), errors)


class TestProtocolVersion(unittest.TestCase):
    def test_unsupported_version_is_rejected(self):
        errors = validation.validate(replace(build_event("completed"), version=99))
        self.assertTrue(any("unsupported protocol version" in e for e in errors), errors)

    def test_missing_required_field_is_rejected(self):
        errors = validation.validate(replace(build_event("completed"), agent_name=""))
        self.assertTrue(any("agentName: missing required field" in e for e in errors), errors)


class TestProviders(unittest.TestCase):
    def test_provider_is_inferred_but_stays_neutral_by_default(self):
        self.assertEqual(build_event("completed", agent_name="Claude Code").provider, "claude")
        self.assertEqual(build_event("completed", agent_name="Codex").provider, "openai")
        self.assertEqual(build_event("completed", agent_name="My Script").provider, "custom")

    def test_explicit_provider_wins(self):
        self.assertEqual(build_event("completed", agent_name="Claude", provider="custom").provider, "custom")

    def test_unsupported_provider_is_rejected(self):
        errors = validation.validate(build_event("completed", provider="acme"))
        self.assertTrue(any(e.startswith("provider:") for e in errors), errors)


class TestNotifierAbstraction(unittest.TestCase):
    def test_cli_delegates_to_the_injected_notifier(self):
        seen = []

        class RecordingNotifier:
            def notify(self, event):
                seen.append(event)

        code, out, _ = run_cli(["completed"], notifier=RecordingNotifier())
        self.assertEqual(code, 0)
        self.assertEqual(len(seen), 1)
        self.assertEqual(out, "")  # nothing went to the console

    def test_console_notifier_emits_one_json_line(self):
        stream = io.StringIO()
        ConsoleNotifier(stream).notify(build_event("completed", agent_name="Claude Code"))
        lines = stream.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(json.loads(lines[0])["agentName"], "Claude Code")


class TestNoNetworking(unittest.TestCase):
    FORBIDDEN = ("socket", "ssl", "http", "urllib", "requests", "ftplib",
                 "smtplib", "asyncio", "xmlrpc", "webbrowser", "email")

    #: The only modules allowed to reach the network. Everything else -- the
    #: event model, the validator, the CLI and the hook launcher -- must stay
    #: import-clean, so the whole audit surface is two reviewable files.
    NETWORK_MODULES = ("notifiers/https.py", "notifiers/lan_bridge.py")

    def test_only_the_two_transports_import_a_networking_module(self):
        offenders = []
        package = PROJECT_ROOT / "agenthub_notifier"
        for path in package.rglob("*.py"):
            if path.relative_to(package).as_posix() in self.NETWORK_MODULES:
                continue
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                names = []
                if isinstance(node, ast.Import):
                    names = [alias.name for alias in node.names]
                elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                    names = [node.module]
                for name in names:
                    if name.split(".")[0] in self.FORBIDDEN:
                        offenders.append(f"{path.relative_to(package).as_posix()}: {name}")
        self.assertEqual(offenders, [], f"unexpected networking imports: {offenders}")

    def test_the_allowlisted_transports_exist(self):
        for name in self.NETWORK_MODULES:
            with self.subTest(name=name):
                self.assertTrue((PROJECT_ROOT / "agenthub_notifier" / name).is_file(), f"{name} is missing")

    def test_the_hook_launcher_itself_imports_no_networking_module(self):
        """agenthub-hook.py sits outside the package; hold it to the same rule."""
        tree = ast.parse((PROJECT_ROOT / "agenthub-hook.py").read_text(encoding="utf-8"))
        offenders = []
        for node in ast.walk(tree):
            names = []
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                names = [node.module]
            offenders += [n for n in names if n.split(".")[0] in self.FORBIDDEN]
        self.assertEqual(offenders, [], f"networking imports in the launcher: {offenders}")

    def test_running_the_cli_loads_no_networking_module(self):
        probe_path = PROJECT_ROOT / "tests" / "_network_probe.py"
        env = dict(os.environ, PYTHONPATH=str(PROJECT_ROOT))
        result = subprocess.run(
            [sys.executable, str(probe_path)],
            capture_output=True, text=True, env=env, cwd=str(PROJECT_ROOT),
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        loaded = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertEqual(loaded, [], f"networking modules were imported: {loaded}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
