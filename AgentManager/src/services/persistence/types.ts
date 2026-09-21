import type { Agent, AgentEvent, ApprovalRequest } from '../../types';

/**
 * Persistence seam for agent state.
 *
 * Nothing here touches a browser API. The target is a React Native iPhone app,
 * so a durable implementation will be backed by native storage (e.g.
 * `expo-sqlite`, `@react-native-async-storage/async-storage`, or the file
 * system) — never `localStorage`.
 *
 * Today the only implementation is session-only. It exists so that adding a
 * durable adapter later is a one-line swap in `AgentStoreProvider`, with no
 * change to the reducer, the protocol, or any screen.
 */

export interface PersistedSnapshot {
  /** Bumped when the snapshot shape changes so old data can be discarded. */
  version: 1;
  savedAt: string;
  agents: Agent[];
  events: AgentEvent[];
  approvals: ApprovalRequest[];
}

export const SNAPSHOT_VERSION = 1 as const;

export interface PersistenceAdapter {
  readonly id: string;
  /**
   * False when data is lost on app reload. Surfaced in Settings so the UI never
   * implies history is durable when it is not.
   */
  readonly durable: boolean;

  load(): Promise<PersistedSnapshot | null>;
  save(snapshot: PersistedSnapshot): Promise<void>;
  clear(): Promise<void>;
}
