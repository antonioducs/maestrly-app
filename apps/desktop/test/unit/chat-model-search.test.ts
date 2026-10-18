import { describe, expect, it } from 'vitest'
import {
  modelDisplayName,
  providerSearchTerms,
  searchModelRows,
  type ModelSearchRow,
} from '../../src/renderer/components/chat/model-search'

const providers = [
  { id: 'cursor', name: 'Cursor', kind: 'cursor-subscription' as const, baseURL: '' },
  { id: 'claude', name: 'Claude', kind: 'claude-subscription' as const, baseURL: '' },
  { id: 'google', name: 'Google AI', kind: 'antigravity-subscription' as const, baseURL: '' },
  {
    id: 'gemini-key',
    name: 'Gemini',
    kind: 'openai' as const,
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
]
const terms = new Map(providers.map((provider) => [provider.id, providerSearchTerms(provider)]))
const termsOf = (providerId: string) => terms.get(providerId) ?? []

function rows(entries: Array<[providerId: string, modelId: string]>): ModelSearchRow[] {
  return entries.map(([providerId, modelId]) => ({
    providerId,
    providerName: providers.find((provider) => provider.id === providerId)!.name,
    modelId,
  }))
}

const catalog = rows([
  ['cursor', 'gemini-2.5-pro'],
  ['cursor', 'gemini-3-flash'],
  ['cursor', 'claude-4.5-sonnet'],
  ['claude', 'sonnet'],
  ['claude', 'haiku'],
  ['claude', 'claude-opus-4-6'],
  ['google', 'gemini-3.1-pro'],
  ['google', 'gemini-3.8-flash'],
  ['gemini-key', 'models/gemini-2.5-pro'],
  ['gemini-key', 'models/gemma-3-27b-it'],
])
const ids = (found: ModelSearchRow[]) => found.map((row) => `${row.providerId}:${row.modelId}`)

describe('model picker search', () => {
  it('names OpenAI-compatible Gemini models without the models/ path', () => {
    expect(modelDisplayName('models/gemini-2.5-pro')).toBe('gemini-2.5-pro')
    expect(modelDisplayName('models/')).toBe('models/')
    expect(modelDisplayName('openai/gpt-5')).toBe('openai/gpt-5')
  })

  it('keeps the given order without a query', () => {
    expect(searchModelRows(catalog, '  ', termsOf)).toEqual(catalog)
  })

  it('lists Google first for "gemini", then other services that offer Gemini', () => {
    expect(ids(searchModelRows(catalog, 'gemini', termsOf))).toEqual([
      'google:gemini-3.1-pro',
      'google:gemini-3.8-flash',
      'gemini-key:models/gemini-2.5-pro',
      'gemini-key:models/gemma-3-27b-it',
      'cursor:gemini-2.5-pro',
      'cursor:gemini-3-flash',
    ])
  })

  it('matches every word anywhere in the model or provider, and the provider by name', () => {
    expect(ids(searchModelRows(catalog, 'google flash', termsOf))).toEqual(['google:gemini-3.8-flash'])
    expect(ids(searchModelRows(catalog, 'gemini 2.5', termsOf))).toEqual([
      'gemini-key:models/gemini-2.5-pro',
      'cursor:gemini-2.5-pro',
    ])
  })

  it('finds Claude aliases by the family name and ranks the best name match first', () => {
    expect(ids(searchModelRows(catalog, 'claude', termsOf))).toEqual([
      'claude:claude-opus-4-6',
      'claude:sonnet',
      'claude:haiku',
      'cursor:claude-4.5-sonnet',
    ])
    expect(ids(searchModelRows(catalog, 'sonnet', termsOf))).toEqual(['claude:sonnet', 'cursor:claude-4.5-sonnet'])
  })
})
