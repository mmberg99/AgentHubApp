"""Tests for the HTTPS transport. Standard library only.

NOTHING here touches the network. Every test either injects a fake opener or
patches ``build_opener``, so no socket is ever created, no DNS lookup happens
and no external service is contacted. There is no local test server either.

Run from the project root:  python -m unittest discover -s tests -v
"""

from __future__ import annotations

import io
import json
import pathlib
import sys
import unittest
import urllib.error
from unittest import mock

PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agenthub_notifier import cli  # noqa: E402
from agenthub_notifier.event import build_event  # noqa: E402
from agenthub_notifier.notifiers import https  # noqa: E402
from agenthub_notifier.notifiers.https import (  # noqa: E402
    ConfigurationError,
    DeliveryError,
    HttpsConfig,
    HttpsNotifier,
)

ENDPOINT = "https://relay.example.invalid/v1/events"
TOKEN = "SuperSecretToken-DO-NOT-LEAK-12345"


def make_env(**overrides):
    env = {https.ENV_ENDPOINT: ENDPOINT, https.ENV_TOKEN: TOKEN}
    env.update(overrides)
    return env


def make_config(**overrides):
    values = {"endpoint": ENDPOINT, "token": TOKEN, "timeout": 5.0}
    values.update(overrides)
    return HttpsConfig(**values)


class FakeResponse:
    """Stands in for an http.client.HTTPResponse, without any I/O."""

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


def make_notifier(outcomes=None, **kwargs):
    """A notifier wired to a fake opener and a sleep that does not sleep."""
    opener = FakeOpener(outcomes)
    slept = []
    notifier = HttpsNotifier(make_config(), opener=opener, sleep=slept.append, **kwargs)
    return notifier, opener, slept


# --------------------------------------------------------------------------
# Endpoint and token validation
# --------------------------------------------------------------------------


class TestEndpointValidation(unittest.TestCase):
    def test_https_url_is_accepted(self):
        self.assertEqual(https.validate_endpoint(ENDPOINT), ENDPOINT)
        self.assertEqual(https.validate_endpoint("https://a.example.invalid:8443/e?x=1").startswith("https://"), True)

    def test_http_url_is_rejected_and_never_upgraded_silently(self):
        with self.assertRaises(ConfigurationError) as ctx:
            https.validate_endpoint("http://relay.example.invalid/v1/events")
        self.assertIn("HTTPS is required", str(ctx.exception))

    def test_malformed_urls_are_rejected(self):
        for bad in [
            "",
            "   ",
            "relay.example.invalid/events",   # no scheme
            "https://",                        # no host
            "https:///events",                 # no host
            "ftp://relay.example.invalid/e",   # wrong scheme
            "ws://relay.example.invalid/e",    # wrong scheme
            "not a url at all",
            "https://relay.example.invalid:notaport/e",
            "https://relay.example.invalid/e\nX-Injected: 1",
        ]:
            with self.subTest(bad=bad):
                with self.assertRaises(ConfigurationError):
                    https.validate_endpoint(bad)

    def test_missing_endpoint_is_rejected(self):
        with self.assertRaises(ConfigurationError) as ctx:
            https.validate_endpoint(None)
        self.assertIn(https.ENV_ENDPOINT, str(ctx.exception))

    def test_credentials_embedded_in_the_url_are_rejected(self):
        with self.assertRaises(ConfigurationError):
            https.validate_endpoint("https://user:pass@relay.example.invalid/e")


class TestTokenValidation(unittest.TestCase):
    def test_valid_token_is_accepted(self):
        self.assertEqual(https.validate_token(TOKEN), TOKEN)

    def test_missing_token_is_rejected(self):
        for bad in [None, "", "   "]:
            with self.subTest(bad=bad):
                with self.assertRaises(ConfigurationError) as ctx:
                    https.validate_token(bad)
                self.assertIn(https.ENV_TOKEN, str(ctx.exception))

    def test_header_injection_attempt_is_rejected_without_echoing_the_token(self):
        poisoned = "good\r\nX-Injected: evil"
        with self.assertRaises(ConfigurationError) as ctx:
            https.validate_token(poisoned)
        self.assertNotIn("X-Injected", str(ctx.exception))
        self.assertNotIn("evil", str(ctx.exception))

    def test_config_from_env_reports_every_missing_piece_at_once(self):
        with self.assertRaises(ConfigurationError) as ctx:
            HttpsConfig.from_env({})
        message = str(ctx.exception)
        self.assertIn(https.ENV_ENDPOINT, message)
        self.assertIn(https.ENV_TOKEN, message)

    def test_config_comes_only_from_the_environment(self):
        config = HttpsConfig.from_env(make_env())
        self.assertEqual(config.endpoint, ENDPOINT)
        self.assertEqual(config.token, TOKEN)
        self.assertEqual(config.timeout, https.DEFAULT_TIMEOUT_SECONDS)

    def test_timeout_override_is_validated(self):
        self.assertEqual(HttpsConfig.from_env(make_env(AGENTHUB_TIMEOUT_SECONDS="8")).timeout, 8.0)
        for bad in ["abc", "0.1", "600", "-3"]:
            with self.subTest(bad=bad):
                with self.assertRaises(ConfigurationError):
                    HttpsConfig.from_env(make_env(AGENTHUB_TIMEOUT_SECONDS=bad))


