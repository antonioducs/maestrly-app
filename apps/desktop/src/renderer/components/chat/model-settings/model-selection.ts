import { createContext, useContext } from 'react'
import type { ChatProviderInfo, ChatProviderKind } from '../../../../shared/chat'

/** A model as the settings show it: the conversation default, a background task or a subagent candidate. */
export interface ModelSelection {
  providerId: string
  modelId: string
  /** `off` or absent: the provider decides. */
  effort?: string
  fastMode?: boolean
}

export const modelSelectionKey = (selection: Pick<ModelSelection, 'providerId' | 'modelId'>): string =>
  `${selection.providerId}::${selection.modelId}`

export const sameModelSelection = (a: ModelSelection | null, b: ModelSelection | null): boolean =>
  a === b ||
  (a != null &&
    b != null &&
    a.providerId === b.providerId &&
    a.modelId === b.modelId &&
    (a.effort || 'off') === (b.effort || 'off') &&
    (a.fastMode === true) === (b.fastMode === true))

const PROVIDER_TONE: Partial<Record<ChatProviderKind, string>> = {
  anthropic: 'bg-orange-300',
  'claude-subscription': 'bg-orange-300',
  openai: 'bg-emerald-300',
  'openai-responses': 'bg-emerald-300',
  'codex-subscription': 'bg-emerald-300',
  'github-copilot-subscription': 'bg-violet-300',
  'grok-subscription': 'bg-zinc-300',
  'cursor-subscription': 'bg-sky-300',
  'antigravity-subscription': 'bg-blue-300',
}

/** Colour dot that tells providers apart at a glance; unknown and custom providers share a neutral tone. */
export function providerTone(provider: ChatProviderInfo | undefined): string {
  return (provider?.kind && PROVIDER_TONE[provider.kind]) || 'bg-teal-300'
}

const EFFORT_SHORT_KEYS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

/** Short effort label for chips and segmented controls; unknown model-native efforts show as they are. */
export function effortShortLabel(effort: string, t: (key: string) => string): string {
  if (!effort || effort === 'off') return t('modelSettings.effortShort.off')
  return EFFORT_SHORT_KEYS.has(effort) ? t(`modelSettings.effortShort.${effort}`) : effort
}

/** Model key highlighted from the "In use" summary, shared by every chip of the tab. */
export const HighlightedModelContext = createContext<string | null>(null)
export const useHighlightedModel = () => useContext(HighlightedModelContext)
