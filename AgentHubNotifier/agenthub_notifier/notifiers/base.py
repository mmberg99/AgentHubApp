"""The transport abstraction the rest of the program depends on."""

from __future__ import annotations

from abc import ABC, abstractmethod

from ..event import AgentEvent


class Notifier(ABC):
    """Delivers a validated event somewhere.

    Implementations must assume the event has already passed validation, and
    must never add fields to it. A future HttpsNotifier will implement this same
    interface, so nothing above this layer needs to change when it arrives.
    """

    @abstractmethod
    def notify(self, event: AgentEvent) -> None:
        """Deliver one event. Raise on unrecoverable failure."""
        raise NotImplementedError
