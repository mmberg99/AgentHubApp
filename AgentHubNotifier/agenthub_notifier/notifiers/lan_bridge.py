"""Outbound-only delivery to the AgentHub bridge on the local network.

Separate from HttpsNotifier on purpose. That class mandates HTTPS and must keep
doing so; this one is allowed to speak plain HTTP, and pays for that with a much
narrower target: the endpoint must be a literal PRIVATE IP address. Relaxing one
rule is fine as long as the blast radius shrinks to match.

Four rules make "this can only reach my own LAN" true rather than merely likely:

1. The host must be an IP literal in private space (RFC 1918, loopback or
   link-local). A hostname is refused, so no DNS lookup happens at all and no
   name resolution can point this at the internet.
2. Proxies are disabled. urllib's default opener honours HTTP_PROXY, which would
   hand the bearer token to whatever that variable names -- possibly off-LAN.
3. Redirects are refused. A 302 could otherwise forward the Authorization header
   to another host.
4. The path must be /events. Nothing else on that port is addressable.

The bridge's response is a status code and nothing more: the body is read with a
byte cap and discarded, never parsed. This is a one-way channel.

The token is a secret. It appears only in the Authorization header -- never in
the body, a repr, a log line, an exception message or any output.
"""

from __future__ import annotations

import ipaddress
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field

from ..event import AgentEvent
from ..validation import validate_or_raise
from .base import Notifier

#: Environment variables. Never read from a file, never hard-coded.
ENV_ENDPOINT = "AGENTHUB_MAC_ENDPOINT"
ENV_TOKEN = "AGENTHUB_BRIDGE_TOKEN"

#: One attempt, 2 seconds. The hook that calls this has a 5 second budget and
#: Python needs ~0.2s to start, so a single try cannot overrun it.
TIMEOUT_SECONDS = 2.0
MAX_ATTEMPTS = 1

#: The only path this transport will post to.
REQUIRED_PATH = "/events"

MAX_ENDPOINT_LENGTH = 512
MAX_TOKEN_LENGTH = 4096
MAX_RESPONSE_BYTES = 2048

#: Bearer tokens are printable ASCII with no spaces. Anything else -- in
#: particular CR or LF -- could inject a second HTTP header, so it is refused.
TOKEN_PATTERN = re.compile(r"^[\x21-\x7e]+$")

#: Sent instead of urllib's default, which would disclose the Python version.
USER_AGENT = "AgentHubNotifier/1.0"


class BridgeConfigurationError(Exception):
    """Bridge settings are unusable. Messages never contain the token."""


class BridgeNotConfigured(BridgeConfigurationError):
    """Neither an error nor a surprise: the bridge simply is not set up here.

    Distinct from its parent so a caller can stay silent about it while still
    reporting a genuinely malformed configuration.
    """


class BridgeDeliveryError(Exception):
    """Delivery failed. The message is already sanitised and safe to display."""


@dataclass(frozen=True)
class BridgeResult:
    """Outcome of one delivery attempt.

    ``detail`` is an exception type name or a status code -- never a response
    body, never the token.
    """

    delivered: bool
    message: str
    status: int | None = None
    detail: str | None = None


def _redact(text: str, token: str) -> str:
    """Last line of defence: strip the token from a string if it ever appears."""
    if token and token in text:
        return text.replace(token, "<redacted>")
    return text


