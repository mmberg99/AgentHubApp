"""Outbound-only HTTPS delivery of agent events.

This is the ONLY module in the package permitted to import network-capable
standard-library modules, which keeps the audit surface to one file. It opens
outbound connections exclusively: it never binds, never listens, and never
accepts a connection.

The relay's response is treated as a status code and nothing else -- the body is
read with a hard byte cap and discarded, never parsed, never executed. This is a
one-way notification channel.

The auth token is a secret. It appears only in the Authorization header of the
outbound request: never in the event body, never in a repr, a log line, an
exception message or any user-facing string.
"""

from __future__ import annotations

import json
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field

from ..event import AgentEvent
from ..validation import validate_or_raise
from .base import Notifier

#: Environment variables. Never read from a file, never hard-coded.
ENV_ENDPOINT = "AGENTHUB_ENDPOINT"
ENV_TOKEN = "AGENTHUB_AUTH_TOKEN"
ENV_TIMEOUT = "AGENTHUB_TIMEOUT_SECONDS"
ENV_OFFLINE = "AGENTHUB_OFFLINE"

DEFAULT_TIMEOUT_SECONDS = 5.0
MIN_TIMEOUT_SECONDS = 1.0
MAX_TIMEOUT_SECONDS = 30.0

#: One initial attempt plus at most two retries.
MAX_ATTEMPTS = 3
#: Seconds to wait before retry 1 and retry 2.
BACKOFF_SECONDS = (0.5, 1.5)

MAX_ENDPOINT_LENGTH = 2048
MAX_TOKEN_LENGTH = 4096
#: Response bodies are discarded; this only bounds how much we pull off the wire.
MAX_RESPONSE_BYTES = 2048

#: Bearer tokens are printable ASCII with no spaces. Anything else -- in
#: particular CR or LF -- could inject a second HTTP header, so it is refused.
TOKEN_PATTERN = re.compile(r"^[\x21-\x7e]+$")

#: Sent instead of urllib's default, which would disclose the Python version.
USER_AGENT = "AgentHubNotifier/1.0"

#: Status codes worth a second try: the relay is busy or briefly unavailable.
RETRYABLE_STATUS = frozenset({408, 429, 500, 502, 503, 504})


class ConfigurationError(Exception):
    """Configuration is missing or unusable. The caller must fix it.

    Messages are written for a human and never contain the token.
    """


class DeliveryError(Exception):
    """Delivery failed. The message is already sanitised and safe to display."""


@dataclass(frozen=True)
class DeliveryResult:
    """Outcome of a delivery attempt.

    ``message`` is user-facing and sanitised. ``detail`` is a short internal
    note (exception type or status code only -- never a response body, never the
    token) kept for local troubleshooting.
    """

    delivered: bool
    message: str
    attempts: int = 1
    status: int | None = None
    detail: str | None = None


def _redact(text: str, token: str) -> str:
    """Last line of defence: strip the token from a string if it ever appears."""
    if token and token in text:
        return text.replace(token, "<redacted>")
    return text


def validate_endpoint(endpoint: str | None) -> str:
    """Return the endpoint if it is a well-formed HTTPS URL, else raise.

    HTTPS is mandatory. There is no flag, environment variable or redirect that
    can downgrade this to plain HTTP.
    """
    if endpoint is None or not endpoint.strip():
        raise ConfigurationError(f"{ENV_ENDPOINT} is not set.")

    endpoint = endpoint.strip()
    if len(endpoint) > MAX_ENDPOINT_LENGTH:
        raise ConfigurationError(f"{ENV_ENDPOINT} is too long.")
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in endpoint):
        raise ConfigurationError(f"{ENV_ENDPOINT} contains control characters.")

    try:
        parsed = urllib.parse.urlsplit(endpoint)
    except ValueError:
        raise ConfigurationError(f"{ENV_ENDPOINT} is not a valid URL.") from None

    if parsed.scheme == "http":
        raise ConfigurationError(
            f"{ENV_ENDPOINT} uses http://. HTTPS is required and will not be downgraded."
        )
    if parsed.scheme != "https":
        raise ConfigurationError(f"{ENV_ENDPOINT} must start with https:// .")
    if parsed.username or parsed.password:
        raise ConfigurationError(
            f"{ENV_ENDPOINT} must not embed credentials in the URL; use {ENV_TOKEN}."
        )
    try:
        hostname = parsed.hostname
    except ValueError:
        raise ConfigurationError(f"{ENV_ENDPOINT} is not a valid URL.") from None
    if not hostname:
        raise ConfigurationError(f"{ENV_ENDPOINT} is missing a hostname.")
    try:
        parsed.port
    except ValueError:
        raise ConfigurationError(f"{ENV_ENDPOINT} has an invalid port.") from None

    return endpoint


