#!/usr/bin/env node
/**
 * Generates the one VAPID keypair this relay will ever need.
 *
 * The PRIVATE key is written only to %LOCALAPPDATA%\AgentHub\relay\vapid.json
 * with an owner-only ACL. It is never printed, never returned by an API, never
 * placed in the repository and never bundled into the PWA.
 *
 * The PUBLIC key IS printed: it has to be, because it must be copied into
 * AgentManager's app.json so the browser can pass it to PushManager.subscribe.
 * A VAPID public key is sent to the push service on every subscription — it is
 * public by design and safe in a JS bundle.
 *
 * Refuses to overwrite an existing keypair. Replacing it would silently
 * invalidate every registered subscription.
 */

import { existsSync } from 'node:fs';
import webpush from 'web-push';

import { VAPID_FILE } from '../src/config.mjs';
import { ensureStateDir, loadVapid, restrictToOwner, saveVapid } from '../src/storage.mjs';

/**
 * VAPID `sub` claim: who to contact about this sender.
 *
 * Apple's push service VALIDATES this and rejects the JWT with
 * {"reason":"BadJwtToken"} (HTTP 403) if it is not a usable mailto: or https:
 * URI. `mailto:agenthub@localhost` looks reasonable but has no real domain and
 * is refused -- this cost a debugging round, so the default is now a URI Apple
 * accepts. Override with AGENTHUB_VAPID_SUBJECT if the host name changes.
 */
const subject =
  process.env.AGENTHUB_VAPID_SUBJECT ?? 'https://desktop-53fofnm.tail36803b.ts.net/';

if (existsSync(VAPID_FILE) && loadVapid()) {
  const existing = loadVapid();
  console.log('[vapid] a keypair already exists; refusing to overwrite it.');
  console.log(`[vapid] file: ${VAPID_FILE}`);
  console.log('');
  console.log('[vapid] public key (safe to publish, copy into app.json):');
  console.log(existing.publicKey);
  process.exit(0);
}

ensureStateDir();

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
saveVapid({ publicKey, privateKey, subject });

const locked = restrictToOwner(VAPID_FILE);

console.log(`[vapid] keypair written to ${VAPID_FILE}`);
console.log(`[vapid] owner-only ACL applied: ${locked ? 'yes' : 'NO - tighten manually'}`);
console.log(`[vapid] subject: ${subject}`);
console.log('');
console.log('[vapid] PRIVATE key: stays on this machine. Not printed, not bundled.');
console.log('[vapid] public key (safe to publish, copy into AgentManager/app.json):');
console.log('');
console.log(publicKey);
console.log('');
