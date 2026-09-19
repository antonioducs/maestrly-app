import { resolveContextWindow } from '../../src/main/chat/context-limits'
import { describe, expect, it } from 'vitest'
import {
  cursorPublishedUsagePricing,
  cursorProviderContextWindow,
  cursorReasoningEfforts,
  estimateCursorPublishedCostUsd,
  findCursorFastParameter,
  findCursorModel,
  formatCursorModelCatalogLines,
  normalizeCursorModelList,
  pickFastOnValue,
  pickStandardFastOffValue,
  resolveCursorModelAxes,
  resolveCursorStandardSelection,
  toCursorModelSelection,
} from '../../src/main/chat/cursor-sdk/models'

describe('Cursor model helpers', () => {
  it.each([
    ['grok-4.6', 1_000_000, 256_000],
    ['grok-4.5', undefined, 256_000],
    ['composer-2.5', 1_000_000, 200_000],
    ['composer-2.5-fast', undefined, 200_000],
    ['claude-fable-5-1', 1_000_000, 1_000_000],
    ['claude-opus-5', 1_000_000, 1_000_000],
    ['gpt-6-astra', 1_100_000, 1_100_000],
    ['unknown-model', undefined, undefined],
    ['not-grok-4.6', 500_000, 500_000],
  ])('resolves the Cursor context window for %s', (modelId, catalogWindow, expected) => {
    expect(
      resolveContextWindow({
        providerWindow: cursorProviderContextWindow(modelId),
        catalogWindow,
      })
    ).toBe(expected)
  })

  it('does not infer the subscription charge from an old public tariff', () => {
    expect(cursorPublishedUsagePricing('composer-2.5', false)).toBeNull()
    expect(estimateCursorPublishedCostUsd('composer-2.5', true, { input: 100, output: 10 })).toBeNull()
  })

  it('rejects malformed nested catalogs and blank model IDs', () => {
    const models = normalizeCursorModelList([
      { id: '' },
      { id: '  ' },
      { id: 'ok', aliases: [null, 42, 'alias'], parameters: [null] },
    ])
    expect(models.map((model) => model.id)).toEqual(['ok'])
    expect(findCursorModel(models, 'alias')?.id).toBe('ok')
    expect(() => resolveCursorModelAxes(models, { modelId: 'ok', fastMode: true })).not.toThrow()
  })

  it('does not combine values from mutually exclusive catalog variants', () => {
    const models = [
      {
        id: 'router',
        variants: [
          {
            displayName: 'Standard high',
            params: [
              { id: 'speed', value: 'standard' },
              { id: 'effort', value: 'high' },
            ],
          },
          {
            displayName: 'Fast low',
            params: [
              { id: 'speed', value: 'fast' },
              { id: 'effort', value: 'low' },
            ],
          },
        ],
      },
    ]
    expect(resolveCursorModelAxes(models, { modelId: 'router', fastMode: true, reasoningEffort: 'high' }).ok).toBe(
      false
    )
    expect(resolveCursorModelAxes(models, { modelId: 'router', fastMode: true, reasoningEffort: 'low' }).ok).toBe(true)
  })

  it('normalizes array and { models } payloads', () => {
    expect(normalizeCursorModelList([{ id: 'a' }, { id: 'b' }])).toEqual([{ id: 'a' }, { id: 'b' }])
    expect(normalizeCursorModelList({ models: [{ id: 'c' }] })).toEqual([{ id: 'c' }])
    expect(normalizeCursorModelList(null)).toEqual([])
  })

  it('toCursorModelSelection does not invent params', () => {
    expect(toCursorModelSelection({ id: 'x' })).toEqual({ id: 'x' })
    expect(toCursorModelSelection({ id: 'x', params: [{ id: 'fast', value: 'false' }] })).toEqual({
      id: 'x',
      params: [{ id: 'fast', value: 'false' }],
    })
  })

  it('finds fast-like parameters and accepts only unambiguous off values', () => {
    const param = {
      id: 'fast',
      values: [
        { value: 'true', displayName: 'Fast' },
        { value: 'false', displayName: 'Standard' },
      ],
    }
    expect(findCursorFastParameter({ id: 'm', displayName: 'M', parameters: [param] })?.id).toBe('fast')
    expect(pickStandardFastOffValue(param)).toBe('false')
    expect(pickStandardFastOffValue({ id: 'fast', values: [{ value: 'off' }, { value: 'on' }] })).toBe('off')
    expect(pickStandardFastOffValue({ id: 'fast', values: [{ value: 'standard' }, { value: 'fast' }] })).toBe(
      'standard'
    )
  })

  it('does not treat default/normal/slow/0 as Fast-off', () => {
    for (const ambiguous of ['default', 'normal', 'slow', '0']) {
      expect(
        pickStandardFastOffValue({
          id: 'fast',
          values: [{ value: 'true' }, { value: ambiguous }],
        })
      ).toBeUndefined()
    }
  })

  it('resolveCursorStandardSelection sets explicit off value', () => {
    const resolved = resolveCursorStandardSelection({
      id: 'composer-2.5',
      displayName: 'Composer 2.5',
      parameters: [
        {
          id: 'fast',
          values: [{ value: 'true' }, { value: 'false' }],
        },
      ],
    })
    expect(resolved.ok).toBe(true)
    if (resolved.ok) {
      expect(resolved.selection.params).toEqual([{ id: 'fast', value: 'false' }])
      expect(resolved.note).toMatch(/Fast disabled/i)
    }
  })

  it('resolveCursorStandardSelection fails closed when values are unknown', () => {
    const resolved = resolveCursorStandardSelection({
      id: 'composer-2.5',
      displayName: 'Composer 2.5',
      parameters: [{ id: 'fast', values: [{ value: 'ultra' }] }],
    })
    expect(resolved.ok).toBe(false)
  })

  it('resolveCursorStandardSelection fails closed on ambiguous catalog values when Fast control is required', () => {
    for (const ambiguous of ['default', 'normal', 'slow', '0']) {
      const resolved = resolveCursorStandardSelection(
        {
          id: 'composer-2.5',
          displayName: 'Composer 2.5',
          parameters: [{ id: 'fast', values: [{ value: 'true' }, { value: ambiguous }] }],
        },
        { requireFastControl: true }
      )
      expect(resolved.ok).toBe(false)
    }
  })

  it('prefers exact model IDs and refuses ambiguous aliases', () => {
    const models = [
      { id: 'other', aliases: ['wanted', 'shared'] },
      { id: 'wanted', aliases: ['shared'] },
    ]
    expect(findCursorModel(models, 'wanted')?.id).toBe('wanted')
    expect(findCursorModel(models, 'shared')).toBeUndefined()
  })

  it('findCursorModel matches aliases case-insensitively', () => {
    const models = [{ id: 'composer-2.5', displayName: 'Composer 2.5', aliases: ['Composer2.5'] }]
    expect(findCursorModel(models, 'COMPOSER-2.5')?.id).toBe('composer-2.5')
    expect(findCursorModel(models, 'composer2.5')?.id).toBe('composer-2.5')
  })

  it('formats catalog lines without throwing', () => {
    const lines = formatCursorModelCatalogLines([
      {
        id: 'm1',
        displayName: 'Model One',
        parameters: [{ id: 'fast', values: [{ value: 'true' }, { value: 'false' }] }],
        variants: [{ displayName: 'Standard', params: [{ id: 'fast', value: 'false' }], isDefault: true }],
      },
    ])
    expect(lines[0]).toContain('m1')
    expect(lines[0]).toContain('fast')
  })
})

