"""Tests for the LAN bridge transport and the hook event constants.

NOTHING here touches the network. Every test injects a fake opener or patches
``build_opener``, so no socket is created, no DNS lookup happens, no local
server is started and no external service is contacted.

Run from the project root:  python -m unittest discover -s tests -v
"""

from __future__ import annotations

import json
import os
import pathlib
import sys
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timezone
from unittest import mock

PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agenthub_notifier import hook_events  # noqa: E402
from agenthub_notifier.hook_events import UnknownHookEvent, build_hook_event  # noqa: E402
from agenthub_notifier.notifiers import lan_bridge  # noqa: E402
from agenthub_notifier.notifiers.lan_bridge import (  # noqa: E402
    BridgeConfig,
    BridgeConfigurationError,
    BridgeDeliveryError,
    BridgeNotConfigured,
    LanBridgeNotifier,
)

ENDPOINT = "http://192.168.1.50:8787/events"
TOKEN = "BridgeSecret-DO-NOT-LEAK-9876"

#: The payload Claude Code would write to a hook's stdin. Every one of these
#: strings is something that must never leave the machine.
HOSTILE_PAYLOAD = {
    "session_id": "s-123",
    "transcript_path": "C:\\Users\\mmarc\\.claude\\projects\\SECRET-TRANSCRIPT.jsonl",
    "cwd": "C:\\confidential-client-project",
    "tool_name": "Write",
    "tool_input": {"file_path": "contract.docx", "content": "API_KEY=sk-leakme-12345"},
    "tool_response": {"output": "wrote 4kb"},
    "last_assistant_message": "I edited the contract and the password is hunter2",
    "permission_mode": "acceptEdits",
}

HOSTILE_STRINGS = [
    "SECRET-TRANSCRIPT",
    "confidential-client-project",
    "contract.docx",
    "sk-leakme-12345",
    "hunter2",
    "transcript_path",
    "tool_input",
    "last_assistant_message",
    "acceptEdits",
    "s-123",
]


def make_env(**overrides):
    env = {lan_bridge.ENV_ENDPOINT: ENDPOINT, lan_bridge.ENV_TOKEN: TOKEN}
    env.update(overrides)
    return env


def make_config(**overrides):
    values = {"endpoint": ENDPOINT, "token": TOKEN}
    values.update(overrides)
    return BridgeConfig(**values)


class FakeResponse:
    def __init__(self, status=200, body=b'{"ok":true,"do":"rm -rf /"}'):
        self.status = status
        self._body = body
        self.read_sizes = []

    def read(self, size=None):
        self.read_sizes.append(size)
        return self._body[:size] if size else self._body

    def getcode(self):
        return self.status

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False


class FakeOpener:
    """Records every call. Raises or returns whatever the test queued."""

    def __init__(self, outcomes=None):
        self.outcomes = list(outcomes or [])
        self.calls = []

    def open(self, request, timeout=None):
        self.calls.append(
            {
                "url": request.full_url,
                "method": request.get_method(),
                "body": request.data,
                "timeout": timeout,
                "headers": {k.lower(): v for k, v in request.header_items()},
            }
        )
        outcome = self.outcomes.pop(0) if self.outcomes else FakeResponse()
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


def http_error(status):
    return urllib.error.HTTPError(ENDPOINT, status, f"status {status}", {}, None)


def make_notifier(outcomes=None):
    opener = FakeOpener(outcomes)
    return LanBridgeNotifier(make_config(), opener=opener), opener


# --------------------------------------------------------------------------
# Endpoint validation -- the LAN-only guarantee
# --------------------------------------------------------------------------


