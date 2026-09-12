import { describe, expect, it } from 'vitest'
import {
  resolveCodexContextWindow,
  type CodexContextWindowModel,
} from '../../src/main/chat/codex-subscription/context-window'

const longContextModel: CodexContextWindowModel = {
  contextWindow: 258_400,
  nominalContextWindow: 272_000,
  maxContextWindow: 1_000_000,
  effectiveContextWindowPercent: 95,
}

describe('resolveCodexContextWindow', () => {
  it('separates the nominal configuration from the ceiling and estimates the effective window', () => {
    expect(resolveCodexContextWindow({ model: longContextModel })).toEqual({
      configurable: true,
      maxNominal: 1_000_000,
      requestedNominal: 1_000_000,
      effectiveEstimate: 950_000,
    })

    expect(resolveCodexContextWindow({ model: longContextModel, userLimit: 1_500_000 })).toEqual({
      configurable: true,
      maxNominal: 1_000_000,
      requestedNominal: 1_000_000,
      effectiveEstimate: 950_000,
    })

    expect(resolveCodexContextWindow({ model: longContextModel, userLimit: 300_000 })).toEqual({
      configurable: true,
      maxNominal: 1_000_000,
      requestedNominal: 300_000,
      effectiveEstimate: 285_000,
    })
  })

  it('uses observations only from the same nominal configuration', () => {
    expect(
      resolveCodexContextWindow({
        model: longContextModel,
        userLimit: 1_000_000,
        sameRequestObservation: { requestedNominal: 272_000, contextWindow: 250_000 },
      }).effectiveEstimate
    ).toBe(950_000)

    expect(
      resolveCodexContextWindow({
        model: longContextModel,
        userLimit: 1_000_000,
        sameRequestObservation: { requestedNominal: 1_000_000, contextWindow: 940_000 },
      }).effectiveEstimate
    ).toBe(940_000)

    expect(
      resolveCodexContextWindow({
        model: longContextModel,
        sameRequestObservation: { requestedNominal: 1_000_000, contextWindow: 990_000 },
      }).effectiveEstimate
    ).toBe(950_000)

    // An observation without a nominal configuration cannot be reused, even from a legacy JS integration.
    expect(
      resolveCodexContextWindow({
        model: longContextModel,
        sameRequestObservation: 940_000 as unknown as { requestedNominal: number; contextWindow: number },
      }).effectiveEstimate
    ).toBe(950_000)
  })

  it('keeps the active window without assuming 1M when the nominal ceiling is unknown', () => {
    expect(
      resolveCodexContextWindow({
        model: { ...longContextModel, maxContextWindow: null },
        userLimit: 1_000_000,
      })
    ).toEqual({
      configurable: false,
      maxNominal: null,
      requestedNominal: null,
      effectiveEstimate: 258_400,
    })
  })

  it('uses 100% when the published percentage is invalid', () => {
    expect(
      resolveCodexContextWindow({
        model: {
          contextWindow: 100,
          nominalContextWindow: 100,
          maxContextWindow: 1_000,
          effectiveContextWindowPercent: 0,
        },
        userLimit: 50_000,
      })
    ).toMatchObject({ requestedNominal: 1_000, effectiveEstimate: 1_000 })

    expect(
      resolveCodexContextWindow({
        model: {
          contextWindow: 100,
          nominalContextWindow: 100,
          maxContextWindow: 1_000,
          effectiveContextWindowPercent: -1,
        },
      })
    ).toMatchObject({ requestedNominal: 1_000, effectiveEstimate: 1_000 })

    expect(
      resolveCodexContextWindow({
        model: {
          contextWindow: 100,
          nominalContextWindow: 100,
          maxContextWindow: 1_000,
          effectiveContextWindowPercent: 250,
        },
      })
    ).toMatchObject({ requestedNominal: 1_000, effectiveEstimate: 1_000 })

    expect(
      resolveCodexContextWindow({
        model: {
          contextWindow: 100,
          nominalContextWindow: 100,
          maxContextWindow: 1_000,
          effectiveContextWindowPercent: null,
        },
        userLimit: 1_000,
      })
    ).toMatchObject({ requestedNominal: 1_000, effectiveEstimate: 1_000 })

    expect(
      resolveCodexContextWindow({
        model: {
          contextWindow: 100,
          nominalContextWindow: 100,
          maxContextWindow: 1_000,
          effectiveContextWindowPercent: 12.5,
        },
        userLimit: 0.1,
      })
    ).toMatchObject({ requestedNominal: 1, effectiveEstimate: 1 })

    expect(
      resolveCodexContextWindow({
        model: {
          contextWindow: 100,
          nominalContextWindow: 100,
          maxContextWindow: 1_000,
          effectiveContextWindowPercent: 12.5,
        },
      })
    ).toMatchObject({ requestedNominal: 1_000, effectiveEstimate: 125 })
  })
})
