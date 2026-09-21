import { createStubAdapter, type ProviderAdapter } from './types';

/**
 * Anthropic adapter placeholder.
 *
 * A real implementation would translate tool-use pauses into ApprovalRequest
 * records, which is the closest native analogue to "needs approval".
 */
export const anthropicAdapter: ProviderAdapter = createStubAdapter('anthropic', 'Claude');