class TestEndpointValidation(unittest.TestCase):
    def test_private_lan_addresses_are_accepted(self):
        for good in [
            "http://192.168.1.50:8787/events",
            "http://10.0.0.5:8787/events",
            "http://172.16.4.2:8787/events",
            "http://172.31.255.254/events",
            "http://127.0.0.1:8787/events",
            "https://192.168.1.50:8787/events",
            "http://192.168.1.50:8787/events/",
        ]:
            with self.subTest(good=good):
                self.assertTrue(lan_bridge.validate_endpoint(good).endswith("/events"))

    def test_public_internet_addresses_are_refused(self):
        for bad in ["http://8.8.8.8:8787/events", "https://1.1.1.1/events", "http://93.184.216.34/events"]:
            with self.subTest(bad=bad):
                with self.assertRaises(BridgeConfigurationError) as ctx:
                    lan_bridge.validate_endpoint(bad)
                self.assertIn("private LAN address", str(ctx.exception))

    def test_hostnames_are_refused_so_no_dns_lookup_can_redirect_us(self):
        for bad in [
            "http://macbook.local:8787/events",
            "http://localhost:8787/events",
            "http://evil.example.com/events",
        ]:
            with self.subTest(bad=bad):
                with self.assertRaises(BridgeConfigurationError) as ctx:
                    lan_bridge.validate_endpoint(bad)
                self.assertIn("literal private IP", str(ctx.exception))

    def test_wrong_path_is_refused(self):
        for bad in ["http://192.168.1.50:8787/", "http://192.168.1.50:8787/admin", "http://192.168.1.50:8787"]:
            with self.subTest(bad=bad):
                with self.assertRaises(BridgeConfigurationError) as ctx:
                    lan_bridge.validate_endpoint(bad)
                self.assertIn("/events", str(ctx.exception))

    def test_malformed_urls_are_refused(self):
        for bad in [
            "192.168.1.50:8787/events",
            "ftp://192.168.1.50/events",
            "http://192.168.1.50:notaport/events",
            "http://user:pass@192.168.1.50:8787/events",
            "http://192.168.1.50:8787/events?x=1",
            "http://192.168.1.50:8787/events\nX-Injected: 1",
            "not a url",
        ]:
            with self.subTest(bad=bad):
                with self.assertRaises(BridgeConfigurationError):
                    lan_bridge.validate_endpoint(bad)

    def test_missing_endpoint_reports_not_configured(self):
        for blank in [None, "", "   "]:
            with self.subTest(blank=blank):
                with self.assertRaises(BridgeNotConfigured):
                    lan_bridge.validate_endpoint(blank)

    def test_endpoint_is_rebuilt_from_validated_parts(self):
        self.assertEqual(
            lan_bridge.validate_endpoint("http://192.168.1.50:8787/events/"),
            "http://192.168.1.50:8787/events",
        )


class TestTokenValidation(unittest.TestCase):
    def test_valid_token_is_accepted(self):
        self.assertEqual(lan_bridge.validate_token(TOKEN), TOKEN)

    def test_missing_token_reports_not_configured(self):
        for blank in [None, "", "   "]:
            with self.subTest(blank=blank):
                with self.assertRaises(BridgeNotConfigured):
                    lan_bridge.validate_token(blank)

    def test_header_injection_attempt_is_refused_without_echoing_the_token(self):
        with self.assertRaises(BridgeConfigurationError) as ctx:
            lan_bridge.validate_token("good\r\nX-Injected: evil")
        self.assertNotIn("X-Injected", str(ctx.exception))
        self.assertNotIn("evil", str(ctx.exception))


class TestConfigFromEnv(unittest.TestCase):
    def test_config_comes_only_from_the_environment(self):
        config = BridgeConfig.from_env(make_env())
        self.assertEqual(config.endpoint, ENDPOINT)
        self.assertEqual(config.token, TOKEN)
        self.assertEqual(config.timeout, lan_bridge.TIMEOUT_SECONDS)

    def test_either_variable_missing_reports_not_configured(self):
        for env in [{}, {lan_bridge.ENV_ENDPOINT: ENDPOINT}, {lan_bridge.ENV_TOKEN: TOKEN}]:
            with self.subTest(env=sorted(env)):
                with self.assertRaises(BridgeNotConfigured):
                    BridgeConfig.from_env(env)

    def test_present_but_invalid_is_a_hard_config_error(self):
        env = make_env(AGENTHUB_MAC_ENDPOINT="http://8.8.8.8/events")
        with self.assertRaises(BridgeConfigurationError):
            BridgeConfig.from_env(env)
        self.assertNotIsInstance(
            self._raised(env), BridgeNotConfigured, "a public endpoint must not look like 'not configured'"
        )

    def _raised(self, env):
        try:
            BridgeConfig.from_env(env)
        except BridgeConfigurationError as exc:
            return exc
        return None

    def test_repr_redacts_the_token(self):
        self.assertIn("<redacted>", repr(make_config()))
        self.assertNotIn(TOKEN, repr(make_config()))
        self.assertNotIn(TOKEN, str(make_config()))


