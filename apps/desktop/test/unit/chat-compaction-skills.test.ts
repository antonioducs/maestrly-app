import { describe, expect, it } from 'vitest'
import type { ChatMessage, MessagePart } from '../../src/shared/chat'
import {
  LOADED_SKILLS_MAX,
  loadedSkillsInSummary,
  summaryWithLoadedSkills,
} from '../../src/main/chat/compaction-skills'
import { summaryWithApprovedPlan } from '../../src/main/chat/message'

let seq = 0
const id = () => `id-${++seq}`
const message = (role: 'user' | 'assistant', parts: MessagePart[]): ChatMessage =>
  ({ id: id(), conversationId: 'c', role, createdAt: ++seq, parts }) as ChatMessage
const load = (name: string, toolName = 'use_skill', output = `Skill "${name}" loaded. Follow these instructions.`) =>
  ({
    type: 'tool',
    id: id(),
    toolCallId: id(),
    toolName,
    input: { name },
    state: { status: 'completed', output },
  }) as MessagePart
const marker = (text: string) => message('assistant', [{ type: 'compaction', id: id(), text, strategy: 'summary' }])

describe('skills loaded before a compaction', () => {
  it('names the skills loaded since the last compaction and asks to load them again', () => {
    const history = [
      message('user', [{ type: 'skill-invocation', id: id(), name: 'review', body: 'Review body' } as MessagePart]),
      message('assistant', [
        load('make-animation'),
        load('make-animation'),
        load('deploy', 'mcp__maestrly__use_skill'),
        load('missing', 'use_skill', 'Skill "missing" not found. Available: deploy'),
        { ...load('broken'), state: { status: 'error', error: 'Skill "broken" not found.' } } as MessagePart,
      ]),
    ]
    const summary = summaryWithLoadedSkills('SUMMARY', history)
    expect(loadedSkillsInSummary(summary)).toEqual({ names: ['review', 'make-animation', 'deploy'], carried: [] })
    expect(summary).toMatch(/^SUMMARY\n\n<loaded_skills names="review,make-animation,deploy" carried="">\n/)
    expect(summary).toContain('call use_skill again')
    // Nothing loaded: the summary is left as it is.
    expect(summaryWithLoadedSkills('SUMMARY', [message('user', [{ type: 'text', id: id(), text: 'hi' }])])).toBe(
      'SUMMARY'
    )
  })

  it('carries a skill the previous summary named once more, then drops it', () => {
    const first = summaryWithLoadedSkills('ONE', [message('assistant', [load('a')])])
    const second = summaryWithLoadedSkills('TWO', [marker(first), message('assistant', [load('b')])])
    expect(loadedSkillsInSummary(second)).toEqual({ names: ['b'], carried: ['a'] })
    const third = summaryWithLoadedSkills('THREE', [marker(first), marker(second), message('user', [])])
    expect(loadedSkillsInSummary(third)).toEqual({ names: [], carried: ['b'] })
    expect(summaryWithLoadedSkills('FOUR', [marker(third)])).toBe('FOUR')
    // Loading a carried skill again makes it current.
    const again = summaryWithLoadedSkills('AGAIN', [marker(second), message('assistant', [load('a')])])
    expect(loadedSkillsInSummary(again)).toEqual({ names: ['a'], carried: ['b'] })
  })

  it('keeps one block when the summarizer copied the old one, beside the approved plan', () => {
    const previous = summaryWithLoadedSkills('ONE', [message('assistant', [load('a')])])
    const history = [
      message('user', [{ type: 'text', id: id(), text: '<approved_plan>\nDo it.\n</approved_plan>' }]),
      marker(previous),
      message('assistant', [load('b')]),
    ]
    const copied = `${previous}\n\nMore summary.`
    const summary = summaryWithLoadedSkills(summaryWithApprovedPlan(copied, history), history)
    expect(summary.match(/<loaded_skills/g)).toHaveLength(1)
    expect(summary).toContain('More summary.')
    expect(summary).toContain('<approved_plan>\nDo it.\n</approved_plan>')
    expect(loadedSkillsInSummary(summary)).toEqual({ names: ['b'], carried: ['a'] })
  })

  it(`names at most ${LOADED_SKILLS_MAX} skills`, () => {
    const loads = Array.from({ length: 14 }, (_, index) => load(`skill-${index}`))
    const { names } = loadedSkillsInSummary(summaryWithLoadedSkills('S', [message('assistant', loads)]))
    expect(names).toHaveLength(LOADED_SKILLS_MAX)
    expect(names[0]).toBe('skill-0')
  })
})
