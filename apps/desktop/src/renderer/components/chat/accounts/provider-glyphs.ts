import type { ChatSubscriptionProviderKind } from '../../../../shared/chat'

export type ProviderGlyphId =
  | 'openai'
  | 'anthropic'
  | 'claude'
  | 'githubcopilot'
  | 'grok'
  | 'cursor'
  | 'gemini'
  | 'openrouter'
  | 'deepseek'
  | 'groq'
  | 'together'
  | 'mistral'
  | 'xiaomi'

const SUBSCRIPTION_GLYPHS: Record<ChatSubscriptionProviderKind, ProviderGlyphId> = {
  'codex-subscription': 'openai',
  'github-copilot-subscription': 'githubcopilot',
  'claude-subscription': 'claude',
  'grok-subscription': 'grok',
  'cursor-subscription': 'cursor',
  // The plan is Google AI and its models are Gemini; the Antigravity server is only how Maestrly reaches them.
  'antigravity-subscription': 'gemini',
}

export function subscriptionGlyph(kind: ChatSubscriptionProviderKind): ProviderGlyphId {
  return SUBSCRIPTION_GLYPHS[kind]
}

/** API hosts by the domain they belong to; a host matches its domain and any subdomain of it. */
const API_DOMAINS: Array<[domain: string, glyph: ProviderGlyphId]> = [
  ['openai.com', 'openai'],
  ['openai.azure.com', 'openai'],
  ['anthropic.com', 'anthropic'],
  ['openrouter.ai', 'openrouter'],
  ['deepseek.com', 'deepseek'],
  ['groq.com', 'groq'],
  ['together.xyz', 'together'],
  ['together.ai', 'together'],
  ['mistral.ai', 'mistral'],
  ['xiaomimimo.com', 'xiaomi'],
  ['x.ai', 'grok'],
  ['generativelanguage.googleapis.com', 'gemini'],
]

/** The mark of the service an API key provider's base URL points at, or null for any other endpoint. */
export function apiProviderGlyph(baseURL: string): ProviderGlyphId | null {
  let host: string
  try {
    host = new URL(baseURL).hostname.toLowerCase()
  } catch {
    return null
  }
  for (const [domain, glyph] of API_DOMAINS) {
    if (host === domain || host.endsWith(`.${domain}`)) return glyph
  }
  return null
}
