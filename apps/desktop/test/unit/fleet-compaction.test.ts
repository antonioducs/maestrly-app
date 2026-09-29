import { describe, expect, it } from 'vitest'
import { FLEET_COMPACTION_LIMITS } from '@maestrly/bot-fleet-protocol'
import {
  compactionFormFrom,
  compactionPatch,
  compactionProgress,
  backgroundCompactionState,
  sameCompactionConfig,
} from '../../src/renderer/lib/fleet/compaction'

describe('fleet compaction mapping', () => {
  it('defaults to 100k tokens and validates the inclusive 10–1000k range', () => {
    expect(compactionFormFrom(null).intervalThousands).toBe('100')
    expect(
      compactionPatch({
        modelId: 'prov::model',
        reasoning: null,
        fastMode: false,
        intervalThousands: '10',
        contextLimitThousands: '',
      })
    ).toEqual({
      providerId: 'prov',
      modelId: 'model',
      reasoning: null,
      fastMode: false,
      intervalTokens: FLEET_COMPACTION_LIMITS.intervalTokensMin,
    })
    expect(
      compactionPatch({
        modelId: 'prov::model',
        reasoning: null,
        fastMode: false,
        intervalThousands: '1000',
        contextLimitThousands: '',
      })?.intervalTokens
    ).toBe(FLEET_COMPACTION_LIMITS.intervalTokensMax)
    for (const intervalThousands of ['9', '1001', '12.5', 'abc', ''])
      expect(
        compactionPatch({
          modelId: 'prov::model',
          reasoning: null,
          fastMode: false,
          intervalThousands,
          contextLimitThousands: '',
        })
      ).toBeNull()
  })

  it('leaves the context limit out when empty and validates the inclusive 100–10000k range', () => {
    const form = {
      modelId: 'prov::model',
      reasoning: null,
      fastMode: false,
      intervalThousands: '100',
      contextLimitThousands: '',
    }
    expect(compactionFormFrom(null).contextLimitThousands).toBe('')
    expect(compactionPatch(form)).not.toHaveProperty('contextLimitTokens')
    expect(compactionPatch({ ...form, contextLimitThousands: '300' })?.contextLimitTokens).toBe(300_000)
    expect(compactionPatch({ ...form, contextLimitThousands: '100' })?.contextLimitTokens).toBe(
      FLEET_COMPACTION_LIMITS.contextLimitTokensMin
    )
    expect(compactionPatch({ ...form, contextLimitThousands: '10000' })?.contextLimitTokens).toBe(
      FLEET_COMPACTION_LIMITS.contextLimitTokensMax
    )
    for (const contextLimitThousands of ['99', '10001', '12.5', 'abc'])
      expect(compactionPatch({ ...form, contextLimitThousands }), contextLimitThousands).toBeNull()
    const limited = compactionPatch({ ...form, contextLimitThousands: '300' })!
    expect(compactionFormFrom(limited).contextLimitThousands).toBe('300')
    const plain = compactionPatch(form)!
    expect(sameCompactionConfig(plain, { ...plain, contextLimitTokens: null })).toBe(true)
    expect(sameCompactionConfig(plain, limited)).toBe(false)
  })

  it('maps nullable fleet progress and background state to desktop status props', () => {
    const updatedAt = '2026-09-25T12:00:00.000Z'
    expect(
      compactionProgress({
        id: 'progress-1',
        status: 'running',
        phase: null,
        completed: null,
        total: null,
        attempt: null,
        beforeTokens: null,
        afterTokens: null,
        afterQuality: null,
        error: null,
        updatedAt,
      })
    ).toMatchObject({ id: 'progress-1', status: 'running', updatedAt: Date.parse(updatedAt) })
    expect(backgroundCompactionState({ status: 'failed', error: 'offline' })).toMatchObject({
      status: 'failed',
      error: 'offline',
    })
  })
})
