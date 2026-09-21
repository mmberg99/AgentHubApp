# AgentHub push architecture — design (nothing implemented)

Preparation only. No push package is installed, no relay exists, no Apple or
Expo account has been used. This document is the contract the next phase builds
against.

## 1. Target path

```
Windows notifier
  --HTTPS POST /events (Bearer sender credential)-->  relay
  --push (Expo Push Service or direct APNs)-------->  iPhone
  --> ExpoPushNotificationService
  --> NotificationBridge
  --> parseAgentNotificationEvent   <-- trust boundary, unchanged
  --> ingestRemoteEvent
  --> existing UI
```

The local Mac bridge stays exactly as it is, for development. Both transports
carry **the same `AgentNotificationEvent`**; there is no push-specific schema.
Home, Agents, Activity and Agent Detail contain no transport-specific code and
need no changes.

## 2. Push payload contract

Typed in [`src/services/notifications/pushPayload.ts`](../src/services/notifications/pushPayload.ts).

```json
{
  "to": "<device push token, held only by the relay>",
  "title": "Claude Code",
  "body": "Task completed",
  "sound": "default",
  "priority": "high",
  "data": {
    "agentEvent": {
      "version": 1,
      "eventId": "9f2c...",
      "agentId": "win_claude_code_agenthub",
      "agentName": "Claude Code",
      "type": "completed",
      "title": "Claude Code finished a task",
      "message": "The task completed successfully on your Windows PC.",
      "timestamp": "2026-09-20T12:00:00.000Z",
      "taskId": "task-42",
      "provider": "claude"
    }
  }
}
```

Rules:

- **`data.agentEvent` is the only source of app state.** The app reads it at
  `notification.request.content.data`, extracts it with
  `extractAgentEventPayload()`, and passes it to the existing validator. A
  tampered `title`/`body` changes what the banner looks like and nothing else.
- **`title`/`body` are display-only and policy-derived.** The relay MUST build
  them with `toLockScreenNotification(event)` and MUST NOT copy `event.title`
  or `event.message` into them.
- **4096 bytes total**, per Expo's documented limit, `data` included. Protocol
  field caps keep a well-formed message near ~800 bytes. Check with
  `isWithinPayloadLimit()` before sending; over-limit yields `MessageTooBig`.
- The relay MUST run the same validation (which also redacts) before sending,
  so a bad payload is rejected at the relay *and* at the app.

## 3. Lock-screen privacy policy

Implemented in [`notificationPolicy.ts`](../src/services/notifications/notificationPolicy.ts).

A notification body is one of six fixed strings — never free text:

| Event type | Body |
|---|---|
| `started` | Task started |
| `running` | Working on a task |
| `completed` | Task completed |
| `needs_approval` | Needs your approval |
| `needs_input` | Needs your input |
| `failed` | Task failed |

The title is the agent name, capped at 40 characters. So a lock screen shows
**"Claude Code" / "Task completed"** and nothing more.

`event.message` is deliberately excluded from the lock screen even though it is
validated and redacted, because it is free text from a notifier we do not
control. It keeps appearing in Activity, where the device is unlocked — no
existing detail is lost.

Never in a payload: source code, prompts, filenames, filesystem paths,
terminal output, model responses, error strings, API keys, account names,
repository or customer secrets. The validator redacts Windows/POSIX paths,
`sk-`/`pk-` keys, inline bearer tokens and 40+ character blobs as a backstop,
not as permission to send them.

## 4. Foreground / background / closed behaviour

Nothing below works yet; all of it depends on `expo-notifications`.

| Case | iOS shows a banner? | When the app ingests | Activity updates | Duplicate prevention |
|---|---|---|---|---|
| **A. Foreground** | Only if `setNotificationHandler` says so. Recommended: no banner, since the UI is already visible | Immediately, via `addNotificationReceivedListener` | Immediately | `eventId` dedupe in the store |
| **B. Background** | Yes | On next foreground, or at tap time | On resume | Same |
| **C. Fully closed** | Yes, iOS displays it without waking the app | On next launch — **only if the notification is tapped**, via `getLastNotificationResponseAsync()` | On launch | Same |
| **D. Tapped from lock screen** | Already shown | At launch/resume through the response listener | Immediately after launch | Same |

