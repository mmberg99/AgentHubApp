"""Send synthetic AgentHub events to the Mac bridge, and report what happened.

This is the loud counterpart to agenthub-hook.py: same transport, same fixed
events, but it prints the outcome so you can verify the bridge end to end
without involving Claude Code at all.

    python send-test-event.py                      # all four event types
    python send-test-event.py completed            # just one

Reads AGENTHUB_MAC_ENDPOINT and AGENTHUB_BRIDGE_TOKEN from the environment.
The token is never printed. Exits 1 if any event failed to deliver.
"""

from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from agenthub_notifier.hook_events import HOOK_EVENT_TEXT, UnknownHookEvent, build_hook_event
from agenthub_notifier.notifiers.lan_bridge import (
    ENV_ENDPOINT,
    ENV_TOKEN,
    BridgeConfigurationError,
    LanBridgeNotifier,
)


def main(argv: list[str]) -> int:
    requested = argv or list(HOOK_EVENT_TEXT)

    try:
        notifier = LanBridgeNotifier.from_env()
    except BridgeConfigurationError as exc:
        print(f"Cannot send: {exc}")
        print(f"Set {ENV_ENDPOINT} and {ENV_TOKEN} first, for example:")
        print('  $env:AGENTHUB_MAC_ENDPOINT="http://192.168.1.50:8787/events"')
        print('  $env:AGENTHUB_BRIDGE_TOKEN="<your bridge token>"')
        return 1

    print(f"Endpoint : {notifier.config.endpoint}")
    print(f"Auth     : Bearer <token from {ENV_TOKEN}, not shown>")
    print(f"Timeout  : {notifier.config.timeout:g}s, no retries")
    print()

    failures = 0
    for name in requested:
        try:
            event = build_hook_event(name)
        except UnknownHookEvent:
            print(f"  {name:<16} SKIPPED - not one of: {', '.join(HOOK_EVENT_TEXT)}")
            failures += 1
            continue

        result = notifier.deliver(event)
        status = result.status if result.status is not None else "--"
        mark = "OK  " if result.delivered else "FAIL"
        print(f"  {mark} {event.type:<16} HTTP {status:<4} {event.event_id}")
        print(f"       {event.title} / {event.message}")
        if not result.delivered:
            print(f"       {result.message}")
            failures += 1

    print()
    if failures:
        print(f"{failures} of {len(requested)} failed.")
        return 1
    print(f"All {len(requested)} delivered. Check AgentHub on your iPhone.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
