import type { SharedV3ProviderOptions } from '@ai-sdk/provider'
import { isGrokSubscriptionProvider } from './catalog'

/** Applies the provider-specific Fast transport from the already-resolved execution snapshot. */
export function applyFastModeServiceTier(
  providerOptions: SharedV3ProviderOptions | undefined,
  fastMode: boolean,
  providerId: string
): SharedV3ProviderOptions | undefined {
  if (!fastMode || !isGrokSubscriptionProvider(providerId)) return providerOptions
  const compat = (providerOptions?.['openai-compatible'] ?? {}) as Record<string, unknown>
  return {
    ...providerOptions,
    'openai-compatible': {
      ...compat,
      service_tier: 'priority',
    },
  }
}
