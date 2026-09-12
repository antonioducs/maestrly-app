import { describe, expect, it } from 'vitest'
import {
  advanceOpenAICompactionLifecycle,
  commitOpenAICompactionLifecycle,
  createOpenAICompactionLifecycle,
  durableOpenAILedger,
  rollbackOpenAICompactionLifecycle,
} from '../../src/main/chat/openai/compaction-lifecycle'
import { captureOpenAIResponsesStream } from '../../src/main/chat/openai/ledger'
import type { OpenAIStreamEventLike } from '../../src/main/chat/openai/types'

function stablePrefix() {
  return captureOpenAIResponsesStream([
    { type: 'text-start', id: 'old' },
    { type: 'text-delta', id: 'old', text: 'stable prefix' },
    { type: 'text-end', id: 'old' },
  ])
}

const checkpoint: OpenAIStreamEventLike = {
  type: 'custom',
  kind: 'openai.compaction',
  providerMetadata: {
    openai: { type: 'compaction', itemId: 'cmp_1', encryptedContent: 'encrypted-checkpoint' },
  },
}

const tail: OpenAIStreamEventLike[] = [
  { type: 'text-start', id: 'tail' },
  { type: 'text-delta', id: 'tail', text: 'visible tail' },
  { type: 'text-end', id: 'tail' },
]

function pendingCheckpoint() {
  let state = createOpenAICompactionLifecycle(stablePrefix())
  state = advanceOpenAICompactionLifecycle(state, checkpoint)
  for (const event of tail) state = advanceOpenAICompactionLifecycle(state, event)
  return state
}

describe('OpenAI automatic compaction lifecycle', () => {
  it('keeps the previous durable checkpoint while the new one is still streaming', () => {
    const state = pendingCheckpoint()

    expect(state.working.entries.map((entry) => entry.type)).toEqual(['compaction', 'assistant-text'])
    expect(durableOpenAILedger(state).entries.map((entry) => entry.type)).toEqual(['assistant-text', 'assistant-text'])
    expect(JSON.stringify(durableOpenAILedger(state))).toContain('stable prefix')
    expect(JSON.stringify(durableOpenAILedger(state))).toContain('visible tail')
    expect(JSON.stringify(durableOpenAILedger(state))).not.toContain('encrypted-checkpoint')
  })

  it('promotes the checkpoint only when committing a clean terminal result', () => {
    const committed = commitOpenAICompactionLifecycle(pendingCheckpoint())

    expect(durableOpenAILedger(committed).entries.map((entry) => entry.type)).toEqual(['compaction', 'assistant-text'])
    expect(JSON.stringify(durableOpenAILedger(committed))).toContain('encrypted-checkpoint')
    expect(JSON.stringify(durableOpenAILedger(committed))).not.toContain('stable prefix')
  })

  it.each(['raw cutoff', 'retryable error', 'abort'])('restores the prefix and tail on %s', () => {
    const rolledBack = rollbackOpenAICompactionLifecycle(pendingCheckpoint())

    expect(rolledBack.fallback).toBeUndefined()
    expect(durableOpenAILedger(rolledBack)).toEqual(rolledBack.working)
    expect(JSON.stringify(rolledBack.working)).toContain('stable prefix')
    expect(JSON.stringify(rolledBack.working)).toContain('visible tail')
    expect(JSON.stringify(rolledBack.working)).not.toContain('encrypted-checkpoint')
  })

  it('does not replace the confirmed fallback when receiving two checkpoints in one attempt', () => {
    let state = pendingCheckpoint()
    state = advanceOpenAICompactionLifecycle(state, {
      type: 'custom',
      kind: 'openai.compaction',
      providerMetadata: {
        openai: { type: 'compaction', itemId: 'cmp_2', encryptedContent: 'newer-checkpoint' },
      },
    })

    expect(JSON.stringify(state.working)).toContain('newer-checkpoint')
    expect(JSON.stringify(durableOpenAILedger(state))).toContain('stable prefix')
    expect(JSON.stringify(durableOpenAILedger(state))).not.toContain('encrypted-checkpoint')
    expect(JSON.stringify(durableOpenAILedger(state))).not.toContain('newer-checkpoint')
  })
})
