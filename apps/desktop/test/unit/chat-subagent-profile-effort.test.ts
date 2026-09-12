import { describe, expect, it } from 'vitest'
import { validateSubagentProfileEffort } from '../../src/shared/subagent-profile-effort'

const candidate = { providerId: 'provider', modelId: 'model', effort: 'high' }

describe('validateSubagentProfileEffort', () => {
  it('off never sends effort or requires metadata', () => {
    expect(
      validateSubagentProfileEffort({ ...candidate, effort: 'off' }, { status: 'unavailable', meta: null })
    ).toEqual({ sentEffort: null, diagnostics: [], valid: true })
  })

  it('missing metadata tries manual effort; reasoning false rejects explicit effort and degrades inheritance', () => {
    expect(validateSubagentProfileEffort(candidate, { status: 'unavailable', meta: null })).toMatchObject({
      sentEffort: 'high',
      valid: true,
      diagnostics: [{ code: 'effort-unverified' }],
    })
    expect(validateSubagentProfileEffort(candidate, { status: 'available', meta: { reasoning: false } })).toMatchObject(
      { sentEffort: null, valid: false, diagnostics: [{ code: 'invalid-effort', severity: 'error' }] }
    )
    expect(
      validateSubagentProfileEffort(candidate, { status: 'available', meta: { reasoning: false } }, true)
    ).toMatchObject({
      sentEffort: null,
      valid: true,
      diagnostics: [{ code: 'invalid-effort', severity: 'warning' }],
    })
  })

  it('authoritative metadata rejects explicit effort and degrades synthesized effort', () => {
    const metadata = { status: 'available' as const, meta: { reasoning: true, reasoningEfforts: ['low'] } }
    expect(validateSubagentProfileEffort(candidate, metadata)).toMatchObject({
      sentEffort: null,
      valid: false,
      diagnostics: [{ code: 'invalid-effort', severity: 'error' }],
    })
    expect(validateSubagentProfileEffort(candidate, metadata, true)).toMatchObject({
      sentEffort: null,
      valid: true,
      diagnostics: [{ code: 'invalid-effort', severity: 'warning' }],
    })
  })

  it('translates legacy ultra when absent and retains native ultra when supported', () => {
    expect(
      validateSubagentProfileEffort(
        { ...candidate, effort: 'ultra' },
        { status: 'available', meta: { reasoning: true, reasoningEfforts: ['low', 'high', 'max'] } }
      )
    ).toMatchObject({ sentEffort: 'max', valid: true, diagnostics: [] })
    expect(
      validateSubagentProfileEffort(
        { ...candidate, effort: 'ultra' },
        { status: 'available', meta: { reasoning: true, reasoningEfforts: ['low', 'high', 'ultra'] } }
      )
    ).toMatchObject({ sentEffort: 'ultra', valid: true, diagnostics: [] })
  })
})
