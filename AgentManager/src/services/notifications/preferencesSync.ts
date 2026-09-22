import {
  loadNotificationPreferences,
  saveNotificationPreferences,
  type NotificationPreferences,
} from '../../lib/notificationPreferences';
import { RELAY_API_BASE } from './pushConfig';
import { webPushNotificationService } from './webPushNotificationService';

/**
 * Mirrors this device's notification preferences to the relay.
 *
 * Authenticated with the same per-device capability token that guards
 * /history and the conversation reads, so this is not a new trust boundary and
 * not an unauthenticated write: without that token the relay changes nothing.
 * The body is one boolean; it can only narrow what this device is sent.
 *
 * Best effort by design. If the relay is unreachable, or push was never
 * enabled on this device, the local choice stands and is re-sent the next time
 * Settings opens.
 */
export async function pushNotificationPreferences(
  preferences: NotificationPreferences,
): Promise<boolean> {
  const token = webPushNotificationService.capabilityToken();
  if (!token) return false;
  try {
    const response = await fetch(`${RELAY_API_BASE}/push/preferences`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        version: 1,
        subtaskCompletionPush: preferences.subtaskCompletionPush,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Saves locally, then mirrors. The local write never depends on the network. */
export async function setNotificationPreferences(
  preferences: NotificationPreferences,
): Promise<boolean> {
  saveNotificationPreferences(preferences);
  return pushNotificationPreferences(preferences);
}

/** Re-sends whatever is stored locally, so the relay cannot drift out of step. */
export async function resendNotificationPreferences(): Promise<boolean> {
  return pushNotificationPreferences(loadNotificationPreferences());
}