# --------------------------------------------------------------------------
# The request itself
# --------------------------------------------------------------------------


class TestRequestConstruction(unittest.TestCase):
    def test_authorization_header_is_a_bearer_token(self):
        notifier, opener, _ = make_notifier()
        notifier.deliver(build_event("completed", agent_name="Claude Code"))
        headers = opener.calls[0]["headers"]
        self.assertEqual(headers["authorization"], f"Bearer {TOKEN}")

    def test_token_is_not_in_the_body_or_the_url(self):
        notifier, opener, _ = make_notifier()
        notifier.deliver(build_event("completed", agent_name="Claude Code"))
        call = opener.calls[0]
        self.assertNotIn(TOKEN, call["body"].decode("utf-8"))
        self.assertNotIn(TOKEN, call["url"])

    def test_body_is_exactly_the_validated_event(self):
        event = build_event("needs_approval", agent_name="Codex", task_id="build-42")
        notifier, opener, _ = make_notifier()
        notifier.deliver(event)
        sent = json.loads(opener.calls[0]["body"].decode("utf-8"))
        self.assertEqual(sent, event.to_dict())

    def test_body_carries_no_machine_or_environment_data(self):
        import getpass
        import os
        import platform

        notifier, opener, _ = make_notifier()
        notifier.deliver(build_event("completed", agent_name="Claude Code"))
        sent = json.loads(opener.calls[0]["body"].decode("utf-8"))

        self.assertEqual(
            set(sent),
            {"version", "eventId", "agentId", "agentName", "provider",
             "type", "title", "message", "timestamp"},
        )
        blob = json.dumps(sent).lower()
        for leak in {platform.node(), getpass.getuser(), os.getcwd(), sys.executable}:
            if leak:
                self.assertNotIn(str(leak).lower(), blob)

    def test_request_is_a_post_of_utf8_json(self):
        notifier, opener, _ = make_notifier()
        notifier.deliver(build_event("completed", agent_name="Claude"))
        call = opener.calls[0]
        self.assertEqual(call["method"], "POST")
        self.assertIn("application/json", call["headers"]["content-type"])
        call["body"].decode("utf-8")  # raises if it is not valid UTF-8

    def test_user_agent_does_not_disclose_the_python_version(self):
        notifier, opener, _ = make_notifier()
        notifier.deliver(build_event("completed"))
        agent = opener.calls[0]["headers"]["user-agent"]
        self.assertEqual(agent, https.USER_AGENT)
        self.assertNotIn("Python", agent)

    def test_timeout_is_passed_to_the_opener(self):
        notifier, opener, _ = make_notifier()
        notifier.deliver(build_event("completed"))
        self.assertEqual(opener.calls[0]["timeout"], 5.0)
        self.assertEqual(https.DEFAULT_TIMEOUT_SECONDS, 5.0)

    def test_invalid_events_are_still_rejected_before_any_request(self):
        from agenthub_notifier.validation import ValidationError

        notifier, opener, _ = make_notifier()
        with self.assertRaises(ValidationError):
            notifier.deliver(build_event("exploded"))
        self.assertEqual(opener.calls, [])


# --------------------------------------------------------------------------
# Outcomes
# --------------------------------------------------------------------------


