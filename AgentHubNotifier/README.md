# AgentHub Notifier

A small local utility that lets AI agents and scripts running on this Windows PC
report a minimal status event such as **started**, **running**, **completed**,
**needs approval**, **needs input** or **failed**.

Eventually these events will reach the **AgentHub** iPhone app so you do not have
to keep checking this computer. The outbound HTTPS transport now exists, but
**the relay it would talk to does not** — so in practice the notifier still runs
entirely locally until you build one.

---

## Security posture

| | |
|---|---|
| Default behaviour | **Local.** Without `--send`, nothing leaves this machine and no network-capable module is even imported — enforced by a test. |
| Outbound (internet) | **HTTPS only**, and only when you pass `--send`. `http://` is refused, redirects are refused, TLS 1.2+ with certificate and hostname verification. |
| Outbound (LAN bridge) | Plain HTTP allowed, but **only to a literal private IP** at `/events`. Hostnames refused (so no DNS), proxies disabled, redirects refused. Used by the Claude Code hooks. |
| Inbound access | **None.** No server, no listening port, no localhost exposure, no polling for remote commands. Nothing on the internet can start a connection to this PC. |
| Relay responses | Read with a byte cap and **discarded**. Never parsed, never executed, never written to disk. One-way channel. |
| Credentials | **None required to run.** Endpoint and token come only from environment variables. `.env.example` holds fake placeholders. |
| Privileges | Runs as your normal user. Changes nothing outside this folder. |
| External packages | **None.** Python standard library only. |

Only two files may import a network-capable module:
[`notifiers/https.py`](agenthub_notifier/notifiers/https.py) and
[`notifiers/lan_bridge.py`](agenthub_notifier/notifiers/lan_bridge.py). A test fails
if any other file does -- including the hook launcher -- which keeps the whole
network surface to two reviewable files.

---

## Requirements

Python 3.11 or newer on `PATH`. This machine has **Python 3.13.15** — nothing to install.

```powershell
python --version
```

---

## Quick start

From the project folder:

```powershell
.\agenthub-notifier.cmd completed --agent "Claude Code"
```

Output (normalised JSON on **stdout**, a human-readable line on **stderr**):

```json
{"version":1,"eventId":"evt-8b1f1c6e...","agentId":"claude-code","agentName":"Claude Code","provider":"claude","type":"completed","title":"Task completed","message":"Claude Code finished its task.","timestamp":"2026-09-20T12:00:00Z"}
```

Three equivalent ways to invoke it:

```powershell
.\agenthub-notifier.cmd completed --agent "Claude Code"     # cmd shim, works from any shell
.\agenthub-notifier.ps1 completed --agent "Claude Code"     # PowerShell shim
python -m agenthub_notifier completed --agent "Claude Code" # direct, run from project root
```

### Calling it from anywhere

The shims set `PYTHONPATH` themselves, so they work from any directory — just
give the full path:

```powershell
C:\Users\mmarc\source\repos\AgentHubNotifier\agenthub-notifier.cmd completed --agent "Claude Code"
```

To type just `agenthub-notifier`, add the folder to your **user** `PATH` via
Windows Settings → *Edit environment variables for your account*. (Not done
automatically — that would modify settings outside this workspace.)

---

## Usage

```text
agenthub-notifier TYPE [options]
```

### Event types

`started` · `running` · `completed` · `needs-approval` · `needs-input` · `failed`

Both `needs-approval` and `needs_approval` are accepted; the output always uses
the canonical underscore form.

### Options

| Option | Meaning | Default |
|---|---|---|
| `--agent NAME` | Display name, e.g. `"Claude Code"` | `Agent` |
| `--agent-id ID` | Stable machine id | derived from the name (`claude-code`) |
| `--provider P` | `claude`, `openai` or `custom` | inferred from the name, else `custom` |
| `--task ID` | Optional task id, for grouping events | none |
| `--title TEXT` | Short headline, max 100 chars | per-type default |
| `--message TEXT` | One-line body, max 300 chars | per-type default |
| `--timestamp ISO` | Override the UTC timestamp (testing) | now, in UTC |
| `--pretty` | Indent the JSON | off |
| `--quiet` | Suppress the stderr summary line | off |
| `--send` | Send over HTTPS to the relay (see below) | **off — local is the default** |
| `--dry-run` | Show what `--send` would transmit, check the config, make no request | off |

