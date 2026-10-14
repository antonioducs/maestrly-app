import { describe, expect, it } from 'vitest'
import { selectionPatch, type FleetSelectionOption } from '../src/index.js'

const opus: FleetSelectionOption = {
  id: 'claude::opus',
  providerId: 'claude',
  providerLabel: 'Claude',
  modelId: 'opus',
  modelLabel: 'Opus',
  efforts: ['low', 'high'],
  fastMode: true,
}
const mini: FleetSelectionOption = {
  ...opus,
  id: 'openai::mini',
  providerId: 'openai',
  modelId: 'mini',
  efforts: [],
  fastMode: false,
}

describe('selectionPatch', () => {
  it('keeps effort and Fast on the same model and resets them on another', () => {
    const current = { providerId: 'claude', modelId: 'opus', reasoning: 'high', fastMode: true }
    expect(selectionPatch(current, { model: opus })).toEqual(current)
    expect(selectionPatch(current, { model: mini })).toEqual({
      providerId: 'openai',
      modelId: 'mini',
      reasoning: null,
      fastMode: false,
    })
    expect(selectionPatch(null, { model: opus })).toEqual({
      providerId: 'claude',
      modelId: 'opus',
      reasoning: 'low',
      fastMode: false,
    })
  })
  it('returns to the default model, and changes effort or Fast only on a chosen model', () => {
    const current = { providerId: 'claude', modelId: 'opus', reasoning: 'low', fastMode: false }
    expect(selectionPatch(current, { model: null })).toBeNull()
    expect(selectionPatch(current, { reasoning: 'high' })).toEqual({ ...current, reasoning: 'high' })
    expect(selectionPatch(null, { fastMode: true })).toBeNull()
  })
})
