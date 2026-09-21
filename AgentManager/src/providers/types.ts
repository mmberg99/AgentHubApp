import type { Agent, AgentEvent, ApprovalRequest, ProviderId } from '../types';

/**
 * The contract every real provider integration will implement.
 *
 * Nothing in the UI imports a concrete adapter; screens go through the store,
 * and the store will eventually go through this interface. Today every adapter
 * is a stub that throws, which keeps the seam honest: if a screen ever tries to
 * reach a provider during the prototype, it fails loudly instead of silently
 * pretending to be connected.
 */
export interface ProviderAdapter {
  id: ProviderId;
  displayName: string;
  /** False until a real integration exists. Surfaced in Settings. */
  connected: boolean;

  listAgents(): Promise<Agent[]>;
  fetchEvents(agentId: string, since?: string): Promise<AgentEvent[]>;
  sendMessage(agentId: string, message: string): Promise<AgentEvent>;
  resolveApproval(request: ApprovalRequest, approved: boolean): Promise<ApprovalRequest>;
}

export class NotImplementedError extends Error {
  constructor(provider: ProviderId, method: string) {
    super(
      `${provider}.${method}() is not implemented. AgentHub is running on local ` +
        `mock data; no provider integration exists yet.`,
    );
    this.name = 'NotImplementedError';
  }
}

/** Builds a stub adapter so each provider file stays a one-liner for now. */
export function createStubAdapter(
  id: ProviderId,
  displayName: string,
): ProviderAdapter {
  return {
    id,
    displayName,
    connected: false,
    listAgents: () => Promise.reject(new NotImplementedError(id, 'listAgents')),
    fetchEvents: () => Promise.reject(new NotImplementedError(id, 'fetchEvents')),
    sendMessage: () => Promise.reject(new NotImplementedError(id, 'sendMessage')),
    resolveApproval: () => Promise.reject(new NotImplementedError(id, 'resolveApproval')),
  };
}