def validate_endpoint(endpoint: str | None) -> str:
    """Return a normalised endpoint URL, or raise.

    Accepts only ``http(s)://<private-ip>[:port]/events``. The URL is rebuilt
    from the parts that passed validation, so nothing unexamined survives.
    """
    if endpoint is None or not endpoint.strip():
        raise BridgeNotConfigured(f"{ENV_ENDPOINT} is not set.")

    endpoint = endpoint.strip()
    if len(endpoint) > MAX_ENDPOINT_LENGTH:
        raise BridgeConfigurationError(f"{ENV_ENDPOINT} is too long.")
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in endpoint):
        raise BridgeConfigurationError(f"{ENV_ENDPOINT} contains control characters.")

    try:
        parsed = urllib.parse.urlsplit(endpoint)
    except ValueError:
        raise BridgeConfigurationError(f"{ENV_ENDPOINT} is not a valid URL.") from None

    if parsed.scheme not in ("http", "https"):
        raise BridgeConfigurationError(
            f"{ENV_ENDPOINT} must start with http:// or https:// ."
        )
    if parsed.username or parsed.password:
        raise BridgeConfigurationError(
            f"{ENV_ENDPOINT} must not embed credentials in the URL; use {ENV_TOKEN}."
        )
    if parsed.query or parsed.fragment:
        raise BridgeConfigurationError(f"{ENV_ENDPOINT} must not carry a query or fragment.")

    try:
        hostname = parsed.hostname
        port = parsed.port
    except ValueError:
        raise BridgeConfigurationError(f"{ENV_ENDPOINT} has an invalid host or port.") from None
    if not hostname:
        raise BridgeConfigurationError(f"{ENV_ENDPOINT} is missing a host.")

    # An IP literal only: this is what keeps DNS out of the picture entirely.
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        raise BridgeConfigurationError(
            f"{ENV_ENDPOINT} must use a literal private IP address, not a hostname "
            f"(for example http://192.168.1.50:8787{REQUIRED_PATH})."
        ) from None
    if not address.is_private:
        raise BridgeConfigurationError(
            f"{ENV_ENDPOINT} must point at a private LAN address "
            f"(10.x, 172.16-31.x, 192.168.x, 127.x or link-local). "
            f"Public internet destinations are refused."
        )

    if parsed.path.rstrip("/") != REQUIRED_PATH:
        raise BridgeConfigurationError(f"{ENV_ENDPOINT} must end with {REQUIRED_PATH} .")

    netloc = f"[{address}]" if address.version == 6 else str(address)
    if port is not None:
        netloc = f"{netloc}:{port}"
    return urllib.parse.urlunsplit((parsed.scheme, netloc, REQUIRED_PATH, "", ""))


def validate_token(token: str | None) -> str:
    """Return the token if usable, else raise. The token is never echoed back."""
    if token is None or not token.strip():
        raise BridgeNotConfigured(f"{ENV_TOKEN} is not set.")
    token = token.strip()
    if len(token) > MAX_TOKEN_LENGTH:
        raise BridgeConfigurationError(f"{ENV_TOKEN} is too long.")
    if not TOKEN_PATTERN.match(token):
        # Describes the shape without quoting the value.
        raise BridgeConfigurationError(
            f"{ENV_TOKEN} contains characters that are not allowed in an HTTP header."
        )
    return token


@dataclass(frozen=True)
class BridgeConfig:
    """Validated bridge settings. Holds the token; never reveals it."""

    endpoint: str
    token: str = field(repr=False)
    timeout: float = TIMEOUT_SECONDS

    @classmethod
    def from_env(cls, env: dict | None = None) -> BridgeConfig:
        """Build config from the environment.

        Raises :class:`BridgeNotConfigured` when a variable is simply absent, and
        :class:`BridgeConfigurationError` when one is present but unusable.
        """
        import os

        source = os.environ if env is None else env
        raw_endpoint = source.get(ENV_ENDPOINT)
        raw_token = source.get(ENV_TOKEN)

        missing = []
        if raw_endpoint is None or not str(raw_endpoint).strip():
            missing.append(ENV_ENDPOINT)
        if raw_token is None or not str(raw_token).strip():
            missing.append(ENV_TOKEN)
        if missing:
            raise BridgeNotConfigured(f"{' and '.join(missing)} not set.")

        return cls(endpoint=validate_endpoint(raw_endpoint), token=validate_token(raw_token))

    def __repr__(self) -> str:  # pragma: no cover - trivial, but security-relevant
        return f"BridgeConfig(endpoint={self.endpoint!r}, token=<redacted>, timeout={self.timeout!r})"

    __str__ = __repr__