def validate_token(token: str | None) -> str:
    """Return the token if usable, else raise. The token is never echoed back."""
    if token is None or not token.strip():
        raise ConfigurationError(f"{ENV_TOKEN} is not set.")
    token = token.strip()
    if len(token) > MAX_TOKEN_LENGTH:
        raise ConfigurationError(f"{ENV_TOKEN} is too long.")
    if not TOKEN_PATTERN.match(token):
        # Deliberately describes the shape without quoting the value.
        raise ConfigurationError(
            f"{ENV_TOKEN} contains characters that are not allowed in an HTTP header."
        )
    return token


def _resolve_timeout(raw: str | None) -> float:
    if raw is None or not str(raw).strip():
        return DEFAULT_TIMEOUT_SECONDS
    try:
        timeout = float(str(raw).strip())
    except ValueError:
        raise ConfigurationError(f"{ENV_TIMEOUT} must be a number of seconds.") from None
    if not MIN_TIMEOUT_SECONDS <= timeout <= MAX_TIMEOUT_SECONDS:
        raise ConfigurationError(
            f"{ENV_TIMEOUT} must be between {MIN_TIMEOUT_SECONDS:g} and {MAX_TIMEOUT_SECONDS:g} seconds."
        )
    return timeout


def is_offline_mode(env: dict | None = None) -> bool:
    """True when ``AGENTHUB_OFFLINE`` asks us to build events but not send them."""
    import os

    source = os.environ if env is None else env
    return str(source.get(ENV_OFFLINE, "")).strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class HttpsConfig:
    """Validated delivery settings. Holds the token; never reveals it."""

    endpoint: str
    token: str = field(repr=False)
    timeout: float = DEFAULT_TIMEOUT_SECONDS

    @classmethod
    def from_env(cls, env: dict | None = None) -> HttpsConfig:
        """Build config from the environment. Raises :class:`ConfigurationError`.

        Every problem found is reported at once so a first-time setup does not
        turn into a guessing game.
        """
        import os

        source = os.environ if env is None else env
        problems: list[str] = []

        endpoint = token = None
        try:
            endpoint = validate_endpoint(source.get(ENV_ENDPOINT))
        except ConfigurationError as exc:
            problems.append(str(exc))
        try:
            token = validate_token(source.get(ENV_TOKEN))
        except ConfigurationError as exc:
            problems.append(str(exc))
        timeout = DEFAULT_TIMEOUT_SECONDS
        try:
            timeout = _resolve_timeout(source.get(ENV_TIMEOUT))
        except ConfigurationError as exc:
            problems.append(str(exc))

        if problems:
            raise ConfigurationError(" ".join(problems))
        return cls(endpoint=endpoint, token=token, timeout=timeout)

    def __repr__(self) -> str:  # pragma: no cover - trivial, but security-relevant
        return f"HttpsConfig(endpoint={self.endpoint!r}, token=<redacted>, timeout={self.timeout!r})"

    __str__ = __repr__