Provider inference is a convenience: a name containing *claude* maps to `claude`,
one containing *codex*, *openai* or *gpt* maps to `openai`, anything else to
`custom`. `--provider` always wins.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Event was valid and printed (or delivered, with `--send`) |
| `2` | Event was rejected, or the arguments were wrong. **Nothing is printed to stdout.** |
| `3` | Event was valid but the relay could not be reached |
| `4` | `--send` or `--dry-run` was used but the configuration is missing or invalid |

**Exit code `3` means only that the notification failed.** The task the calling
agent was doing is unaffected — if Claude finishes its work while the relay is
offline, the work is still finished. A caller that does not care may ignore it.
Nothing is ever raised as a traceback to the calling agent.

---

## Event format

Provider-neutral, version `1`:

```json
{
  "version": 1,
  "eventId": "evt-a4c34b0b020e4e1c86011cdd87239171",
  "agentId": "codex",
  "agentName": "Codex",
  "provider": "openai",
  "type": "needs_approval",
  "title": "Approval needed",
  "message": "Codex needs approval.",
  "timestamp": "2026-09-20T12:00:00Z",
  "taskId": "build-42"
}
```

`taskId` is omitted when unset. There is **no free-form payload field** — the
structure is fixed, so nothing extra can be attached to an event.

---

## Validation

Every event passes through the validator before any notifier sees it. An event
is **rejected**, not trimmed, if it has:

- an unknown event type
- an unsupported protocol version
- an unsupported provider
- a missing required field
- a timestamp that is not ISO-8601 **in UTC** (naive or offset timestamps fail)
- a title over **100** characters
- a message over **300** characters
- control characters or line breaks in any text field
- a malformed `eventId`, `agentId` or `taskId`

Event ids are generated per invocation (`evt-` + a UUID4 hex), never supplied by
the caller.

---

## Privacy

Assume every message may appear on an iPhone lock screen. Keep them boring:

| Good | Bad |
|---|---|
| `Claude Code finished its task.` | `Claude finished editing confidential-contract.docx...` |
| `Codex needs approval.` | a pasted terminal log |
| `Coding Agent failed.` | a stack trace with file paths |

Built-in guards:

- The CLI **never reads stdin and never reads files** — every value comes from an
  explicit flag, so nothing can be piped in by accident.
- Line breaks in `--message` are flattened to a single line, which blocks the
  usual "paste the whole log" reflex; other control characters are rejected.
- Hard length caps keep any accidental leak short.

These are guardrails, not a filter. **Never pass source code, prompts, agent
responses, logs, file contents, environment variables, tokens or customer data
to `--message`.** Use the defaults wherever possible.

---

## Project layout

```text
AgentHubNotifier/
  agenthub_notifier/
    __init__.py        public API
    __main__.py        enables `python -m agenthub_notifier`
    event.py           AgentEvent, limits, defaults, build_event()
    validation.py      EventValidator / validate() / validate_or_raise()
    cli.py             argument parsing and the entry point
    notifiers/
      base.py          Notifier abstract base class
      console.py       ConsoleNotifier -- prints locally, the default
      https.py         HttpsNotifier -- future internet relay, HTTPS only
      lan_bridge.py    LanBridgeNotifier -- the Mac bridge, private LAN only
    hook_events.py     the five fixed hook events; no I/O; identity via HookContext only
    hook_context.py    the cwd/session_id allow-list and hashing; no I/O
  tests/
    test_agenthub_notifier.py   event model, validation, CLI, privacy
    test_https_notifier.py      transport, config, retries, token safety
    test_lan_bridge.py          LAN guard, hook events, hostile-payload leakage
    _network_probe.py           helper for the "no networking" test
  agenthub-hook.py     spawned by the Claude Code hooks
  send-test-event.py   send synthetic events to the bridge and report
  agenthub-notifier.cmd / .ps1
  .env.example         fake placeholders for the relay settings
  README.md
```

