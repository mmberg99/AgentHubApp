import type { Agent, AgentEvent, ApprovalRequest } from '../../types';
import { SNAPSHOT_VERSION, type PersistedSnapshot } from './types';

/**
 * DURABLE PERSISTENCE DESIGN
 *
 * Today the only adapter is session-only. This module is the part a durable
 * adapter needs and can be written now without any storage package: what is
 * allowed to be written to disk, and how an old snapshot is migrated.
 *
 * PERSISTED
 *   - remote agents and their status, task and session metadata
 *   - activity history (which carries `eventId`, so dedupe survives a restart)
 *   - `lastRemoteEventAt` per agent, so the out-of-order rule survives too
 *   - `taskId` / `currentTaskId`
 *   - unread state (it is user-facing and should not reset on relaunch)
 *
 * NEVER PERSISTED — enforced by rebuilding each record field by field below
 *   - bearer tokens, push tokens or any credential
 *   - push provider or relay secrets
 *   - raw rejected payloads (they are dropped at the boundary and never stored)
 *   - Windows hook inputs, prompts, command output
 *
 * Mock/demo records are also excluded: they are regenerated from source on
 * every launch, so writing them would pin stale timestamps to disk.
 */

/** Strips a persisted agent down to known fields only. */
function sanitizeAgent(agent: Agent): Agent {
  return {
    id: agent.id,
    name: agent.name,
    provider: agent.provider,
    account: agent.account,
    status: agent.status,
    currentTask: agent.currentTask,
    startedAt: agent.startedAt,
    lastUpdated: agent.lastUpdated,
    unread: agent.unread,
    avatar: agent.avatar,
    origin: agent.origin,
    currentTaskId: agent.currentTaskId ?? null,
    lastRemoteEventAt: agent.lastRemoteEventAt ?? null,
  };
}

function sanitizeEvent(event: AgentEvent): AgentEvent {
  return {
    id: event.id,
    agentId: event.agentId,
    type: event.type,
    message: event.message,
    timestamp: event.timestamp,
    requiresAction: event.requiresAction,
    read: event.read,
    origin: event.origin,
    ...(event.approvalId ? { approvalId: event.approvalId } : {}),
    ...(event.taskId ? { taskId: event.taskId } : {}),
    ...(event.stale ? { stale: true as const } : {}),
  };
}

/** Keeps history bounded so a long-running install cannot grow without limit. */
export const MAX_PERSISTED_EVENTS = 500;

/**
 * Builds the snapshot to write. Only externally-sourced records are kept;
 * mock data is rebuilt from source at launch.
 */
export function buildSnapshot(state: {
  agents: Agent[];
  events: AgentEvent[];
  approvals: ApprovalRequest[];
}): PersistedSnapshot {
  const agents = state.agents.filter((a) => a.origin === 'remote').map(sanitizeAgent);
  const keepIds = new Set(agents.map((a) => a.id));

  const events = state.events
    .filter((e) => e.origin === 'remote' && keepIds.has(e.agentId))
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, MAX_PERSISTED_EVENTS)
    .map(sanitizeEvent);

  return {
    version: SNAPSHOT_VERSION,
    savedAt: new Date().toISOString(),
    agents,
    events,
    // Approvals are local-only today and never arrive from a transport, so
    // there is nothing remote to persist.
    approvals: [],
  };
}

/**
 * Migrates a snapshot read from storage.
 *
 * Returning null means "discard and start clean" — always a safe outcome,
 * because remote history is a convenience, not a source of truth. A future
 * version bump adds a case here instead of risking corrupt state.
 */
export function migrateSnapshot(raw: unknown): PersistedSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const candidate = raw as Partial<PersistedSnapshot>;

  if (candidate.version !== SNAPSHOT_VERSION) {
    // No older versions exist yet. When v2 arrives, translate v1 here.
    return null;
  }

  if (!Array.isArray(candidate.agents) || !Array.isArray(candidate.events)) return null;

  return {
    version: SNAPSHOT_VERSION,
    savedAt: typeof candidate.savedAt === 'string' ? candidate.savedAt : new Date().toISOString(),
    agents: candidate.agents.map(sanitizeAgent),
    events: candidate.events.map(sanitizeEvent),
    approvals: [],
  };
}
