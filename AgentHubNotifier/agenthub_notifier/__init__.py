"""AgentHub Notifier -- a small, outbound-only agent status reporter.

Local by default: importing this package, or running the CLI without --send,
loads no network-capable module at all. The HTTPS transport lives in
``notifiers.https`` and is imported only when you explicitly ask to send.

Nothing here ever listens on a port or accepts an inbound connection.
"""

from .event import EVENT_TYPES, PROVIDERS, PROTOCOL_VERSION, AgentEvent, build_event
from .notifiers import ConsoleNotifier, Notifier
from .validation import EventValidator, ValidationError, validate, validate_or_raise

__version__ = "0.2.0"

#: Loaded on first use so the local path stays free of networking imports.
_LAZY = {
    "ConfigurationError",
    "DeliveryError",
    "DeliveryResult",
    "HttpsConfig",
    "HttpsNotifier",
}

__all__ = [
    "AgentEvent",
    "ConsoleNotifier",
    "EVENT_TYPES",
    "EventValidator",
    "Notifier",
    "PROTOCOL_VERSION",
    "PROVIDERS",
    "ValidationError",
    "build_event",
    "validate",
    "validate_or_raise",
    *sorted(_LAZY),
]


def __getattr__(name):
    if name in _LAZY:
        from .notifiers import https

        return getattr(https, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