The CLI depends only on the `Notifier` abstraction, so `HttpsNotifier` dropped in
without changing the event model, the validator or the event format.

`HttpsNotifier` is imported **lazily**: the package exposes it through a module
`__getattr__`, so a local run never loads `urllib` or `ssl` at all.

---

## Sending to the relay (`--send`)

> **The relay does not exist yet.** The values below are placeholders and the
> `.invalid` domain can never resolve, so nothing is going anywhere until you
> build one. Everything in this section is verified by tests using mocks only —
> no real request has ever been made by this project.

### Configuration

Both values come **only** from environment variables. Neither is hard-coded, and
no `.env` file is read (that would need a third-party package).

```powershell
# PLACEHOLDERS -- not a real endpoint, not a real token.
$env:AGENTHUB_ENDPOINT="https://relay.example.invalid/v1/events"
$env:AGENTHUB_AUTH_TOKEN="replace-with-a-real-secret"
```

Set that way, the values last for the current terminal session only. Optional:

| Variable | Meaning | Default |
|---|---|---|
| `AGENTHUB_TIMEOUT_SECONDS` | Per-attempt timeout, 1–30 | `5` |
| `AGENTHUB_OFFLINE` | Set to `1` to make `--send` build and validate but transmit nothing | `0` |

See [.env.example](.env.example). **A real token must never be committed** —
`.gitignore` already excludes `.env`.

### Check your setup first — `--dry-run`

```powershell
.\agenthub-notifier.cmd completed --agent "Claude" --dry-run
```

Prints the exact JSON body that would be POSTed, names the endpoint, confirms the
token is present **without showing it**, and makes **no network request** of any
kind. Exits `4` if configuration is missing, so it doubles as a preflight check.

### Then send

```powershell
.\agenthub-notifier.cmd completed --agent "Claude" --send
.\agenthub-notifier.cmd needs-approval --agent "Codex" --send
```

**Without `--send`, commands stay local — exactly as before.** Setting the
environment variables does not change that; the default never sends.

### What goes on the wire

```text
POST <AGENTHUB_ENDPOINT>
Content-Type: application/json; charset=utf-8
Authorization: Bearer <AGENTHUB_AUTH_TOKEN>
Accept: application/json
User-Agent: AgentHubNotifier/1.0

<the validated event, exactly as printed locally>
```

The body is the event and nothing else. **No hostname, Windows username, IP
address, working directory, file path, terminal output, environment variable or
credential is added** — a test asserts this by searching the body for each of
them. The `User-Agent` is fixed so it does not disclose your Python version.

### Behaviour

| | |
|---|---|
| Transport | HTTPS only. `http://` is rejected at configuration time and never silently upgraded. |
| TLS | Certificate **and** hostname verification on, TLS 1.2 minimum. |
| Redirects | **Refused, not followed.** Following a 302 could leak the `Authorization` header to another host or downgrade to HTTP. |
| Timeout | 5 seconds per attempt. Never blocks indefinitely. |
| Retries | At most 2, after 0.5s then 1.5s — only for connection failures, timeouts, `429` and `5xx`. |
| Never retried | `401`, `403` and other `4xx`. They will not fix themselves. |
| Duplicates | A retry re-sends byte-for-byte the same body, keeping the same `eventId`, so the relay can de-duplicate. |
| Response | Read with a 2 KB cap and **discarded**. Never parsed, never executed, never written to disk. Only the status code is used. |

### The token

It is sent in the `Authorization` header and nowhere else. It never appears in
the event body, in the URL, in a `repr`, in a log line, in an exception message
or in any output — including `--dry-run`, which prints only
`Bearer <token from AGENTHUB_AUTH_TOKEN, not shown>`. A token containing CR or LF
is rejected outright, since it could inject a second HTTP header.

