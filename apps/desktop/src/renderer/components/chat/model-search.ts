import { isChatSubscriptionProviderKind, type ChatProviderInfo } from '../../../shared/chat'
import { apiProviderGlyph, subscriptionGlyph, type ProviderGlyphId } from './accounts/provider-glyphs'

export interface ModelSearchRow {
  providerId: string
  providerName: string
  modelId: string
}

const PATH_PREFIX = 'models/'

/**
 * How pickers name a model. Gemini's OpenAI-compatible endpoint lists ids as `models/gemini-…`; the prefix is noise
 * there, while requests keep sending the id exactly as the provider listed it.
 */
export function modelDisplayName(modelId: string): string {
  return modelId.startsWith(PATH_PREFIX) && modelId.length > PATH_PREFIX.length
    ? modelId.slice(PATH_PREFIX.length)
    : modelId
}

const GLYPH_TERMS: Partial<Record<ProviderGlyphId, readonly string[]>> = {
  openai: ['openai', 'chatgpt', 'gpt', 'codex'],
  anthropic: ['anthropic', 'claude'],
  claude: ['anthropic', 'claude'],
  gemini: ['google', 'gemini'],
  grok: ['xai', 'grok'],
  githubcopilot: ['github', 'copilot'],
  xiaomi: ['xiaomi', 'mimo'],
}

/**
 * Words naming the company behind a provider and its own model family, so "gemini" finds the Google AI account even
 * where its model ids do not say so, and ranks it above other services that resell Gemini.
 */
export function providerSearchTerms(provider: Pick<ChatProviderInfo, 'kind' | 'baseURL'>): readonly string[] {
  const glyph = isChatSubscriptionProviderKind(provider.kind)
    ? subscriptionGlyph(provider.kind)
    : apiProviderGlyph(provider.baseURL)
  return glyph ? (GLYPH_TERMS[glyph] ?? [glyph]) : []
}

const WORD_START = new Set(['-', '_', '/', '.', ':', ' ', '[', '('])

/** 0 = exact, 1 = prefix, 2 = at a word start, 3 = inside the name, 4 = every word somewhere in it, 5 = elsewhere. */
function nameMatchTier(name: string, phrase: string, words: readonly string[]): number {
  if (name === phrase) return 0
  if (name.startsWith(phrase)) return 1
  for (let at = name.indexOf(phrase); at > 0; at = name.indexOf(phrase, at + 1)) {
    if (WORD_START.has(name[at - 1]!)) return 2
  }
  if (name.includes(phrase)) return 3
  return words.every((word) => name.includes(word)) ? 4 : 5
}

/**
 * The rows matching every word of `query` in the model name, its id, the provider name or the provider's terms.
 * Rows of the provider whose terms the query names come first ("gemini" → Google before Cursor), then the best match
 * on the model name; ties keep the given order, so an empty query returns the rows as they were.
 */
export function searchModelRows<T extends ModelSearchRow>(
  rows: readonly T[],
  query: string,
  termsOf: (providerId: string) => readonly string[] = () => []
): T[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return [...rows]
  const ranked: Array<{ row: T; home: number; tier: number; index: number }> = []
  rows.forEach((row, index) => {
    const name = modelDisplayName(row.modelId).toLowerCase()
    const terms = termsOf(row.providerId)
    const haystack = [name, row.modelId.toLowerCase(), row.providerName.toLowerCase(), ...terms].join(' ')
    if (!words.every((word) => haystack.includes(word))) return
    const namesProvider = (word: string) =>
      terms.some((term) => word.startsWith(term) || (word.length >= 3 && term.startsWith(word)))
    const home = words.some(namesProvider) ? 0 : 1
    ranked.push({ row, home, tier: nameMatchTier(name, words.join(' '), words), index })
  })
  return ranked.sort((a, b) => a.home - b.home || a.tier - b.tier || a.index - b.index).map(({ row }) => row)
}
