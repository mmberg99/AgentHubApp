import type { AgentEventType as DomainEventType, AgentStatus, ProviderId } from '../types';
import { ACTIONABLE_EVENT_TYPES, type AgentEventProvider, type AgentEventType } from './agentEvent';

/** Wire event type -> the agent status the app should display. */
export function mapStatus(type: AgentEventType): AgentStatus {
  switch (type) {
    case 'started':
    case 'running':
      return 'running';
    case 'idle':
      return 'idle';
    case 'completed':
      return 'completed';
    case 'needs_approval':
      return 'needs_approval';
    case 'needs_input':
      return 'needs_input';
    case 'failed':
      return 'failed';
  }
}

/** Wire event type -> the app's internal, activity-shaped event type. */
export function mapDomainEventType(type: AgentEventType): DomainEventType {
  switch (type) {
    case 'started':
      return 'started';
    case 'running':
      return 'progress';
    case 'idle':
      return 'idle';
    case 'completed':
      return 'completed';
    case 'needs_approval':
      return 'approval_request';
    case 'needs_input':
      return 'input_request';
    case 'failed':
      return 'failed';
  }
}

/**
 * Wire provider -> internal provider id.
 *
 * "claude" is the vendor-facing name; internally the adapter is `anthropic`.
 * An absent provider is treated as a self-hosted/custom agent.
 */
export function mapProvider(provider?: AgentEventProvider): ProviderId {
  switch (provider) {
    case 'claude':
      return 'anthropic';
    case 'openai':
      return 'openai';
    case 'custom':
    case undefined:
    default:
      return 'custom';
  }
}

export function requiresUserAction(type: AgentEventType): boolean {
  return ACTIONABLE_EVENT_TYPES.includes(type);
}

/** Two-letter avatar initials derived from the agent name. */
export function initialsFor(agentName: string): string {
  const words = agentName.split(/\s+/).filter(Boolean);
  if (words.length === 0) return '??';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}