class _RefuseRedirects(urllib.request.HTTPRedirectHandler):
    """Blocks every redirect.

    Following one could send the Authorization header to a different host.
    Returning None makes urllib raise an HTTPError for the 3xx instead.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def build_opener() -> urllib.request.OpenerDirector:
    """An opener with no proxy support, no redirects and no cookie handling.

    ``ProxyHandler({})`` is the important one: the default opener would read
    HTTP_PROXY from the environment and route this request -- bearer token
    included -- through whatever it names.
    """
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        _RefuseRedirects,
    )


class LanBridgeNotifier(Notifier):
    """Posts a validated event to the AgentHub bridge on the LAN.

    The request body is exactly ``event.to_dict()``. Nothing is added: no
    hostname, username, IP address, working directory, file path or environment
    data. One attempt, no retries.
    """

    def __init__(self, config: BridgeConfig, *, opener: urllib.request.OpenerDirector | None = None) -> None:
        self.config = config
        self._opener = opener

    @classmethod
    def from_env(cls, env: dict | None = None, **kwargs) -> LanBridgeNotifier:
        return cls(BridgeConfig.from_env(env), **kwargs)

    @property
    def opener(self) -> urllib.request.OpenerDirector:
        # Built on first use so constructing the notifier opens nothing.
        if self._opener is None:
            self._opener = build_opener()
        return self._opener

    def build_body(self, event: AgentEvent) -> bytes:
        """The exact bytes that go on the wire: the validated event, UTF-8 JSON."""
        return json.dumps(event.to_dict(), separators=(",", ":"), ensure_ascii=False).encode("utf-8")

    @property
    def messages_endpoint(self) -> str:
        """The conversation-message endpoint: the SAME loopback relay, path ``/messages``.

        Derived from the configured events endpoint so there is exactly one
        configured destination and one token. A relay reachable only on
        127.0.0.1 for events is reachable only on 127.0.0.1 for messages.
        """
        endpoint = self.config.endpoint
        if endpoint.endswith("/events"):
            return endpoint[: -len("/events")] + "/messages"
        return endpoint.rstrip("/") + "/messages"

    def build_message_body(self, message) -> bytes:
        return json.dumps(message.to_dict(), separators=(",", ":"), ensure_ascii=False).encode("utf-8")

    def deliver_message(self, message) -> BridgeResult:
        """Send one ConversationMessage. Same one-attempt, never-raise contract as ``deliver``."""
        request = self.build_request(self.build_message_body(message), url=self.messages_endpoint)
        return self._send(request)

    def build_request(self, body: bytes, url: str | None = None) -> urllib.request.Request:
        return urllib.request.Request(
            url or self.config.endpoint,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.config.token}",
                "Accept": "application/json",
                "User-Agent": USER_AGENT,
            },
        )

    def deliver(self, event: AgentEvent) -> BridgeResult:
        """Send the event. Never raises for a delivery problem -- returns a result."""
        validate_or_raise(event)
        request = self.build_request(self.build_body(event))
        return self._send(request)

    def _send(self, request: urllib.request.Request) -> BridgeResult:
        try:
            with self.opener.open(request, timeout=self.config.timeout) as response:
                status = getattr(response, "status", None) or response.getcode()
                # Read and throw away: the bridge's reply is a status code to us,
                # never data, never instructions.
                response.read(MAX_RESPONSE_BYTES)
        except urllib.error.HTTPError as exc:
            return self._from_http_error(exc)
        except urllib.error.URLError as exc:
            return BridgeResult(
                delivered=False,
                message="AgentHub bridge could not be reached.",
                detail=self._safe_detail(exc),
            )
        except TimeoutError:
            return BridgeResult(
                delivered=False,
                message="AgentHub bridge did not respond in time.",
                detail="TimeoutError",
            )
        except OSError as exc:
            return BridgeResult(
                delivered=False,
                message="AgentHub bridge could not be reached.",
                detail=self._safe_detail(exc),
            )

        if 200 <= status < 300:
            return BridgeResult(delivered=True, message="AgentHub event delivered.", status=status)
        return BridgeResult(
            delivered=False,
            message="AgentHub bridge returned an unexpected response.",
            status=status,
            detail=f"status {status}",
        )

    def _from_http_error(self, exc: urllib.error.HTTPError) -> BridgeResult:
        status = exc.code
        if status in (301, 302, 303, 307, 308):
            message = "AgentHub bridge returned a redirect; refusing to follow it."
        elif status in (401, 403):
            message = "AgentHub bridge rejected the request."
        elif 400 <= status < 500:
            message = "AgentHub bridge refused the event."
        else:
            message = "AgentHub bridge is unavailable."
        # The response body is never read here: it could contain anything.
        return BridgeResult(delivered=False, message=message, status=status, detail=f"status {status}")

    def _safe_detail(self, exc: BaseException) -> str:
        """A short internal note. Only the exception type -- never its text."""
        return _redact(type(exc).__name__, self.config.token)

    def notify(self, event: AgentEvent) -> None:
        """Notifier contract: deliver, or raise a sanitised error."""
        result = self.deliver(event)
        if not result.delivered:
            raise BridgeDeliveryError(_redact(result.message, self.config.token))