class TestSuccess(unittest.TestCase):
    def test_2xx_counts_as_delivered(self):
        for status in (200, 201, 202, 204):
            with self.subTest(status=status):
                notifier, opener, _ = make_notifier([FakeResponse(status)])
                result = notifier.deliver(build_event("completed"))
                self.assertTrue(result.delivered)
                self.assertEqual(result.status, status)
                self.assertEqual(result.attempts, 1)

    def test_notify_returns_quietly_on_success(self):
        notifier, _, _ = make_notifier([FakeResponse(200)])
        self.assertIsNone(notifier.notify(build_event("completed")))

    def test_response_body_is_capped_and_never_parsed(self):
        response = FakeResponse(200, body=b'{"command":"delete everything"}')
        notifier, _, _ = make_notifier([response])
        result = notifier.deliver(build_event("completed"))
        self.assertTrue(result.delivered)
        self.assertEqual(response.read_sizes, [https.MAX_RESPONSE_BYTES])
        # The body influences nothing: the result carries only a status code.
        self.assertIsNone(result.detail)


class TestFailures(unittest.TestCase):
    def test_connection_failure_is_handled_safely(self):
        notifier, opener, _ = make_notifier([urllib.error.URLError("getaddrinfo failed")] * 3)
        result = notifier.deliver(build_event("completed"))
        self.assertFalse(result.delivered)
        self.assertEqual(result.message, "AgentHub relay could not be reached.")
        self.assertIsNone(result.status)

    def test_timeout_is_handled_safely(self):
        notifier, _, _ = make_notifier([TimeoutError()] * 3)
        result = notifier.deliver(build_event("completed"))
        self.assertFalse(result.delivered)
        self.assertIn("did not respond in time", result.message)

    def test_401_and_403_report_a_generic_rejection(self):
        for status in (401, 403):
            with self.subTest(status=status):
                notifier, opener, _ = make_notifier([http_error(status)])
                result = notifier.deliver(build_event("completed"))
                self.assertFalse(result.delivered)
                self.assertEqual(result.message, "AgentHub relay rejected the request.")

    def test_authentication_failure_is_never_retried(self):
        notifier, opener, slept = make_notifier([http_error(401), FakeResponse(200)])
        result = notifier.deliver(build_event("completed"))
        self.assertFalse(result.delivered)
        self.assertEqual(len(opener.calls), 1)
        self.assertEqual(slept, [])

    def test_client_errors_are_never_retried(self):
        for status in (400, 404, 413, 422):
            with self.subTest(status=status):
                notifier, opener, _ = make_notifier([http_error(status)] * 3)
                notifier.deliver(build_event("completed"))
                self.assertEqual(len(opener.calls), 1)

    def test_500_is_handled_safely(self):
        notifier, opener, _ = make_notifier([http_error(500)] * 3)
        result = notifier.deliver(build_event("completed"))
        self.assertFalse(result.delivered)
        self.assertEqual(result.message, "AgentHub relay is unavailable.")
        self.assertEqual(result.status, 500)

    def test_redirects_are_refused_rather_than_followed(self):
        # Following one could leak the Authorization header to another host.
        notifier, opener, _ = make_notifier([http_error(302)])
        result = notifier.deliver(build_event("completed"))
        self.assertFalse(result.delivered)
        self.assertIn("refusing to follow", result.message)
        self.assertEqual(len(opener.calls), 1)

    def test_the_redirect_handler_blocks_every_redirect(self):
        handler = https._RefuseRedirects()
        self.assertIsNone(
            handler.redirect_request(None, None, 302, "Found", {}, "http://evil.example.invalid/")
        )

    def test_notify_raises_a_sanitised_delivery_error(self):
        notifier, _, _ = make_notifier([http_error(403)])
        with self.assertRaises(DeliveryError) as ctx:
            notifier.notify(build_event("completed"))
        self.assertEqual(str(ctx.exception), "AgentHub relay rejected the request.")


class TestRetries(unittest.TestCase):
    def test_transient_failure_is_retried_up_to_two_extra_times(self):
        notifier, opener, slept = make_notifier([http_error(503)] * 5)
        result = notifier.deliver(build_event("completed"))
        self.assertFalse(result.delivered)
        self.assertEqual(len(opener.calls), https.MAX_ATTEMPTS)
        self.assertEqual(https.MAX_ATTEMPTS, 3)
        self.assertEqual(slept, list(https.BACKOFF_SECONDS))

    def test_a_retry_can_succeed(self):
        notifier, opener, _ = make_notifier([http_error(503), urllib.error.URLError("x"), FakeResponse(200)])
        result = notifier.deliver(build_event("completed"))
        self.assertTrue(result.delivered)
        self.assertEqual(result.attempts, 3)

    def test_retries_resend_the_identical_body_and_event_id(self):
        event = build_event("completed", agent_name="Claude Code")
        notifier, opener, _ = make_notifier([http_error(500), http_error(500), FakeResponse(200)])
        notifier.deliver(event)

        bodies = [call["body"] for call in opener.calls]
        self.assertEqual(len(bodies), 3)
        self.assertEqual(len(set(bodies)), 1, "a retry changed the request body")
        for body in bodies:
            self.assertEqual(json.loads(body.decode("utf-8"))["eventId"], event.event_id)

    def test_rate_limiting_is_retried_then_reported(self):
        notifier, opener, _ = make_notifier([http_error(429)] * 3)
        result = notifier.deliver(build_event("completed"))
        self.assertFalse(result.delivered)
        self.assertEqual(len(opener.calls), 3)
        self.assertIn("rate limiting", result.message)


