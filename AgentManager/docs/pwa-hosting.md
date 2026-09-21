# AgentHub PWA — build, transfer and hosting

Phase 1 output: a self-contained static web app that can be hosted from Windows
with the Mac powered off.

## Build on the Mac

```bash
npm run build:web      # expo export --platform web  +  PWA post-processing
npm run package:pwa    # scans the build, then zips it
```

- Output directory: `dist/`
- Transferable archive: `build/AgentHub-PWA.zip`

`package:pwa` refuses to produce an archive if it finds a bearer token, a
private LAN address, or a Mac home-directory path in the build.

> Note: `npx expo export --platform ios` writes to the same `dist/` directory.
> If you run a native export, re-run `npm run build:web` before packaging.

## Hosting requirements on Windows

The archive's root **is** the web root — `index.html` sits at the top level.
Unzip it and serve that folder.

Three requirements, all of which will silently break the PWA if missed:

1. **HTTPS.** Service workers and Web Push require a secure context. Plain
   `http://` over the LAN will load the UI but **cannot register the service
   worker**, so the app will not be properly installable and push will never
   work. The only exception is `localhost`, which does not help a phone.

2. **Correct MIME types.**
   | Extension | Must be served as |
   |---|---|
   | `.js` | `application/javascript` (or `text/javascript`) |
   | `.webmanifest` | `application/manifest+json` |
   | `.png` | `image/png` |
   | `.ttf` | `font/ttf` |

   If `sw.js` is served as `text/plain`, registration fails with a MIME error.
   IIS in particular does not know `.webmanifest` by default and must be told.

3. **`sw.js` served from the site root.** The worker is registered with scope
   `/`, so it must be reachable at `https://<host>/sw.js`. Serving the app from
   a subdirectory breaks the scope.

Single-page routing: the app is an SPA export. Unknown paths should fall back to
`/index.html` so a deep link such as `/agent/win_claude_code` works after a
refresh.

## Origin stability

The build is origin-independent — no hostname is compiled in. But once installed
to the Home Screen, **the origin is the app's identity**. Changing host or port
orphans the installed icon, the service worker and (later) the push
subscription. Choose the hostname before installing on the phone.

## Local development is unaffected

The Mac LAN bridge still works exactly as before. `DEFAULT_BRIDGE_CONFIG` points
at `http://127.0.0.1:8787`, which is correct on the Mac and simply unreachable
from the hosted PWA — the transport reports "Local bridge unavailable" and backs
off. Nothing crashes, and simulated events keep working.

## Where Web Push arrives next (phase 2)

Not implemented. The extension points are already marked:

- `public/sw.js` — `push` and `notificationclick` listeners, plus
  `client.postMessage()` to forward the raw payload to an open page.
- New `src/services/notifications/webPushNotificationService.ts` implementing
  the existing `NotificationService` interface, emitting with source `'push'`.

The chain after that is unchanged and must stay that way:

```
service worker -> WebPushNotificationService -> NotificationBridge
  -> parseAgentNotificationEvent -> ingestRemoteEvent -> existing UI
```

Push events keep using `AgentNotificationEvent`. There is no second schema.
