import { describe, expect, it } from 'vitest'
import {
  FLEET_BOT_DELEGATION_DEFAULT,
  fleetBotDelegationSchema,
  fleetBotSchema,
  fleetDelegationTierFor,
  fleetInstanceProfileSchema,
  fleetPatchBotRequestSchema,
  fleetTranscriptItemSchema,
} from '../src'

const sonnet = { providerId: 'builtin_claude_subscription', modelId: 'sonnet', tier: 'balanced' as const }
const opus = { providerId: 'builtin_claude_subscription', modelId: 'opus', tier: 'strong' as const }

describe('bot delegation', () => {
  it('defaults every setting and reads a missing group as null', () => {
    expect(fleetBotDelegationSchema.parse({})).toEqual(FLEET_BOT_DELEGATION_DEFAULT)
    expect(FLEET_BOT_DELEGATION_DEFAULT).toMatchObject({ mode: 'normal', maxTasks: 4, models: [] })
    expect(fleetBotSchema.shape.delegation.parse(undefined)).toBeNull()
  })

  it('rejects out-of-range tasks, duplicate models and unknown tiers', () => {
    expect(fleetBotDelegationSchema.safeParse({ maxTasks: 9 }).success).toBe(false)
    expect(fleetBotDelegationSchema.safeParse({ maxTasks: 0 }).success).toBe(false)
    expect(fleetBotDelegationSchema.safeParse({ models: [sonnet, sonnet] }).success).toBe(false)
    expect(fleetBotDelegationSchema.safeParse({ models: [{ ...sonnet, tier: 'huge' }] }).success).toBe(false)
  })

  it('travels in the bot patch and the instance profile', () => {
    expect(fleetPatchBotRequestSchema.parse({ delegation: { mode: 'delegate' } }).delegation?.mode).toBe('delegate')
    const base = {
      botId: 'scout',
      name: 'Scout',
      instructions: '',
      ceiling: 'ask',
      selection: null,
      gateway: { peersEnabled: false },
    }
    expect(fleetInstanceProfileSchema.parse(base).delegation).toBeUndefined()
    expect(fleetInstanceProfileSchema.parse({ ...base, delegation: { models: [opus] } }).delegation?.models).toEqual([
      opus,
    ])
  })

  it('moves a task up to the next allowed tier, or reports none', () => {
    expect(fleetDelegationTierFor([sonnet], 'simple')).toEqual({ tier: 'balanced', upgraded: true })
    expect(fleetDelegationTierFor([sonnet], 'medium')).toEqual({ tier: 'balanced', upgraded: false })
    expect(fleetDelegationTierFor([sonnet], 'complex')).toBeNull()
    expect(fleetDelegationTierFor([sonnet, opus], 'complex')).toEqual({ tier: 'strong', upgraded: false })
  })

  it('carries task details on tool items, optionally', () => {
    const item = {
      kind: 'tool',
      id: 'm:0',
      at: '2026-10-19T10:00:00.000Z',
      name: 'task',
      target: 'Transcribe EP14',
      state: 'running',
      output: null,
    }
    expect(fleetTranscriptItemSchema.parse(item)).not.toHaveProperty('task')
    const task = {
      agent: 'general-purpose',
      prompt: 'Transcribe EP14',
      model: 'haiku',
      activity: null,
      delegation: { complexity: 'simple', declared: true, tier: 'fast', upgraded: false },
    }
    expect(fleetTranscriptItemSchema.parse({ ...item, task })).toMatchObject({ task })
  })
})
