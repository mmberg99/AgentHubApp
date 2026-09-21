/**
 * Web Push build-time configuration.
 *
 * WHY A SOURCE CONSTANT RATHER THAN app.json `extra`
 *   `Constants.expoConfig.extra` is not embedded into a static web export
 *   (`web.output: "single"`): the value is simply absent from the bundle at
 *   runtime, which silently disables subscription. Verified by scanning the
 *   built output — the key appeared in no file. A plain exported constant is
 *   inlined by the bundler, is greppable, and has exactly one source of truth.
 *
 * WHAT IS SAFE TO PUT HERE
 *   The VAPID PUBLIC key only. A VAPID public key is transmitted to the push
 *   service on every subscription and is public by design, so shipping it in a
 *   JS bundle is correct and expected.
 *
 *   The VAPID PRIVATE key lives only in
 *   %LOCALAPPDATA%\AgentHub\relay\vapid.json on the Windows host. It must never
 *   appear in this file, this bundle, or this repository. `package:pwa` scans
 *   every build and refuses to produce an archive if it ever does.
 *
 *   The relay's history capability token is NOT here either: it is minted per
 *   device at registration time and stored in that device's localStorage.
 */

/**
 * Generated once by `npm run generate-vapid` in AgentHubRelay.
 *
 * Replacing this value invalidates every existing subscription, so it changes
 * only if the relay's keypair is regenerated.
 */
export const VAPID_PUBLIC_KEY =
  'BLD38laD8uLQ59ByoESJG2C9GYSXPErRfKe0rV1etHA_9K4UucSrLgs_rwEdW3ZTbp62JWr6izJZ__17fWnURtc';

/**
 * Origin-relative, deliberately. The PWA must run unchanged from whatever host
 * serves it, so no hostname is ever compiled in. Tailscale Serve maps this
 * prefix to the relay's PWA-facing listener on 127.0.0.1.
 */
export const RELAY_API_BASE = '/api';
