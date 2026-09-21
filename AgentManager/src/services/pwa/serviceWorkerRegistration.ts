import { Platform } from 'react-native';

/**
 * Service worker registration — web only.
 *
 * Registering the worker is what makes AgentHub installable to the iOS Home
 * Screen, and it is where Web Push will live in a later phase.
 *
 * Guarantees:
 *   - Native builds are unaffected: it returns immediately on iOS/Android.
 *   - It never throws. A failed registration is reported, not propagated, so a
 *     browser without service workers (or an insecure origin) degrades to a
 *     plain web app instead of a blank screen.
 *   - It requests NO permissions and shows NO prompts. Notification permission
 *     must come from an explicit user gesture in a later phase, per WebKit's
 *     requirement.
 */

export type ServiceWorkerState =
  | 'native'            // running in the React Native app; not applicable
  | 'unsupported'       // browser has no service worker support
  | 'insecure-context'  // not HTTPS (and not localhost), so registration is impossible
  | 'registered'
  | 'failed';

export interface ServiceWorkerStatus {
  state: ServiceWorkerState;
  /** Populated when state is 'failed'. */
  error: string | null;
  scope: string | null;
}

const NATIVE_STATUS: ServiceWorkerStatus = { state: 'native', error: null, scope: null };

let status: ServiceWorkerStatus = NATIVE_STATUS;

export function getServiceWorkerStatus(): ServiceWorkerStatus {
  return status;
}

/**
 * Resolves the active registration, or null when service workers are not
 * usable here (native build, unsupported browser, insecure origin).
 *
 * Exists because Web Push subscription needs the registration object itself —
 * `registration.pushManager` — which `registerServiceWorker` does not return.
 * It waits on `navigator.serviceWorker.ready` rather than re-registering, so
 * calling it never creates a second worker.
 *
 * Never throws: every caller is UI code that must degrade, not crash.
 */
export async function getServiceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (Platform.OS !== 'web') return null;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;

  try {
    return await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
}

/**
 * Registers `/sw.js` at the site root.
 *
 * The path is deliberately absolute and origin-relative: the build must run
 * unchanged from whatever host serves it, so no hostname is ever baked in.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerStatus> {
  if (Platform.OS !== 'web') {
    status = NATIVE_STATUS;
    return status;
  }

  // `navigator` is absent during static rendering in Node.
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    status = { state: 'unsupported', error: null, scope: null };
    return status;
  }

  // Service workers require a secure context. Loopback counts as secure, which
  // is what makes local testing possible without a certificate.
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    status = {
      state: 'insecure-context',
      error: 'Service workers require HTTPS (or localhost).',
      scope: null,
    };
    return status;
  }

  try {
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    status = { state: 'registered', error: null, scope: registration.scope };
  } catch (error) {
    status = {
      state: 'failed',
      error: error instanceof Error ? error.message : 'registration failed',
      scope: null,
    };
  }

  return status;
}