Two consequences worth stating plainly:

- **Case C is lossy for state.** An untapped notification is seen by the user
  but never reaches the app, so Activity will not contain it. Closing that gap
  needs either a durable relay queue the app drains on launch (recommended) or
  background push with a fetch handler. The relay API below keeps `GET /events`
  available for exactly this.
- **A foreground receipt and a later tap are two deliveries of one event.** The
  existing `eventId` dedupe already makes that harmless — it is the reason no
  new dedupe logic is needed.

## 5. Device registration design

Four identities, kept separate:

| Concept | Who holds it | Never held by |
|---|---|---|
| **Device identity** — an opaque relay-issued `deviceId` | app + relay | Windows |
| **Push token** — APNs/Expo token | relay only | Windows, the notifier, any log |
| **Windows sender credential** — bearer for `POST /events` | Windows only | the app |
| **Relay admin credential** | operator only | the app, Windows |

Pairing flow (no admin password in the app, no open registration endpoint):

1. Operator runs a relay command that mints a **short-lived pairing code**
   (6–8 characters, single use, ~10 minute TTL).
2. The app obtains its push token, then the user types that code into Settings.
3. App calls `POST /devices` with `{ pairingCode, pushToken, platform }`.
4. Relay verifies the code, stores `{ deviceId, pushToken }`, burns the code,
   and returns `{ deviceId, deviceSecret }`. The app keeps `deviceSecret` in
   the iOS keychain and uses it to update or revoke its own registration only.
5. Windows never learns the push token. It posts events; the relay fans out.

The endpoint is therefore never publicly writable: registration requires a
secret that exists for ten minutes and works once.

## 6. Relay API contract

Minimum surface. No command ever travels toward Windows; there is no shell, no
filesystem access, and no arbitrary payload forwarding.

### `POST /events` — Windows notifier → relay

```
Authorization: Bearer <windows sender credential>
Content-Type: application/json
Body: one AgentNotificationEvent
```

The relay must: reject unauthenticated requests (401); cap the body (8 KB) and
reject larger (413); reject malformed JSON (400); validate the event against
the protocol and reject failures (422) without echoing the payload; dedupe by
`eventId`; look up registered devices; derive `title`/`body` via the lock-screen
policy; send the push; return a small result.

```
202 { "ok": true, "delivered": 1 }
```

### `POST /devices` — app → relay (pairing, section 5)

### `GET /events?since=<cursor>` — app → relay

```
Authorization: Bearer <deviceSecret>
200 { "ok": true, "instanceId": "...", "cursor": 42, "events": [ ... ] }
```

Same shape the local bridge already serves, so the app can reuse the polling
logic. This is what closes the case-C gap: on launch the app drains anything it
missed. Retention should be short (hours) and bounded.

### `DELETE /devices/<deviceId>` — app revokes its own registration

Relay stores: device ids, push tokens, a bounded recent-event queue. It must
**not** store prompts, source code, command output, or Apple/Windows
credentials beyond the APNs signing key it needs.

## 7. Durable history design

Implemented as a design in
[`snapshotSchema.ts`](../src/services/persistence/snapshotSchema.ts); still
session-only at runtime.

Persisted: remote agents (status, task, session metadata), activity history
including `eventId` (so dedupe survives a restart), `lastRemoteEventAt` (so the
out-of-order rule survives), `taskId`/`currentTaskId`, and unread state.

Not persisted: bearer or push tokens, provider secrets, raw rejected payloads,
hook inputs, Windows credentials. Enforced structurally — `buildSnapshot()`
rebuilds every record field by field, so a new field is opt-in rather than
leaking by default. History is capped at 500 events.

Mock/demo records are excluded and regenerated at launch; `hydrate` merges
persisted remote records onto fresh mock data, so the demo never goes stale and
`Reset demo data` keeps working.

Migration: `migrateSnapshot()` checks `version` and returns `null` for anything
unrecognised, which simply starts clean. Remote history is a convenience, not a
source of truth, so discarding is always safe. A future v2 adds a translation
case rather than risking corrupt state.

A durable adapter implements the same three methods (`load`/`save`/`clear`) with
`durable: true`; `AgentStoreProvider` takes it as a prop. No reducer, protocol
or screen change.
