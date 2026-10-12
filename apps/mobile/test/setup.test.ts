import type { FleetSelectionOption } from '@maestrly/bot-fleet-protocol'
import { describe, expect, it } from 'vitest'
import { botRecord } from '../src/fleet/factories'
import { effortChoices, groupOptions, setupSummary } from '../src/fleet/setup'
import { translator } from '../src/i18n/translate'

const { t } = translator('en')
const option = (providerLabel: string, modelLabel: string, efforts: string[] = []): FleetSelectionOption => ({
  id: `${providerLabel}::${modelLabel}`,
  providerId: providerLabel.toLowerCase(),
  providerLabel,
  modelId: modelLabel.toLowerCase().replaceAll(' ', '-'),
  modelLabel,
  efforts,
  fastMode: false,
})
const options = [
  option('Claude', 'Opus 5.5', ['low', 'high']),
  option('OpenAI', 'GPT-5.5'),
  option('Claude', 'Haiku 5'),
  option('Gemini', 'Gemini 3 Pro'),
]

describe('bot setup', () => {
  it('groups models by provider in the server’s order and searches providers and models', () => {
    expect(groupOptions(options, '').map((group) => [group.provider, group.options.map((item) => item.modelLabel)])).toEqual([
      ['Claude', ['Opus 5.5', 'Haiku 5']],
      ['OpenAI', ['GPT-5.5']],
      ['Gemini', ['Gemini 3 Pro']],
    ])
    expect(groupOptions(options, 'CLAUDE').map((group) => group.provider)).toEqual(['Claude'])
    expect(groupOptions(options, 'pro').flatMap((group) => group.options.map((item) => item.modelLabel))).toEqual(['Gemini 3 Pro'])
    expect(groupOptions(options, 'nothing')).toEqual([])
  })

  it('offers Default and the model’s own effort levels, or none', () => {
    expect(effortChoices(options[0])).toEqual([null, 'low', 'high'])
    expect(effortChoices(options[1])).toEqual([])
  })

  it('summarizes the model and effort a bot uses', () => {
    expect(setupSummary(botRecord({ id: 'b', name: 'B', selection: null }), null, t)).toBe('Bot default')
    const opus = { providerId: 'claude', modelId: 'opus-5.5', fastMode: false }
    expect(setupSummary(botRecord({ id: 'b', name: 'B', selection: { ...opus, reasoning: 'high' } }), options[0], t)).toBe(
      'Opus 5.5 · High'
    )
    expect(setupSummary(botRecord({ id: 'b', name: 'B', selection: { ...opus, reasoning: null } }), options[0], t)).toBe(
      'Opus 5.5'
    )
  })
})