# --------------------------------------------------------------------------
# The token must never surface
# --------------------------------------------------------------------------


class TestTokenNeverLeaks(unittest.TestCase):
    def _all_user_facing_text(self):
        """Every string a user could plausibly see, across every failure mode."""
        texts = []
        config = make_config()
        texts += [repr(config), str(config), f"{config}"]

        outcomes = [
            http_error(401), http_error(403), http_error(400), http_error(500),
            http_error(302), http_error(429),
            urllib.error.URLError(f"failed while sending Bearer {TOKEN}"),
            TimeoutError(TOKEN),
            OSError(TOKEN),
        ]
        for outcome in outcomes:
            notifier, _, _ = make_notifier([outcome] * 4)
            result = notifier.deliver(build_event("completed"))
            texts += [result.message, str(result.detail), repr(result)]
            try:
                notifier.notify(build_event("completed"))
            except DeliveryError as exc:
                texts.append(str(exc))

        try:
            https.validate_token("bad token with spaces " + TOKEN)
        except ConfigurationError as exc:
            texts.append(str(exc))
        return texts

    def test_token_appears_in_no_user_facing_string(self):
        for text in self._all_user_facing_text():
            self.assertNotIn(TOKEN, text)

    def test_config_repr_redacts_the_token(self):
        self.assertIn("<redacted>", repr(make_config()))
        self.assertIn(ENDPOINT, repr(make_config()))

    def test_internal_detail_is_only_an_exception_type_or_status(self):
        notifier, _, _ = make_notifier([urllib.error.URLError(f"secret {TOKEN}")] * 3)
        result = notifier.deliver(build_event("completed"))
        self.assertEqual(result.detail, "URLError")

    def test_redact_helper_scrubs_the_token(self):
        self.assertEqual(https._redact(f"saw {TOKEN} here", TOKEN), "saw <redacted> here")


# --------------------------------------------------------------------------
# CLI wiring
# --------------------------------------------------------------------------


def run_cli(argv, env=None, notifier=None):
    out, err = io.StringIO(), io.StringIO()
    code = cli.run(argv, notifier=notifier, stdout=out, stderr=err, env=env)
    return code, out.getvalue(), err.getvalue()


class TestCliLocalByDefault(unittest.TestCase):
    def test_default_invocation_uses_the_console_notifier_and_opens_nothing(self):
        with mock.patch.object(https, "build_opener") as opener_factory:
            code, out, err = run_cli(["completed", "--agent", "Claude"], env=make_env())
        self.assertEqual(code, cli.EXIT_OK)
        self.assertEqual(json.loads(out)["type"], "completed")
        opener_factory.assert_not_called()

    def test_configured_environment_does_not_make_the_default_send(self):
        with mock.patch.object(https.HttpsNotifier, "deliver") as deliver:
            run_cli(["needs-approval", "--agent", "Codex"], env=make_env())
        deliver.assert_not_called()


