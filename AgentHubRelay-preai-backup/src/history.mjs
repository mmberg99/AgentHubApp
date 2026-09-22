/**
 * In-memory event history for missed-event replay.
 *
 * Push alone cannot populate Activity: when the PWA is fully closed the service
 * worker can show a notification, but no React app exists to ingest into. So
 * the relay keeps the recent events and the app pulls what it missed on launch.
 *
 * Memory only, never written to disk — notification content is exactly the kind
 * of thing that should not accumulate in a file. A relay restart simply starts
 * a new instance, which the client detects and resyncs against.
 *
 * The cursor/instanceId semantics are deliberately identical to the Mac
 * development bridge (`AgentManager/bridge/server.mjs`), so the already-proven
 * client logic in `localBridgeNotificationService` carries over unchanged:
 *
 *   - `cursor` is a monotonic sequence number, not an index.
 *   - `instanceId` changes when the relay restarts, which tells a client its
 *     cursor belongs to a previous process and it should resync from 0.
 *   - Replay is safe: AgentHub dedupes on `remote_<eventId>`, so an event
 *     delivered by push AND returned by history is applied exactly once.
 */

import { randomUUID } from 'node:crypto';

import { MAX_HISTORY, MAX_SEEN_IDS } from './config.mjs';

export class EventHistory {
  constructor({ max = MAX_HISTORY, maxSeen = MAX_SEEN_IDS } = {}) {
    this.instanceId = randomUUID();
    this.max = max;
    this.maxSeen = maxSeen;
    this.sequence = 0;
    /** @type {{seq:number, event:object}[]} oldest first */
    this.entries = [];
    /** Insertion-ordered set of recently seen event ids. */
    this.seen = new Set();
    /**
     * Last recorded event type per task, for the "one push per completion
     * transition" guard. Keyed like the app groups tasks: taskId when the
     * sender supplied one, else the agent. Bounded, insertion-ordered.
     */
    this.lastTypeByTask = new Map();
  }

  /**
   * The key an event's lifecycle is tracked under; mirrors the app's identity.
   * A subtask (subagent) has its own key, so its repeated completions are
   * guarded independently and never touch the parent task's guard.
   */
  static taskKey(event) {
    if (typeof event.subtaskId === 'string' && event.subtaskId.length > 0) {
      return `subtask:${event.subtaskId}`;
    }
    return event.taskId ?? `agent:${event.agentId}`;
  }

  /** Type of the previous event recorded for this event's task, or null. */
  previousTypeFor(event) {
    return this.lastTypeByTask.get(EventHistory.taskKey(event)) ?? null;
  }

  /**
   * Append a validated event.
   *
   * Returns false when the eventId was already recorded. Suppressing duplicates
   * here keeps a retrying notifier from pushing the same notification twice;
   * the app's own dedupe is the authoritative one and stays in place.
   */
  add(event) {
    if (this.seen.has(event.eventId)) return false;

    this.seen.add(event.eventId);
    if (this.seen.size > this.maxSeen) {
      // Sets iterate in insertion order, so this drops the oldest id.
      this.seen.delete(this.seen.values().next().value);
    }

    this.sequence += 1;
    this.entries.push({ seq: this.sequence, event });
    if (this.entries.length > this.max) {
      this.entries.splice(0, this.entries.length - this.max);
    }

    const key = EventHistory.taskKey(event);
    this.lastTypeByTask.delete(key); // re-insert so the newest is last
    this.lastTypeByTask.set(key, event.type);
    if (this.lastTypeByTask.size > this.maxSeen) {
      this.lastTypeByTask.delete(this.lastTypeByTask.keys().next().value);
    }
    return true;
  }

  /**
   * Events newer than `since`.
   *
   * A `since` from a previous relay instance may be far ahead of this one's
   * sequence; the client detects that through `instanceId` and retries from 0,
   * so no special case is needed here.
   */
  since(cursor) {
    const from = Number.isFinite(cursor) && cursor >= 0 ? cursor : 0;
    return {
      instanceId: this.instanceId,
      cursor: this.sequence,
      events: this.entries.filter((entry) => entry.seq > from).map((entry) => entry.event),
    };
  }
}
