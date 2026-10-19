import type { MobilePlan } from '@maestrly/bot-fleet-protocol'
import { describe, expect, it } from 'vitest'
import {
  canRevise,
  clearDraft,
  draftFor,
  emptyDraft,
  lineDiff,
  planBlocks,
  planDecision,
  planExcerpt,
  planOutline,
  setDraft,
} from '../src/chats/plan-review'

// The desktop's own fixture (apps/desktop/test/unit/plan-review-merge.test.ts): comments sit on lines 1, 2, 5, 7, 14.
const plan = [
  '# Plan', // 1
  'Intro paragraph', // 2
  'continues here.', // 3
  '', // 4
  '- Step one', // 5
  '  detail of step one', // 6
  '- Step two', // 7
  '', // 8
  '```ts', // 9
  'const x = 1', // 10
  '```', // 11
  '| a | b |', // 12
  '', // 13
  '> Note', // 14
].join('\n')

const mobilePlan = (text: string, version = 1): MobilePlan => ({ version, title: 'Plan', text, previousText: null })

describe('plan review on the phone', () => {
  it('splits a plan into blocks that take comments on the lines the desktop does', () => {
    const blocks = planBlocks(plan)
    expect(blocks.filter((block) => block.commentable).map((block) => block.line)).toEqual([1, 2, 5, 7, 14])
    expect(blocks.map((block) => [block.line, block.source])).toEqual([
      [1, '# Plan'],
      [2, 'Intro paragraph\ncontinues here.'],
      [5, '- Step one\n  detail of step one'],
      [7, '- Step two'],
      [9, '```ts\nconst x = 1\n```'],
      [12, '| a | b |'],
      [14, '> Note'],
    ])
  })

  it('shows a nested list item indented, as Markdown of its own', () => {
    const [, nested] = planBlocks('- Step\n    - Deep detail\n      more of it')
    expect(nested).toMatchObject({ line: 2, source: '- Deep detail\n  more of it', indent: 4, commentable: true })
  })

  it('sums a plan up by its steps, or by its sections, as the desktop does', () => {
    expect(planOutline('# Rate limit **exports**\n\n## Steps\n1. Add a bucket\n   - nested\n2. Wire `it` in')).toEqual([
      'Add a bucket',
      'Wire it in',
    ])
    expect(planOutline('# Plan\n## Context\n## Approach\n```\n- not a step\n```')).toEqual(['Context', 'Approach'])
    expect(planExcerpt('# Plan\nJust **one** paragraph,\nwith a [link](https://x.dev).')).toBe(
      'Just one paragraph, with a link.'
    )
  })

  it('shows what changed between versions, line by line', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc\nd')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'same', text: 'c' },
      { kind: 'add', text: 'd' },
    ])
    expect(lineDiff('same', 'same')).toEqual([{ kind: 'same', text: 'same' }])
  })

  it('sends the draft as the Plan tab does to hosts that take it', () => {
    const current = mobilePlan(plan)
    const draft = { text: `${plan}\n- Step three`, feedback: '  Keep it short ', comments: { 5: 'Why?', 7: ' ' } }
    expect(canRevise(current, emptyDraft(current))).toBe(false)
    expect(canRevise(current, { ...emptyDraft(current), comments: { 2: 'x' } })).toBe(true)
    expect(planDecision(current, draft, 'revise', { full: true })).toEqual({
      action: 'revise',
      feedback: 'Keep it short',
      editedPlan: `${plan}\n- Step three`,
      lineComments: [{ line: 5, text: 'Why?' }],
    })
    expect(
      planDecision(current, draft, 'approve', {
        full: true,
        implementation: { target: 'maestro', profileId: 'global' },
      })
    ).toEqual({
      action: 'approve',
      editedPlan: `${plan}\n- Step three`,
      implementation: { target: 'maestro', profileId: 'global' },
    })
    expect(planDecision(current, draft, 'discard', { full: true })).toEqual({ action: 'discard' })
  })

  it('writes line comments into the feedback for a host that takes only a general comment', () => {
    const current = mobilePlan(plan)
    const draft = { text: plan, feedback: 'Overall fine.', comments: { 7: 'Merge with step one', 5: 'Add a test' } }
    const words = {
      general: 'General:',
      lines: 'On the plan:',
      line: (ref: string, text: string) => `${ref} -> ${text}`,
    }
    expect(planDecision(current, draft, 'revise', { full: false, words })).toEqual({
      action: 'revise',
      feedback:
        'General:\nOverall fine.\n\nOn the plan:\n- - Step one -> Add a test\n- - Step two -> Merge with step one',
    })
    expect(planDecision(current, draft, 'approve', { full: false, words })).toEqual({ action: 'approve' })
  })

  it('keeps a draft for its version only, and forgets it once the plan is decided', () => {
    const first = mobilePlan('1. One')
    const draft = draftFor('s:c1', first)
    expect(draftFor('s:c1', first)).toBe(draft)
    setDraft('s:c1', first, { ...draft, comments: { 1: 'Hmm' } })
    expect(draftFor('s:c1', first).comments).toEqual({ 1: 'Hmm' })
    expect(draftFor('s:c1', mobilePlan('1. One', 2)).comments).toEqual({})
    clearDraft('s:c1')
    expect(draftFor('s:c1', first).comments).toEqual({})
  })
})
