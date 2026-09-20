import { describe, expect, it } from 'vitest'
import { parseBackgroundCompactionConfig } from '../../src/main/chat/background-compaction/config'

describe('background compaction config', () => {
  it('requires a positive integer interval and a selection whenever enabled', () => {
    expect(parseBackgroundCompactionConfig({ enabled: true, intervalTokens: 100_000, selection: null })).toBeNull()
    expect(
      parseBackgroundCompactionConfig({
        enabled: true,
        intervalTokens: 0,
        selection: { providerId: 'provider', modelId: 'model', effort: 'off', fastMode: false },
      })
    ).toBeNull()
    expect(
      parseBackgroundCompactionConfig({
        enabled: true,
        intervalTokens: 100_000.5,
        selection: { providerId: 'provider', modelId: 'model', effort: 'off', fastMode: false },
      })
    ).toBeNull()
  })

  it('accepts a disabled null selection and structurally valid enabled selection', () => {
    expect(parseBackgroundCompactionConfig({ enabled: false, intervalTokens: 100_000, selection: null })).toEqual({
      enabled: false,
      intervalTokens: 100_000,
      selection: null,
    })
    expect(
      parseBackgroundCompactionConfig({
        enabled: true,
        intervalTokens: 100_000,
        selection: { providerId: 'provider', modelId: 'model', effort: 'xhigh', fastMode: true },
      })
    ).toEqual({
      enabled: true,
      intervalTokens: 100_000,
      selection: { providerId: 'provider', modelId: 'model', effort: 'xhigh', fastMode: true },
    })
  })
})