const COMPOSER_2_5 = {
  id: 'composer-2.5',
  displayName: 'Composer 2.5',
  parameters: [
    {
      id: 'fast',
      values: [
        { value: 'true', displayName: 'Fast' },
        { value: 'false', displayName: 'Standard' },
      ],
    },
  ],
}

describe('resolveCursorModelAxes', () => {
  const GROK_4_6 = {
    id: 'grok-4.6',
    displayName: 'Grok 4.6',
    parameters: [
      { id: 'speed', values: [{ value: 'standard' }, { value: 'fast' }] },
      {
        id: 'reasoning_effort',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    ],
  }

  it('resolves Fast and reasoning as independent canonical axes', () => {
    expect(cursorReasoningEfforts(GROK_4_6)).toEqual(['low', 'medium', 'high', 'xhigh'])
    const result = resolveCursorModelAxes([GROK_4_6], {
      modelId: 'grok-4.6',
      fastMode: true,
      reasoningEffort: 'xhigh',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.resolution.selection).toEqual({
        id: 'grok-4.6',
        params: [
          { id: 'reasoning_effort', value: 'xhigh' },
          { id: 'speed', value: 'fast' },
        ],
      })
    }
  })

  it('discovers variant-only axes without inventing efforts', () => {
    const variantsOnly = {
      id: 'grok-4.6',
      variants: [
        {
          displayName: 'Standard low',
          params: [
            { id: 'speed', value: 'standard' },
            { id: 'effort', value: 'low' },
          ],
        },
        {
          displayName: 'Fast xhigh',
          params: [
            { id: 'speed', value: 'fast' },
            { id: 'effort', value: 'xhigh' },
          ],
        },
      ],
    }
    expect(cursorReasoningEfforts(variantsOnly)).toEqual(['low', 'xhigh'])
    expect(resolveCursorModelAxes([variantsOnly], { modelId: 'grok-4.6', reasoningEffort: 'medium' }).ok).toBe(false)
    const off = resolveCursorModelAxes([variantsOnly], { modelId: 'grok-4.6', reasoningEffort: 'off' })
    expect(off.ok).toBe(true)
    if (off.ok) expect(off.resolution.selection).toEqual({ id: 'grok-4.6' })
  })

  it('rejects ambiguous Fast and effort combinations', () => {
    const result = resolveCursorModelAxes(
      [
        {
          id: 'coupled',
          parameters: [
            {
              id: 'mode',
              displayName: 'Fast reasoning effort',
              values: [{ value: 'standard' }, { value: 'fast' }, { value: 'high' }],
            },
          ],
        },
      ],
      { modelId: 'coupled', fastMode: true, reasoningEffort: 'high' }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/cannot be combined safely/)
  })

  it('sends explicit fast=false for the Standard variant', () => {
    const result = resolveCursorModelAxes([COMPOSER_2_5], { modelId: 'composer-2.5', fastMode: false })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.resolution.selection).toEqual({
        id: 'composer-2.5',
        params: [{ id: 'fast', value: 'false' }],
      })
      expect(result.resolution.canonicalParams).toEqual([{ id: 'fast', value: 'false' }])
    }
  })

  it('requests Fast only when the catalog provides an unambiguous value', () => {
    const result = resolveCursorModelAxes([COMPOSER_2_5], { modelId: 'composer-2.5', fastMode: true })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.resolution.selection.params).toEqual([{ id: 'fast', value: 'true' }])
    }
    // Reject ambiguous catalog values.
    const ambiguous = resolveCursorModelAxes(
      [{ id: 'm', displayName: 'M', parameters: [{ id: 'fast', values: [{ value: 'turbo' }, { value: 'ultra' }] }] }],
      { modelId: 'm', fastMode: true }
    )
    expect(ambiguous.ok).toBe(false)
  })

  it('sends only the model ID when there is no speed axis', () => {
    const result = resolveCursorModelAxes([{ id: 'plain', displayName: 'Plain' }], {
      modelId: 'plain',
      fastMode: false,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.resolution.selection).toEqual({ id: 'plain' })
  })

  it('leaves omitted Fast mode to the backend default', () => {
    const result = resolveCursorModelAxes([COMPOSER_2_5], { modelId: 'composer-2.5' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.resolution.selection).toEqual({ id: 'composer-2.5' })
  })

  it('rejects ambiguous Standard values: default, normal, slow and zero', () => {
    for (const ambiguous of ['default', 'normal', 'slow', '0']) {
      const result = resolveCursorModelAxes(
        [
          {
            id: 'composer-2.5',
            displayName: 'Composer 2.5',
            parameters: [{ id: 'fast', values: [{ value: 'true' }, { value: ambiguous }] }],
          },
        ],
        { modelId: 'composer-2.5', fastMode: false }
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/Refusing to guess/)
    }
  })

  it('resolves aliases and rejects unknown models', () => {
    const models = [{ ...COMPOSER_2_5, aliases: ['c25'] }]
    expect(resolveCursorModelAxes(models, { modelId: 'c25', fastMode: false }).ok).toBe(true)
    expect(resolveCursorModelAxes(models, { modelId: 'ghost', fastMode: false }).ok).toBe(false)
  })

  it('accepts true, on and fast without inventing a value', () => {
    expect(pickFastOnValue({ id: 'fast', values: [{ value: 'true' }] })).toBe('true')
    expect(pickFastOnValue({ id: 'fast', values: [{ value: 'on' }, { value: 'off' }] })).toBe('on')
    expect(pickFastOnValue({ id: 'fast', values: [{ value: 'fast' }, { value: 'standard' }] })).toBe('fast')
    expect(pickFastOnValue({ id: 'fast', values: [{ value: 'speed' }] })).toBeUndefined()
  })
})
