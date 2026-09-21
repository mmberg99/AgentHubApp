import type { ProviderId } from '../types';
import { anthropicAdapter } from './anthropic';
import { customAdapter } from './custom';
import { googleAdapter } from './google';
import { openaiAdapter } from './openai';
import type { ProviderAdapter } from './types';

export const providerRegistry: Record<ProviderId, ProviderAdapter> = {
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
  google: googleAdapter,
  custom: customAdapter,
};

export function getAdapter(id: ProviderId): ProviderAdapter {
  return providerRegistry[id];
}

export * from './types';
