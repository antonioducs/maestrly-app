import { describe, expect, it } from 'vitest'
import { initialReviewerChoice, reviewErrorText, reviewModelLabel } from '../../src/renderer/lib/review'
import { tFor } from '../../src/shared/i18n'
import { parseReviewerPreference, parseReviewModelChoice } from '../../src/shared/review'

const conversation = { providerId: 'codex', modelId: 'gpt-x', reasoning: 'high', fastMode: true, providerName: 'Codex' }
const chosen = { providerId: 'claude', modelId: 'claude-y', reasoning: 'off', fastMode: false }

describe('choosing who reviews', () => {
  it("offers the last reviewer first, and otherwise the conversation's model", () => {
    expect(initialReviewerChoice({ conversation, last: null })).toEqual({
      useConversation: true,
      choice: { providerId: 'codex', modelId: 'gpt-x', reasoning: 'high', fastMode: true },
    })
    expect(initialReviewerChoice({ conversation, last: { kind: 'conversation' } }).useConversation).toBe(true)
    expect(initialReviewerChoice({ conversation, last: { kind: 'model', ...chosen } })).toEqual({
      useConversation: false,
      choice: chosen,
    })
    // A conversation without a model of its own cannot review; a model has to be chosen.
    expect(initialReviewerChoice({ conversation: null, last: { kind: 'conversation' } })).toEqual({
      useConversation: false,
      choice: null,
    })
  })

  it("names the conversation's model with its effort and Fast", () => {
    expect(reviewModelLabel(conversation)).toBe('Codex · gpt-x · high · Fast')
    expect(reviewModelLabel(chosen)).toBe('claude · claude-y')
  })

  it('parses reviewer choices and the saved preference defensively', () => {
    expect(parseReviewModelChoice({ ...chosen, providerId: ' claude ' })).toEqual(chosen)
    expect(parseReviewModelChoice({ ...chosen, reasoning: '' })).toBeNull()
    expect(parseReviewModelChoice({ ...chosen, fastMode: 'false' })).toBeNull()
    expect(parseReviewModelChoice({ ...chosen, modelId: 'x'.repeat(301) })).toBeNull()
    expect(parseReviewModelChoice(null)).toBeNull()
    expect(parseReviewerPreference({ kind: 'conversation', modelId: 'ignored' })).toEqual({ kind: 'conversation' })
    expect(parseReviewerPreference({ kind: 'model', ...chosen })).toEqual({ kind: 'model', ...chosen })
    expect(parseReviewerPreference({ kind: 'model', providerId: 'claude' })).toBeNull()
    expect(parseReviewerPreference({ kind: 'other' })).toBeNull()
  })

  it('explains refused reviewers', () => {
    const t = tFor('en', 'chat') as never
    expect(reviewErrorText(t, 'reviewer-unsupported')).toBe('ChatGPT Web cannot run reviewers; choose another model.')
    expect(reviewErrorText(t, 'Provider “x” is not authenticated.')).toBe('Provider “x” is not authenticated.')
  })
})
