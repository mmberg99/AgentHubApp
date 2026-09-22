/**
 * Per-device notification preferences.
 *
 * WHERE THE DECISION HAPPENS. The push decision is made on Windows, by the
 * relay, because a service worker that receives a push must show a
 * notification: the `userVisibleOnly` subscription contract means the phone
 * cannot silently drop one without the browser showing a generic "site updated
 * in the background" notice instead. So the preference is chosen here, stored
 * here for the UI, and mirrored to the relay over the existing authenticated
 * `/api` route, where it filters that one device's deliveries.
 *
 * This copy is the source of truth for what the toggle shows. The relay's copy
 * is the source of truth for what is delivered. They are kept in step by
 * `preferencesSync`, and a failure to reach the relay never loses the local
 * choice: it is re-sent the next time Settings opens.
 */

export interface NotificationPreferences {
  /** Push when a subagent finishes. Main-task and needs-action pushes are unaffected. */
  subtaskCompletionPush: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  subtaskCompletionPush: true,
};

export const NOTIFICATION_PREFERENCES_KEY = 'agenthub.push.preferences.v1';

/** Rebuilds preferences from known keys only; anything else is discarded. */
export function sanitizeNotificationPreferences(value: unknown): NotificationPreferences {
  const out: NotificationPreferences = { ...DEFAULT_NOTIFICATION_PREFERENCES };
  if (typeof value !== 'object' || value === null) return out;
  const raw = value as Record<string, unknown>;
  if (typeof raw.subtaskCompletionPush === 'boolean') {
    out.subtaskCompletionPush = raw.subtaskCompletionPush;
  }
  return out;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Never throws: a blocked or empty store reads as the defaults (everything on). */
export function loadNotificationPreferences(): NotificationPreferences {
  const store = storage();
  if (!store) return { ...DEFAULT_NOTIFICATION_PREFERENCES };
  try {
    const raw = store.getItem(NOTIFICATION_PREFERENCES_KEY);
    if (!raw) return { ...DEFAULT_NOTIFICATION_PREFERENCES };
    return sanitizeNotificationPreferences(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_NOTIFICATION_PREFERENCES };
  }
}

export function saveNotificationPreferences(preferences: NotificationPreferences): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(
      NOTIFICATION_PREFERENCES_KEY,
      JSON.stringify(sanitizeNotificationPreferences(preferences)),
    );
  } catch {
    /* quota or private mode; the in-memory choice still applies this session */
  }
}