class TestCliSend(unittest.TestCase):
    def test_send_selects_the_https_notifier(self):
        opener = FakeOpener([FakeResponse(202)])
        with mock.patch.object(https, "build_opener", return_value=opener):
            code, out, err = run_cli(["completed", "--agent", "Claude", "--send"], env=make_env())
        self.assertEqual(code, cli.EXIT_OK)
        self.assertEqual(len(opener.calls), 1)
        self.assertEqual(opener.calls[0]["url"], ENDPOINT)
        self.assertIn("delivered", err)

    def test_send_without_configuration_fails_safely(self):
        with mock.patch.object(https, "build_opener") as opener_factory:
            code, out, err = run_cli(["completed", "--agent", "Claude", "--send"], env={})
        self.assertEqual(code, cli.EXIT_CONFIG)
        self.assertIn(https.ENV_ENDPOINT, err)
        self.assertIn(https.ENV_TOKEN, err)
        opener_factory.assert_not_called()

    def test_send_over_http_is_refused_before_any_connection(self):
        env = make_env(AGENTHUB_ENDPOINT="http://relay.example.invalid/e")
        with mock.patch.object(https, "build_opener") as opener_factory:
            code, out, err = run_cli(["completed", "--send"], env=env)
        self.assertEqual(code, cli.EXIT_CONFIG)
        self.assertIn("HTTPS is required", err)
        opener_factory.assert_not_called()

    def test_delivery_failure_exits_3_without_a_traceback(self):
        opener = FakeOpener([http_error(403)])
        with mock.patch.object(https, "build_opener", return_value=opener):
            code, out, err = run_cli(["completed", "--agent", "Claude", "--send"], env=make_env())
        self.assertEqual(code, cli.EXIT_NOT_DELIVERED)
        self.assertIn("could not be delivered", err)
        self.assertIn("task status is unaffected", err)
        self.assertNotIn("Traceback", err)
        self.assertNotIn(TOKEN, err)

    def test_invalid_event_is_rejected_before_the_transport_is_touched(self):
        with mock.patch.object(https, "build_opener") as opener_factory:
            code, out, err = run_cli(["completed", "--message", "m" * 400, "--send"], env=make_env())
        self.assertEqual(code, cli.EXIT_INVALID)
        self.assertEqual(out, "")
        opener_factory.assert_not_called()

    def test_offline_switch_builds_the_event_but_sends_nothing(self):
        env = make_env(AGENTHUB_OFFLINE="1")
        with mock.patch.object(https, "build_opener") as opener_factory:
            code, out, err = run_cli(["completed", "--send"], env=env)
        self.assertEqual(code, cli.EXIT_OK)
        self.assertIn("not transmitted", err)
        opener_factory.assert_not_called()


class TestCliDryRun(unittest.TestCase):
    def test_dry_run_makes_no_network_request(self):
        with mock.patch.object(https, "build_opener") as opener_factory:
            with mock.patch.object(https.HttpsNotifier, "deliver") as deliver:
                code, out, err = run_cli(["completed", "--agent", "Claude", "--dry-run"], env=make_env())
        opener_factory.assert_not_called()
        deliver.assert_not_called()
        self.assertEqual(code, cli.EXIT_OK)
        self.assertIn("no network request was made", err)

    def test_dry_run_shows_the_exact_body_that_would_be_sent(self):
        code, out, err = run_cli(["needs-input", "--agent", "Codex", "--dry-run"], env=make_env())
        printed = json.loads(out)
        self.assertEqual(printed["type"], "needs_input")
        self.assertEqual(printed["provider"], "openai")
        self.assertIn(ENDPOINT, err)

    def test_dry_run_never_prints_the_token(self):
        code, out, err = run_cli(["completed", "--dry-run"], env=make_env())
        self.assertNotIn(TOKEN, out)
        self.assertNotIn(TOKEN, err)
        self.assertIn("not shown", err)

    def test_dry_run_reports_missing_configuration(self):
        code, out, err = run_cli(["completed", "--dry-run"], env={})
        self.assertEqual(code, cli.EXIT_CONFIG)
        self.assertIn(https.ENV_ENDPOINT, err)
        self.assertIn("no network request was made", err)
        # The event is still shown, so the body can be inspected before setup.
        self.assertEqual(json.loads(out)["type"], "completed")

    def test_dry_run_wins_over_send(self):
        with mock.patch.object(https, "build_opener") as opener_factory:
            code, out, err = run_cli(["completed", "--send", "--dry-run"], env=make_env())
        opener_factory.assert_not_called()
        self.assertEqual(code, cli.EXIT_OK)


class TestNoRealNetworkInTests(unittest.TestCase):
    def test_the_real_opener_is_never_invoked_during_this_suite(self):
        """A belt-and-braces check: patch the stdlib entry point itself."""
        import urllib.request

        with mock.patch.object(urllib.request.OpenerDirector, "open") as stdlib_open:
            stdlib_open.side_effect = AssertionError("a real request was attempted")
            notifier, _, _ = make_notifier([FakeResponse(200)])
            result = notifier.deliver(build_event("completed"))
        self.assertTrue(result.delivered)
        stdlib_open.assert_not_called()

    def test_tls_context_is_strict(self):
        import ssl

        context = https.build_tls_context()
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertEqual(context.minimum_version, ssl.TLSVersion.TLSv1_2)

    def test_constructing_a_notifier_opens_nothing(self):
        with mock.patch.object(https, "build_opener") as opener_factory:
            HttpsNotifier(make_config())
        opener_factory.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
