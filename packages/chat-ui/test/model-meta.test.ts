import { describe, it, expect } from 'vitest'
import { parseModelsDev, parseCatalog } from '../src/usage/model-meta'
import { estimatedCostOfUsage, contextOccupancy } from '../src/usage/cost'

describe('parseModelsDev', () => {
  it('flattens the catalogue to provider/model with window and prices', () => {
    const out = parseModelsDev({ openai: { models: { 'gpt-5': { limit: { context: 400000 }, cost: { input: 1.25, output: 10 } } } } })
    expect(out['openai/gpt-5']).toMatchObject({ contextWindow: 400000, inputPer1M: 1.25, outputPer1M: 10 })
    expect(Object.keys(out)).toEqual(['openai/gpt-5'])
  })
  it('keeps the canonical provider when the same model appears elsewhere with worse data', () => {
    const map = parseCatalog({
      azure: { models: { 'gpt-5': { limit: { context: 128000 }, cost: { input: 2, output: 20 } } } },
      openai: { models: { 'gpt-5': { limit: { context: 400000 }, cost: { input: 1.25, output: 10 } } } },
    })
    expect(map.get('gpt-5')?.contextWindow).toBe(400000)
  })
  it('ignores entries without any useful metadata and non-objects', () => {
    expect(parseModelsDev({ x: { models: { y: { id: 'y' } } } })).toEqual({})
    expect(parseModelsDev(null)).toEqual({})
  })
})

describe('cost helpers', () => {
  it('prices usage from the catalogue and refuses to guess without prices', () => {
    expect(estimatedCostOfUsage({ input: 1_000_000, output: 0 }, { inputPer1M: 1.25, outputPer1M: 10 })).toBe(1.25)
    expect(estimatedCostOfUsage({ input: 10, output: 5 }, null)).toBeNull()
  })
  it('reads the occupancy from the explicit context fields first', () => {
    expect(contextOccupancy({ input: 1, output: 1, contextInput: 40, contextOutput: 2 })).toBe(42)
    expect(contextOccupancy({ input: 3, output: 4 })).toBe(7)
  })
})
