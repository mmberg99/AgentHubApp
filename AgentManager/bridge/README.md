# AgentHub local bridge

Local development only. Receives agent events from the Windows notifier on your
trusted home network and queues them in memory for AgentHub to read.

```
Windows notifier --POST /events (bearer token, LAN)--> bridge --GET /events (loopback)--> AgentHub
```

One-way by design. There is no route that sends anything back toward Windows,
and nothing here executes, spawns or reads files based on event contents.

No dependencies — Node 18 built-ins only.

## 1. Start the bridge on the Mac

Generate a token once and keep it somewhere safe:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Then, from the project root:

```bash
export AGENTHUB_BRIDGE_TOKEN="<the token you generated>"
node bridge/server.mjs
```

The bridge refuses to start if the token is missing or shorter than 16
characters, and never logs or echoes it. To use a different port:
`export AGENTHUB_BRIDGE_PORT=8787`.

## 2. Find the Mac's LAN IP

```bash
ipconfig getifaddr en0   # Wi-Fi
ipconfig getifaddr en1   # wired, if en0 is empty
```

Use that address on Windows. The app itself uses `127.0.0.1` and does not need it.

## 3. Send a test event

From the Mac (proves the bridge works before involving Windows):

```bash
AGENTHUB_BRIDGE_TOKEN="<token>" node bridge/send-test-event.mjs completed
```

From Windows PowerShell, substituting the Mac's LAN IP:

```powershell
$token = "<token>"
$body = @{
  version   = 1
  eventId   = [guid]::NewGuid().ToString()
  agentId   = "win_claude_code"
  agentName = "Claude Code"
  type      = "completed"
  title     = "Claude Code finished a task"
  message   = "The task completed successfully on your Windows PC."
  timestamp = (Get-Date).ToUniversalTime().ToString("o")
  provider  = "claude"
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "http://<MAC-LAN-IP>:8787/events" `
  -Headers @{ Authorization = "Bearer $token" } `
  -ContentType "application/json" -Body $body
```

`202` means accepted. Valid `type` values: `started`, `running`, `completed`,
`needs_approval`, `needs_input`, `failed`.

## Endpoints

| Route | Who | Auth | Notes |
|---|---|---|---|
| `POST /events` | Windows notifier | **Bearer token required** | Accepts one `AgentNotificationEvent` |
| `GET /events?since=N` | AgentHub | none | **Loopback only** — 403 from the LAN |
| `GET /health` | you | none | **Loopback only** — queue depth and counters |

## Limits

- Request body capped at 8 KB; larger uploads get `413`.
- Queue holds the newest 200 events; older ones are dropped.
- The last 1000 event ids are remembered to suppress duplicates.
- Memory only. Restarting the bridge discards everything.

## What must never be sent

Payloads carry status text only. Never put source code, prompts, file contents,
file paths, customer data, passwords, tokens or API keys in `title` or
`message` — they are displayed verbatim and will appear on a lock screen once
push notifications exist.

The app caps field lengths and discards unknown fields, but it cannot retract a
secret that was sent.

## Reliability boundaries

Read this before relying on the bridge for anything important. There is no
database and no disk persistence yet, so the guarantees are narrow.

| Scenario | What happens |
|---|---|
| **A.** Windows posts while AgentHub is open | **Delivered.** Queued, then collected on the next poll (within ~5s) and shown in the UI. |
| **B.** Windows posts while AgentHub is closed or not polling, bridge still running | **Held, then delivered.** The event waits in the bridge's memory queue (newest 200). When AgentHub reopens it polls from cursor 0 and receives everything still queued. |
| **C.** Windows posts while the bridge is stopped | **LOST.** Nothing is listening on the port; the POST fails at the Windows end. The bridge cannot backfill, and AgentHub never learns the event existed. The Windows notifier must treat a failed POST as a real failure. |
| **D.** The Mac reboots | **LOST.** The queue is memory-only and the bridge does not auto-start (by design — no launch agent). Everything queued is gone and nothing is received until you start it again manually. |

Also true today:

- **AgentHub history is session-only.** Reloading the app clears agents and
  events back to the mock data. Because the app advances a cursor as it polls,
  already-consumed events are *not* replayed after a reload.
- **Nothing is delivered while the Mac is off**, regardless of bridge state.
  Real iPhone push is what eventually removes this dependency; until then the
  Mac must be awake and the bridge running.

**Bridge restart:** each bridge process reports an `instanceId`, and its
sequence numbers restart from 0. AgentHub notices the id change and resyncs from
the beginning of the new queue rather than skipping events, and the store
deduplicates by `eventId` so a replay cannot create duplicate rows.

Case B is the only buffering that exists. Cases C and D are genuine data loss,
not delayed delivery — the UI says as much in Settings rather than implying
history is durable.

## Security notes

- Do not port-forward this or expose it to the internet.
- The token authenticates Windows to the bridge only. It is **not** in the
  React Native bundle; the app reads over loopback without it.
- The bridge binds `0.0.0.0` so the LAN can reach the ingest route. Read routes
  are restricted to loopback regardless.
- macOS may prompt to allow incoming connections the first time. Allow it for
  your private network only.