# --------------------------------------------------------------------------
# The fixed events
# --------------------------------------------------------------------------


class TestHookEvents(unittest.TestCase):
    def test_the_six_hook_texts_build_valid_events(self):
        self.assertEqual(
            set(hook_events.HOOK_EVENT_TEXT),
            {"running", "idle", "needs_approval", "needs_input", "completed", "failed"},
        )
        for etype in hook_events.HOOK_EVENT_TEXT:
            with self.subTest(etype=etype):
                event = build_hook_event(etype)
                self.assertEqual(event.type, etype)
                self.assertEqual(event.agent_id, "win_claude_code")
                self.assertEqual(event.agent_name, "Claude Code")
                self.assertEqual(event.provider, "claude")

    def test_started_argument_is_reported_as_idle_never_running(self):
        """SessionStart: opening Claude is not working."""
        event = build_hook_event("started")
        self.assertEqual(event.type, "idle")
        self.assertEqual(event.title, "Session open")
        self.assertNotIn("started", event.title.lower())
        self.assertNotIn("Task started", event.to_dict().values())

    def test_cli_spelling_is_accepted(self):
        self.assertEqual(build_hook_event("needs-approval").type, "needs_approval")

    def test_needs_input_uses_the_agreed_fixed_text(self):
        sent = build_hook_event("needs_input").to_dict()
        self.assertEqual(sent["type"], "needs_input")
        self.assertEqual(sent["title"], "Input needed")
        self.assertEqual(sent["message"], "Claude Code is waiting for your input.")
        self.assertEqual(sent["agentId"], "win_claude_code")
        self.assertEqual(sent["agentName"], "Claude Code")
        self.assertEqual(sent["provider"], "claude")

    def test_types_outside_the_allowlist_are_still_refused(self):
        for absent in ["paused", "exploded", "idle_prompt", "permission_prompt", ""]:
            with self.subTest(absent=absent):
                with self.assertRaises(UnknownHookEvent):
                    build_hook_event(absent)

    def test_every_event_has_a_fresh_uuid_and_utc_timestamp(self):
        ids = {build_hook_event("completed").event_id for _ in range(200)}
        self.assertEqual(len(ids), 200)
        stamp = build_hook_event("completed").timestamp
        self.assertTrue(stamp.endswith("Z"), stamp)
        parsed = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        self.assertEqual(parsed.utcoffset(), timezone.utc.utcoffset(None))

    def test_the_wire_shape_matches_the_bridge_schema(self):
        sent = build_hook_event("completed").to_dict()
        self.assertEqual(
            set(sent),
            {"version", "eventId", "agentId", "agentName", "provider", "type", "title", "message", "timestamp"},
        )
        self.assertEqual(sent["version"], 1)
        self.assertEqual(sent["title"], "Task completed")
        self.assertEqual(sent["message"], "Claude Code completed a task.")


# --------------------------------------------------------------------------
# The request
# --------------------------------------------------------------------------


class TestRequestConstruction(unittest.TestCase):
    def test_posts_to_the_configured_endpoint_as_json(self):
        notifier, opener = make_notifier()
        notifier.deliver(build_hook_event("completed"))
        call = opener.calls[0]
        self.assertEqual(call["url"], ENDPOINT)
        self.assertEqual(call["method"], "POST")
        self.assertEqual(call["headers"]["content-type"], "application/json")

    def test_authorization_header_is_a_bearer_token(self):
        notifier, opener = make_notifier()
        notifier.deliver(build_hook_event("started"))
        self.assertEqual(opener.calls[0]["headers"]["authorization"], f"Bearer {TOKEN}")

    def test_token_is_not_in_the_body_or_the_url(self):
        notifier, opener = make_notifier()
        notifier.deliver(build_hook_event("started"))
        call = opener.calls[0]
        self.assertNotIn(TOKEN, call["body"].decode("utf-8"))
        self.assertNotIn(TOKEN, call["url"])

    def test_body_is_exactly_the_validated_event(self):
        event = build_hook_event("needs_approval")
        notifier, opener = make_notifier()
        notifier.deliver(event)
        self.assertEqual(json.loads(opener.calls[0]["body"].decode("utf-8")), event.to_dict())

    def test_timeout_is_two_seconds_and_well_under_the_hook_budget(self):
        notifier, opener = make_notifier()
        notifier.deliver(build_hook_event("completed"))
        self.assertEqual(opener.calls[0]["timeout"], 2.0)
        self.assertLess(lan_bridge.TIMEOUT_SECONDS * lan_bridge.MAX_ATTEMPTS, 5.0)

    def test_user_agent_does_not_disclose_the_python_version(self):
        notifier, opener = make_notifier()
        notifier.deliver(build_hook_event("completed"))
        self.assertNotIn("Python", opener.calls[0]["headers"]["user-agent"])