Failures are reported as one generic sanitised line. An authentication failure
says only:

```text
[agenthub] AgentHub relay rejected the request.
```

---

## Claude Code hooks → AgentHub Mac bridge

Four Claude Code hooks are configured in `~/.claude/settings.json`. Each spawns
`agenthub-hook.py` with one literal argument, and that argument is the only
input to the event that gets sent.

| Hook event | Argument | Event sent | Push? |
|---|---|---|---|
| `SessionStart` | `idle` (a legacy `started` is also reported as `idle`) | `Session open` / `Claude Code is open and waiting for a prompt.` | no |
| `UserPromptSubmit` | `running` | `Task running` / `Claude Code is working.` | no |
| `Stop` (nothing outstanding) | `completed` | `Task completed` / `Claude Code completed a task.` | **yes** |
| `Stop` (background_tasks or session_crons non-empty) | `completed` -> reported as `idle` | `Waiting on background work` / `Claude Code is waiting for background work to finish.` | no |
| `PermissionRequest` | `needs-approval` | `Approval needed` / `Claude Code needs approval.` | **yes** |
| `Notification` (`idle_prompt`) | `needs-input` | `Input needed` / `Claude Code is waiting for your input.` | **yes** |
| `StopFailure` | `failed` | `Task failed` / `Claude Code failed a task.` | **yes** |
| `SubagentStart` | `subagent-start` | `Subtask running` / `A subagent is working.` (child of the main task) | no |
| `SubagentStop` | `subagent-stop` | `Subtask completed` / `A subagent finished its work.` (child; never completes the parent) | yes, as "Subtask completed" |
| any hook firing inside a subagent (`agent_id` present) | as configured | routed as child activity of the main task, own type | per type |

Which types push is decided by the relay (`notificationPolicy.mjs`); the hook
only reports state. A `Stop` is classified structurally from the payload at
that instant -- never from the model's prose, never with a timer: outstanding
work means `idle` and no notification; nothing outstanding means `completed`
and one notification.

Opening a session is not working: `SessionStart` is reported as `idle`
("Session open"), never as Running, and never produces a notification. The
first `UserPromptSubmit` turns the same task Running. This hook never emits the
`started` wire type at all; that type remains valid for other providers.

`agentId` is always `win_claude_code`, `agentName` always `Claude Code`,
`provider` always `claude`. A fresh UUID and UTC timestamp are generated per
event. Any extra arguments in `settings.json` (`--agent`, `--quiet`) are ignored.

### Configuration

```powershell
# PLACEHOLDERS -- use your Mac's actual LAN IP and bridge token.
$env:AGENTHUB_MAC_ENDPOINT="http://192.168.1.50:8787/events"
$env:AGENTHUB_BRIDGE_TOKEN="<your bridge token>"
```

Set these at **user** scope (Windows Settings → *Edit environment variables for
your account*) so Claude Code sessions inherit them. A `$env:` assignment lasts
only for the current terminal.

If either variable is missing, the hook exits 0 and sends nothing.

### Verify the sender on its own

```powershell
python send-test-event.py                 # all four types
python send-test-event.py completed       # just one
```

Prints the endpoint, each event's id and the bridge's HTTP status. The token is
never printed.

### What can leave this PC

Nine constant or generated fields, plus up to three **derived identity**
fields:

```json
{
  "version": 1,
  "eventId": "evt-a3fe63cda40d4daaaf3b5a6924818a49",
  "agentId": "win_claude_code",
  "agentName": "Claude Code",
  "provider": "claude",
  "type": "completed",
  "title": "Task completed",
  "message": "Claude Code completed a task.",
  "timestamp": "2026-09-20T10:11:30Z",
  "projectId": "p-3f9a1c2b4d5e",
  "projectName": "RobotFramework",
  "taskId": "s-9c1e7b2a4d6f8e0a"
}
```

