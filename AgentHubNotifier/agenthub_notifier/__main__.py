"""Allows `python -m agenthub_notifier <type> [options]`."""

from .cli import main

if __name__ == "__main__":
    raise SystemExit(main())