class TestOpenerHardening(unittest.TestCase):
    def test_proxies_are_disabled_so_the_token_cannot_be_routed_off_lan(self):
        """Proved by contrast: the default opener would route through HTTP_PROXY."""
        poisoned = {"HTTP_PROXY": "http://evil.example.com:3128",
                    "HTTPS_PROXY": "http://evil.example.com:3128"}

        def live_proxies(opener):
            return [h for h in opener.handlers
                    if isinstance(h, urllib.request.ProxyHandler) and h.proxies]

        with mock.patch.dict(os.environ, poisoned, clear=False):
            hardened = lan_bridge.build_opener()
            default = urllib.request.build_opener()

        self.assertTrue(live_proxies(default), "sanity check: the default opener does honour HTTP_PROXY")
        self.assertEqual(live_proxies(hardened), [], "HTTP_PROXY must not be honoured")

    def test_redirects_are_refused(self):
        self.assertTrue(
            any(isinstance(h, lan_bridge._RefuseRedirects) for h in lan_bridge.build_opener().handlers)
        )
        handler = lan_bridge._RefuseRedirects()
        self.assertIsNone(handler.redirect_request(None, None, 302, "Found", {}, "http://evil.example.com/"))

    def test_constructing_a_notifier_opens_nothing(self):
        with mock.patch.object(lan_bridge, "build_opener") as factory:
            LanBridgeNotifier(make_config())
        factory.assert_not_called()


# --------------------------------------------------------------------------
# Outcomes
# --------------------------------------------------------------------------


class TestOutcomes(unittest.TestCase):
    def test_2xx_counts_as_delivered(self):
        for status in (200, 201, 202, 204):
            with self.subTest(status=status):
                notifier, _ = make_notifier([FakeResponse(status)])
                result = notifier.deliver(build_hook_event("completed"))
                self.assertTrue(result.delivered)
                self.assertEqual(result.status, status)

    def test_response_body_is_capped_and_never_parsed(self):
        response = FakeResponse(200, body=b'{"command":"delete everything"}')
        notifier, _ = make_notifier([response])
        result = notifier.deliver(build_hook_event("completed"))
        self.assertTrue(result.delivered)
        self.assertEqual(response.read_sizes, [lan_bridge.MAX_RESPONSE_BYTES])
        self.assertIsNone(result.detail)

    def test_bridge_offline_is_handled_safely(self):
        notifier, _ = make_notifier([urllib.error.URLError("connection refused")])
        result = notifier.deliver(build_hook_event("completed"))
        self.assertFalse(result.delivered)
        self.assertEqual(result.message, "AgentHub bridge could not be reached.")
        self.assertEqual(result.detail, "URLError")

    def test_timeout_is_handled_safely(self):
        notifier, _ = make_notifier([TimeoutError()])
        result = notifier.deliver(build_hook_event("completed"))
        self.assertFalse(result.delivered)
        self.assertIn("did not respond in time", result.message)

    def test_auth_failure_reports_generically(self):
        for status in (401, 403):
            with self.subTest(status=status):
                notifier, _ = make_notifier([http_error(status)])
                result = notifier.deliver(build_hook_event("completed"))
                self.assertFalse(result.delivered)
                self.assertEqual(result.message, "AgentHub bridge rejected the request.")

    def test_server_error_and_redirect_are_handled_safely(self):
        notifier, _ = make_notifier([http_error(500)])
        self.assertFalse(notifier.deliver(build_hook_event("completed")).delivered)
        notifier, _ = make_notifier([http_error(302)])
        self.assertIn("refusing to follow", notifier.deliver(build_hook_event("completed")).message)

    def test_there_are_no_retries(self):
        notifier, opener = make_notifier([urllib.error.URLError("x"), FakeResponse(200)])
        notifier.deliver(build_hook_event("completed"))
        self.assertEqual(len(opener.calls), 1)
        self.assertEqual(lan_bridge.MAX_ATTEMPTS, 1)

    def test_notify_raises_a_sanitised_error(self):
        notifier, _ = make_notifier([http_error(403)])
        with self.assertRaises(BridgeDeliveryError) as ctx:
            notifier.notify(build_hook_event("completed"))
        self.assertEqual(str(ctx.exception), "AgentHub bridge rejected the request.")


