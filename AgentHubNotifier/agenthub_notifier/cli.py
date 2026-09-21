"""Command-line entry point for AgentHub Notifier.

Usage:  agenthub-notifier <type> [options]

Local by default. Without --send nothing leaves this machine and no networking
module is even imported. --send is the only way to open an outbound connection,
and there is no mode in which this program accepts an inbound one.

The CLI never reads stdin and never reads files, so nothing can be piped into
an event by accident. Every value comes from an explicit flag.

Exit codes:
  0  event was valid and delivered (or printed locally)
  2  event was rejected by validation, or the arguments were wrong
  3  event was valid but the relay could not be reached -- see note below
  4  --send or --dry-run was used but the configuration is missing or invalid

Exit code 3 means only that the *notification* failed. The task the calling
agent was doing is unaffected, and callers that do not care may ignore it.
"""

from __future__ import annotations

import argparse
import contextlib
import sys

from .event import EVENT_TYPES, PROVIDERS, build_event, normalize_type
from .notifiers import ConsoleNotifier, Notifier
from .validation import ValidationError, validate_or_raise

#: Both spellings are accepted so `needs-approval` works as a command word.
_TYPE_CHOICES = sorted({t for t in EVENT_TYPES} | {t.replace("_", "-") for t in EVENT_TYPES})

EXIT_OK = 0
EXIT_INVALID = 2
EXIT_NOT_DELIVERED = 3
EXIT_CONFIG = 4


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="agenthub-notifier",
        description=(
            "Report a minimal AI-agent status event. Local by default: "
            "nothing is sent anywhere unless you pass --send."
        ),
        epilog="Example: agenthub-notifier completed --agent \"Claude Code\" --provider claude",
    )
    parser.add_argument(
        "type",
        metavar="TYPE",
        choices=_TYPE_CHOICES,
        help="event type: " + ", ".join(t.replace("_", "-") for t in EVENT_TYPES),
    )
    parser.add_argument("--agent", "--agent-name", dest="agent_name", metavar="NAME",
                        help='display name, e.g. "Claude Code" (default: Agent)')
    parser.add_argument("--agent-id", dest="agent_id", metavar="ID",
                        help="stable id (default: derived from the display name)")
    parser.add_argument("--provider", choices=PROVIDERS,
                        help="provider (default: inferred from the name, else custom)")
    parser.add_argument("--task", "--task-id", dest="task_id", metavar="ID",
                        help="optional task id, for grouping events")
    parser.add_argument("--title", metavar="TEXT", help="short headline (max 100 chars)")
    parser.add_argument("--message", metavar="TEXT", help="one-line body (max 300 chars)")
    parser.add_argument("--timestamp", metavar="ISO8601",
                        help="override the UTC timestamp (mainly for testing)")
    parser.add_argument("--pretty", action="store_true", help="indent the JSON output")
    parser.add_argument("--quiet", action="store_true",
                        help="suppress the human-readable line on stderr")
    parser.add_argument("--send", action="store_true",
                        help="send the event to the AgentHub relay over HTTPS "
                             "(requires AGENTHUB_ENDPOINT and AGENTHUB_AUTH_TOKEN)")
    parser.add_argument("--dry-run", dest="dry_run", action="store_true",
                        help="show what --send would transmit and check the configuration, "
                             "without making any network request")
    return parser


def _describe_config(err, env=None) -> int:
    """Report the delivery configuration for --dry-run. Returns an exit code.

    Only the endpoint is echoed; the token is never printed, not even partially.
    """
    from .notifiers.https import ConfigurationError, HttpsConfig, is_offline_mode

    try:
        config = HttpsConfig.from_env(env)
    except ConfigurationError as exc:
        err.write(f"[agenthub] configuration incomplete: {exc}\n")
        err.write("[agenthub] dry run: no network request was made.\n")
        return EXIT_CONFIG

    err.write(f"[agenthub] would POST to {config.endpoint} (timeout {config.timeout:g}s)\n")
    err.write("[agenthub] Authorization: Bearer <token from AGENTHUB_AUTH_TOKEN, not shown>\n")
    if is_offline_mode(env):
        err.write("[agenthub] AGENTHUB_OFFLINE is set: --send would build the event but not transmit it.\n")
    err.write("[agenthub] dry run: no network request was made.\n")
    return EXIT_OK


def _send(event, err, env=None) -> int:
    """Deliver over HTTPS and report the outcome. Returns an exit code.

    A delivery failure is reported as one sanitised line -- never a traceback,
    so the calling agent is never handed a crash.
    """
    from .notifiers.https import ConfigurationError, HttpsNotifier, is_offline_mode

    if is_offline_mode(env):
        err.write("[agenthub] AGENTHUB_OFFLINE is set: event built and validated, not transmitted.\n")
        return EXIT_OK

    try:
        notifier = HttpsNotifier.from_env(env)
    except ConfigurationError as exc:
        err.write(f"[agenthub] cannot send: {exc}\n")
        err.write("[agenthub] set AGENTHUB_ENDPOINT and AGENTHUB_AUTH_TOKEN, then retry.\n")
        return EXIT_CONFIG

    result = notifier.deliver(event)
    if result.delivered:
        err.write(f"[agenthub] {result.message}\n")
        return EXIT_OK

    err.write(f"[agenthub] {result.message}\n")
    err.write("[agenthub] AgentHub notification could not be delivered. "
              "The agent's own task status is unaffected.\n")
    return EXIT_NOT_DELIVERED


def run(argv: list[str] | None = None, notifier: Notifier | None = None,
        stdout=None, stderr=None, env=None) -> int:
    """Run the CLI. Streams, notifier and environment are injectable for tests."""
    out = stdout if stdout is not None else sys.stdout
    err = stderr if stderr is not None else sys.stderr

    parser = build_parser()
    try:
        # argparse writes usage and --help straight to the real streams;
        # redirect so an injected stream captures them too.
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(out):
            args = parser.parse_args(argv)
    except SystemExit as exc:
        # argparse has already written its own diagnostics to the streams above.
        return EXIT_INVALID if exc.code else EXIT_OK

    event = build_event(
        normalize_type(args.type),
        agent_name=args.agent_name,
        agent_id=args.agent_id,
        provider=args.provider,
        task_id=args.task_id,
        title=args.title,
        message=args.message,
        timestamp=args.timestamp,
    )

    try:
        validate_or_raise(event)
    except ValidationError as exc:
        err.write("agenthub-notifier: event rejected\n")
        for problem in exc.errors:
            err.write(f"  - {problem}\n")
        return EXIT_INVALID

    # --dry-run wins over --send: it prints the body and checks the config,
    # and under no circumstances opens a connection.
    if args.dry_run:
        ConsoleNotifier(out, pretty=args.pretty).notify(event)
        return _describe_config(err, env)

    if args.send and notifier is None:
        return _send(event, err, env)

    active = notifier if notifier is not None else ConsoleNotifier(out, pretty=args.pretty)
    active.notify(event)

    if not args.quiet:
        err.write(f"[agenthub] {event.type}: {event.message}\n")
    return EXIT_OK


def main(argv: list[str] | None = None) -> int:
    return run(argv)


if __name__ == "__main__":
    raise SystemExit(main())
