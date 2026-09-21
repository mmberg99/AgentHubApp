import {
  parseConversationSummary,
  parseTaskConversation,
  type ConversationSummary,
  type TaskConversation,
} from '../../protocol';
import { RELAY_API_BASE } from '../notifications/pushConfig';
import { webPushNotificationService } from '../notifications/webPushNotificationService';

/**
 * Read-only client for the relay's conversation routes.
 *
 *   GET /api/conversations           titles + counts for every stored task
 *   GET /api/conversation/<taskId>   the full user-visible thread(s) of one task
 *
 * Both require the device's capability token (the one minted when Web Push
 * was enabled; the same token that guards /history). There is no write
 * method here and no write route on the relay's PWA listener: the phone can
 * only read what Windows recorded.
 *
 * Every response is validated field by field before it reaches state.
 */

async function authorizedGet(path: string): Promise<unknown | null> {
  const token = webPushNotificationService.capabilityToken();
  if (!token) return null;
  try {
    const response = await fetch(`${RELAY_API_BASE}${path}`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

export async function fetchConversationSummaries(): Promise<ConversationSummary[] | null> {
  const body = await authorizedGet('/conversations');
  if (typeof body !== 'object' || body === null) return null;
  const list = (body as { conversations?: unknown }).conversations;
  if (!Array.isArray(list)) return null;
  return list.map(parseConversationSummary).filter((s): s is ConversationSummary => s !== null);
}

export async function fetchTaskConversation(taskId: string): Promise<TaskConversation | null> {
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(taskId)) return null;
  const body = await authorizedGet(`/conversation/${encodeURIComponent(taskId)}`);
  if (typeof body !== 'object' || body === null) return null;
  return parseTaskConversation((body as { conversation?: unknown }).conversation);
}

/** True when this device can read conversations at all (push enabled). */
export function conversationsAvailable(): boolean {
  return webPushNotificationService.capabilityToken() !== null;
}
