"""Local-only notifier: prints the normalised event and nothing else.

Phase 1 has no networking. This notifier writes to a stream you hand it
(stdout by default) so it can be tested without touching the real console.
"""

from __future__ import annotations

import json
import sys
from typing import TextIO

from ..event import AgentEvent
from .base import Notifier


class ConsoleNotifier(Notifier):
    """Writes the event as JSON to a text stream."""

    def __init__(self, stream: TextIO | None = None, *, pretty: bool = False) -> None:
        self._stream = stream
        self.pretty = pretty

    @property
    def stream(self) -> TextIO:
        # Resolved late so tests can patch sys.stdout after construction.
        return self._stream if self._stream is not None else sys.stdout

    def render(self, event: AgentEvent) -> str:
        data = event.to_dict()
        if self.pretty:
            return json.dumps(data, indent=2, ensure_ascii=False)
        return json.dumps(data, separators=(",", ":"), ensure_ascii=False)

    def notify(self, event: AgentEvent) -> None:
        self.stream.write(self.render(event) + "\n")
        self.stream.flush()