class TestTokenNeverLeaks(unittest.TestCase):
    def test_token_appears_in_no_user_facing_string(self):
        texts = [repr(make_config()), str(make_config())]
        outcomes = [
            http_error(401), http_error(403), http_error(500), http_error(302),
            urllib.error.URLError(f"failed sending Bearer {TOKEN}"),
            TimeoutError(TOKEN),
            OSError(TOKEN),
        ]
        for outcome in outcomes:
            notifier, _ = make_notifier([outcome])
            result = notifier.deliver(build_hook_event("completed"))
            texts += [result.message, str(result.detail), repr(result)]
            notifier, _ = make_notifier([outcome])
            try:
                notifier.notify(build_hook_event("completed"))
            except BridgeDeliveryError as exc:
                texts.append(str(exc))
        try:
            lan_bridge.validate_token("has spaces " + TOKEN)
        except BridgeConfigurationError as exc:
            texts.append(str(exc))

        for text in texts:
            self.assertNotIn(TOKEN, text)


# --------------------------------------------------------------------------
# The hostile payload must not reach the wire
# --------------------------------------------------------------------------


class TestHostilePayloadNeverTransmitted(unittest.TestCase):
    """The central privacy claim, checked against the actual request bytes."""

    def _captured_body(self, etype):
        notifier, opener = make_notifier()
        notifier.deliver(build_hook_event(etype))
        return opener.calls[0]["body"].decode("utf-8")

    def test_no_hostile_string_appears_in_any_transmitted_body(self):
        for etype in hook_events.HOOK_EVENT_TEXT:
            body = self._captured_body(etype)
            for needle in HOSTILE_STRINGS:
                with self.subTest(etype=etype, needle=needle):
                    self.assertNotIn(needle, body)

    def test_transmitted_body_carries_only_the_nine_allowlisted_fields(self):
        for etype in hook_events.HOOK_EVENT_TEXT:
            sent = json.loads(self._captured_body(etype))
            with self.subTest(etype=etype):
                self.assertEqual(
                    set(sent),
                    {"version", "eventId", "agentId", "agentName", "provider",
                     "type", "title", "message", "timestamp"},
                )

    def test_no_machine_identifying_data_is_added(self):
        import getpass
        import os
        import platform

        body = self._captured_body("completed").lower()
        for leak in {platform.node(), getpass.getuser(), os.getcwd(), sys.executable}:
            if leak:
                self.assertNotIn(str(leak).lower(), body)

    def test_the_event_builder_accepts_only_derived_identity(self):
        """The only way in besides the event type is a HookContext, and a
        HookContext has no field that could carry a path, a transcript location,
        tool input or a raw session id. See test_hook_context.py for the
        allow-list itself."""
        import inspect

        from agenthub_notifier.hook_context import HookContext

        params = inspect.signature(build_hook_event).parameters
        self.assertEqual(list(params), ["event_type", "context"])
        # Derived identity plus two booleans. No field can hold a path, a raw
        # session id, or the contents of background_tasks / session_crons.
        self.assertEqual(
            set(HookContext.__dataclass_fields__),
            {"project_id", "project_name", "task_id", "has_background_work", "has_scheduled_work", "subtask_id", "agent_type"},
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
