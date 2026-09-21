import { createStubAdapter, type ProviderAdapter } from './types';

/**
 * Adapter for self-hosted or in-house agents that speak our own webhook shape.
 */
export const customAdapter: ProviderAdapter = createStubAdapter('custom', 'Custom');
