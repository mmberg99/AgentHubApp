import { createStubAdapter, type ProviderAdapter } from './types';

/**
 * OpenAI adapter placeholder.
 *
 * A real implementation would map Assistants/Responses runs onto the neutral
 * Agent + AgentEvent models. It must never leak OpenAI-shaped objects upward.
 */
export const openaiAdapter: ProviderAdapter = createStubAdapter('openai', 'OpenAI');
