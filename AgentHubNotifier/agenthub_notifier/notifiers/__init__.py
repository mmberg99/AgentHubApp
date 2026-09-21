"""Notifier implementations.

``ConsoleNotifier`` is imported eagerly. Everything from the HTTPS transport is
loaded on first use instead, so a plain local invocation never even imports a
network-capable module. A test enforces this.
"""

from .base import Notifier
from .console import ConsoleNotifier

_LAZY = {
    "ConfigurationError",
    "DeliveryError",
    "DeliveryResult",
    "HttpsConfig",
    "HttpsNotifier",
    "is_offline_mode",
}

__all__ = ["Notifier", "ConsoleNotifier", *sorted(_LAZY)]


def __getattr__(name):
    if name in _LAZY:
        from . import https

        return getattr(https, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__():
    return sorted(__all__)