Nothing else. The Claude hook payload that arrives on stdin is decoded and
read for **exactly six keys** -- `cwd`, `session_id`, `background_tasks`,
`session_crons`, `agent_id` and `agent_type` -- by name, in
`hook_context.extract_hook_context()`.
Everything else in it (`transcript_path`, `tool_input`, `tool_output`,
`last_assistant_message`, `prompt`, `permission_mode`, any future field) is
never looked at, and the decoded object is deleted as soon as those values
have been derived from.

`background_tasks` and `session_crons` reduce to **two booleans** -- is the
list non-empty? -- and nothing more. Their elements (a task's description,
shell command, agent type, server or tool; a cron's prompt or schedule) are
never read, never stored and never sent. `len()` is the only operation applied,
and a test asserts with an instrumented list that no element is accessed.

| Read | Derived | Transmitted |
|---|---|---|
| `cwd` | `projectName` = the folder's own name (last path segment) | yes |
| `cwd` | `projectId` = `p-` + sha256(case-folded, slash-normalised path)[:12] | yes |
| `session_id` | `taskId` = `s-` + sha256(session_id)[:16] | yes |
| `background_tasks` | one boolean: outstanding background work? | only as the `idle`/`completed` choice |
| `session_crons` | one boolean: outstanding scheduled work? | only as the `idle`/`completed` choice |
| `agent_id` | `subtaskId` = `t-` + sha256(session_id \| agent_id)[:16]; marks the event as a CHILD of `taskId` | yes (derived only) |
| `agent_type` | `agentType`, only if a short plain name (`Explore`, `security-reviewer`), only for subagents | yes |
| `cwd` itself | -- | **never** |
| `session_id` itself | -- | **never** |
| `agent_id` itself, `agent_transcript_path` | -- | **never** |
| any list element | -- | **never** |

`HookContext` -- the object handed to the event builder -- has no field that
could hold a path or a raw session id, so the builder cannot forward one. The
validator additionally refuses any `projectName` containing a path separator,
a drive prefix or a parent reference. `tests/test_hook_context.py` asserts all
of this against the actual request bytes, including that only `cwd` and
`session_id` are ever accessed on the payload dict.

Without a usable payload (missing, malformed, not a dict) the event is sent in
its original nine-field form and the receiver falls back to grouping by agent.

### Why this can only reach your LAN

| | |
|---|---|
| Destination | A literal **private IP** only (10.x, 172.16-31.x, 192.168.x, 127.x, link-local). A public IP is refused. |
| DNS | **Never happens.** Hostnames are refused, so no name resolution can redirect this off the LAN. |
| Proxies | **Disabled.** urllib's default opener honours `HTTP_PROXY`, which would hand the bearer token to whatever it names. |
| Redirects | **Refused.** A 302 could forward the Authorization header to another host. |
| Path | Must be `/events`. |
| Direction | Outbound only. No listener, no port, no inbound path of any kind. |
| Response | Read with a 2 KB cap and discarded. Never parsed, never executed. Status code only. |

### Timing and failure

One attempt, **2 second timeout, no retries**. Measured worst case is **2.21s**
including Python startup -- comfortably inside the hook's 5 second budget.

Every failure mode is a silent no-op that exits 0: bridge offline, bad token,
missing configuration, malformed endpoint. Claude Code is never blocked, never
shown a traceback, and never fails a turn because a notification did not arrive.

### Known behaviour: Stop fires per turn

`Stop` fires at the end of **every assistant turn**, not once per task, so a long
session produces many `completed` events. Left as-is for now by design; we will
decide on debounce or task semantics after observing real volume.

---

## Tests

No test framework to install — `unittest` ships with Python.

```powershell
python -m unittest discover -s tests -v
```

**132 tests, all passing, and not one of them touches the network.** Every
transport test injects a fake opener or patches `build_opener`; there is no test
server, no `localhost` listener and no external service. One test patches
`urllib.request.OpenerDirector.open` itself to prove the real code path is never
reached.

Coverage includes: all six event types; the validation rules at and over each
boundary; timestamp and event-id handling; endpoint validation (HTTPS accepted,
`http://` rejected, malformed URLs rejected, embedded credentials rejected);
missing-token rejection; the `Authorization` header; the exact JSON body and the
absence of machine data in it; the timeout; success, connection failure, timeout,
`401`/`403`, `4xx`, `5xx` and redirects; retry counts and backoff; the same
`eventId` across retries; the token being absent from every user-facing string;
`--send` selecting `HttpsNotifier`; `--dry-run` making no request; and the
default CLI still using `ConsoleNotifier` while importing no networking module
at all.

---

## Calling it from Claude or Codex

The integration is explicit: the agent simply runs a command. Nothing in either
extension is modified, read or intercepted, and no session or credential is
touched.

```powershell
C:\Users\mmarc\source\repos\AgentHubNotifier\agenthub-notifier.cmd completed --agent "Claude"
C:\Users\mmarc\source\repos\AgentHubNotifier\agenthub-notifier.cmd needs-approval --agent "Codex"
```

Add `--send` once a relay exists. Until then leave it off and the command is a
harmless local print.

From a Python script:

```python
from agenthub_notifier import build_event, validate_or_raise, ConsoleNotifier

event = validate_or_raise(build_event("completed", agent_name="My Script"))
ConsoleNotifier().notify(event)
```

---

## Remaining work before events reach the iPhone

The Windows side is done. What is missing is everything past the outbound
request, none of which belongs in this repository:

1. **A relay service.** Something on the public internet that accepts
   `POST /v1/events`, checks the bearer token, and forwards to Apple Push
   Notification service. It should de-duplicate on `eventId`.
2. **A real token**, generated by that relay and set in `AGENTHUB_AUTH_TOKEN` on
   this PC. Never committed.
3. **The AgentHub iPhone app**, registered for push notifications, handing its
   APNs device token to the relay.
4. **An Apple Developer account** with a push key, for APNs.
5. **One real end-to-end test**, which will be the first actual network request
   this project has ever made.

The security model does not change at any point: this PC makes outbound requests
and nothing else. No inbound ports, no server, no polling for commands, no remote
execution. The iPhone receives notifications; it never sends anything back here.

## Conversation capture (approved privacy-scope change, 2026-09-21)

Besides the status event, three hooks now also send ONE user-visible text field
to the same loopback relay, as a separate `ConversationMessage` record on
`POST /messages` (same token, same 127.0.0.1 listener, never through Tailscale):

| Hook (argument) | Payload key read | Becomes |
|---|---|---|
| `UserPromptSubmit` (`running`) | `prompt` (or the documented alias `user_input`) | `role: user` message; the FIRST one names the task (`title`) |
| `Stop` (`completed`, whether classified idle or completed) | `last_assistant_message` | `role: assistant` message on the task |
| `SubagentStop` (`subagent-stop`) | `last_assistant_message` | `role: assistant` message on the CHILD (`subtaskId`), never the parent |

Record: `{version:1, messageId, taskId, subtaskId?, role, text, timestamp, truncated?, title?}`.
`messageId` is a fresh random id minted once per hook invocation (Claude Code's
payload carries no per-invocation identifier; `prompt_id` names the turn and a
Stop can fire more than once per turn), reused by every delivery attempt of
that invocation. A retry is the same message; a separate invocation with
identical text is a separate turn. Nothing is deduplicated by text. Text above 20,000 characters is cut and
flagged `truncated: true`. The title is derived locally (no model): collapse
whitespace, drop leading conversational noise, take the first clause, drop
articles, cap at 8 words / 60 characters.

Still never read for this purpose and never transmitted: `transcript_path`,
`agent_transcript_path`, `tool_input`, `tool_output`, `tool_name`, commands,
environment data, hidden reasoning (not in any hook payload), raw `cwd`,
raw `session_id`, raw `agent_id`. Conversation text never enters a status
event and never enters a Web Push payload. See `tests/test_conversation.py`.
