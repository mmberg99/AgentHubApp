"""Helper for the no-networking test.

Runs a full default (local) CLI invocation in a fresh interpreter, then
reports which networking modules ended up in sys.modules. Prints a JSON list to
stdout: an empty list means nothing network-capable was loaded.
"""

from __future__ import annotations

import io
import json
import sys

FORBIDDEN = ("socket", "ssl", "http", "urllib", "requests", "ftplib",
             "smtplib", "asyncio", "xmlrpc", "webbrowser", "email")

from agenthub_notifier import cli  # noqa: E402

sink = io.StringIO()
exit_code = cli.run(["completed", "--agent", "Claude Code"], stdout=sink, stderr=io.StringIO())

loaded = sorted({m for m in sys.modules if m.split(".")[0] in FORBIDDEN})

# The HTTPS transport must not even be imported on the local path -- it is
# loaded lazily, only when --send or --dry-run asks for it.
if "agenthub_notifier.notifiers.https" in sys.modules:
    loaded.append("agenthub_notifier.notifiers.https")

print(json.dumps(loaded))
sys.exit(exit_code)