class _RefuseRedirects(urllib.request.HTTPRedirectHandler):
    """Blocks every redirect.

    Following one could send the Authorization header to a different host, or
    downgrade the connection to plain HTTP. Returning None makes urllib raise an
    HTTPError for the 3xx instead, which we report as a failure.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def build_tls_context() -> ssl.SSLContext:
    """A strict TLS context: verified certificates, verified hostname, TLS 1.2+."""
    context = ssl.create_default_context()
    context.check_hostname = True
    context.verify_mode = ssl.CERT_REQUIRED
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    return context


def build_opener(context: ssl.SSLContext | None = None) -> urllib.request.OpenerDirector:
    """An opener with strict TLS, no redirects and no cookie handling."""
    return urllib.request.build_opener(
        _RefuseRedirects,
        urllib.request.HTTPSHandler(context=context or build_tls_context()),
    )


class HttpsNotifier(Notifier):
    """Posts a validated event to the AgentHub relay over HTTPS.

    The request body is exactly ``event.to_dict()`` -- no hostname, username, IP
    address, working directory, file path or environment data is added.
    """

    def __init__(
        self,
        config: HttpsConfig,
        *,
        opener: urllib.request.OpenerDirector | None = None,
        sleep=None,
        max_attempts: int = MAX_ATTEMPTS,
    ) -> None:
        self.config = config
        self._opener = opener
        self._sleep = sleep if sleep is not None else time.sleep
        self.max_attempts = max(1, int(max_attempts))

    @classmethod
    def from_env(cls, env: dict | None = None, **kwargs) -> HttpsNotifier:
        return cls(HttpsConfig.from_env(env), **kwargs)

    @property
    def opener(self) -> urllib.request.OpenerDirector:
        # Built on first use so constructing the notifier opens nothing.
        if self._opener is None:
            self._opener = build_opener()
        return self._opener

    def build_body(self, event: AgentEvent) -> bytes:
        """The exact bytes that go on the wire: the validated event, UTF-8 JSON."""
        return json.dumps(event.to_dict(), separators=(",", ":"), ensure_ascii=False).encode("utf-8")

    def build_request(self, body: bytes) -> urllib.request.Request:
        return urllib.request.Request(
            self.config.endpoint,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json; charset=utf-8",
                "Authorization": f"Bearer {self.config.token}",
                "Accept": "application/json",
                "User-Agent": USER_AGENT,
            },
        )

    def deliver(self, event: AgentEvent) -> DeliveryResult:
        """Send the event. Never raises for a delivery problem -- returns a result.

        The body is built once, before the retry loop, so a retry re-sends byte
        for byte the same event, including the same ``eventId``. That is what
        lets the relay de-duplicate.
        """
        validate_or_raise(event)

        body = self.build_body(event)
        last = DeliveryResult(delivered=False, message="AgentHub notification could not be delivered.")

        for attempt in range(1, self.max_attempts + 1):
            outcome = self._attempt(body, attempt)
            if outcome.delivered or not self._is_retryable(outcome):
                return outcome
            last = outcome
            if attempt < self.max_attempts:
                self._sleep(BACKOFF_SECONDS[min(attempt - 1, len(BACKOFF_SECONDS) - 1)])

        return DeliveryResult(
            delivered=False,
            message=last.message,
            attempts=self.max_attempts,
            status=last.status,
            detail=last.detail,
        )

    def _attempt(self, body: bytes, attempt: int) -> DeliveryResult:
        request = self.build_request(body)
        try:
            with self.opener.open(request, timeout=self.config.timeout) as response:
                status = getattr(response, "status", None) or response.getcode()
                # Read and throw away: the relay's reply is a status code to us,
                # never data, never instructions.
                response.read(MAX_RESPONSE_BYTES)
        except urllib.error.HTTPError as exc:
            return self._from_http_error(exc, attempt)
        except urllib.error.URLError as exc:
            return DeliveryResult(
                delivered=False,
                message="AgentHub relay could not be reached.",
                attempts=attempt,
                detail=self._safe_detail(exc),
            )
        except TimeoutError:
            return DeliveryResult(
                delivered=False,
                message="AgentHub relay did not respond in time.",
                attempts=attempt,
                detail="TimeoutError",
            )
        except OSError as exc:
            return DeliveryResult(
                delivered=False,
                message="AgentHub relay could not be reached.",
                attempts=attempt,
                detail=self._safe_detail(exc),
            )

        if 200 <= status < 300:
            return DeliveryResult(
                delivered=True,
                message="AgentHub notification delivered.",
                attempts=attempt,
                status=status,
            )
        return DeliveryResult(
            delivered=False,
            message="AgentHub relay returned an unexpected response.",
            attempts=attempt,
            status=status,
            detail=f"status {status}",
        )

    def _from_http_error(self, exc: urllib.error.HTTPError, attempt: int) -> DeliveryResult:
        status = exc.code
        if status in (301, 302, 303, 307, 308):
            message = "AgentHub relay returned a redirect; refusing to follow it."
        elif status in (401, 403):
            message = "AgentHub relay rejected the request."
        elif status == 429:
            message = "AgentHub relay is rate limiting; notification not delivered."
        elif 400 <= status < 500:
            message = "AgentHub relay refused the event."
        else:
            message = "AgentHub relay is unavailable."
        # The response body is never read here: it could contain anything.
        return DeliveryResult(
            delivered=False, message=message, attempts=attempt, status=status, detail=f"status {status}"
        )

    def _is_retryable(self, result: DeliveryResult) -> bool:
        """Retry transient network trouble only.

        Authentication failures and other client errors are never retried --
        they will not fix themselves, and hammering the relay is rude.
        """
        if result.status is None:
            return True  # connection-level failure
        return result.status in RETRYABLE_STATUS

    def _safe_detail(self, exc: BaseException) -> str:
        """A short internal note. Only the exception type -- never its text."""
        return _redact(type(exc).__name__, self.config.token)

    def notify(self, event: AgentEvent) -> None:
        """Notifier contract: deliver, or raise a sanitised :class:`DeliveryError`."""
        result = self.deliver(event)
        if not result.delivered:
            raise DeliveryError(_redact(result.message, self.config.token))
