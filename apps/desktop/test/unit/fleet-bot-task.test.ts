import { describe, expect, it } from 'vitest'
import type { FleetTranscriptTask } from '@maestrly/bot-fleet-protocol'
import { taskReasons, taskSummary } from '../../src/renderer/lib/fleet/bot-task'

const task = (patch: Partial<FleetTranscriptTask> = {}): FleetTranscriptTask => ({
  agent: 'general-purpose',
  prompt: 'Transcribe EP14',
  model: 'haiku',
  activity: null,
  ...patch,
})
const routed = (patch: Partial<NonNullable<FleetTranscriptTask['delegation']>> = {}) => ({
  complexity: 'simple' as const,
  declared: true,
  tier: 'fast' as const,
  upgraded: false,
  ...patch,
})

describe('bot task rows', () => {
  it('says how hard the bot said it is and the model it ran on', () => {
    expect(taskReasons(task({ delegation: routed() }))).toEqual([
      { key: 'declared', values: { complexity: 'simple' } },
      { key: 'routed', values: { tier: 'fast', model: 'haiku' } },
    ])
  })

  it('says when the difficulty was not declared', () => {
    expect(
      taskReasons(task({ delegation: routed({ declared: false, complexity: 'medium', tier: 'balanced' }) }))[0]
    ).toEqual({ key: 'default', values: {} })
  })

  it('says when no allowed model of the wanted class existed', () => {
    expect(
      taskReasons(task({ model: 'sonnet', delegation: routed({ tier: 'balanced', upgraded: true }) }))
    ).toContainEqual({ key: 'upgraded', values: { wanted: 'fast', tier: 'balanced', model: 'sonnet' } })
  })

  it('says when no allowed model fits and the conversation model ran it', () => {
    expect(
      taskReasons(task({ model: 'opus', delegation: routed({ complexity: 'complex', tier: null }) }))
    ).toContainEqual({
      key: 'none',
      values: { model: 'opus' },
    })
  })

  it('names only the conversation model when the bot does not delegate', () => {
    expect(taskReasons(task({ model: 'opus' }))).toEqual([{ key: 'conversationModel', values: { model: 'opus' } }])
    expect(taskSummary(task({ model: 'opus' }))).toEqual({ complexity: null, model: 'opus' })
    expect(taskSummary(task({ delegation: routed() }))).toEqual({ complexity: 'simple', model: 'haiku' })
  })
})
