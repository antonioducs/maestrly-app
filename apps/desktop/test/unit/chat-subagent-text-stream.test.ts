import { describe, expect, it } from 'vitest'
import {
  applySubagentTextUpdate,
  createSubagentTextEmitter,
  type SubagentTextUpdate,
} from '../../src/main/chat/subagent-text-stream'

describe('subagent text stream normalization', () => {
  it('emits append for growing snapshots and replace for corrected snapshots', () => {
    const updates: SubagentTextUpdate[] = []
    const emit = createSubagentTextEmitter((update) => updates.push(update))

    emit('Parcial')
    emit('Parcial completo')
    emit('Resposta corrigida')
    emit('Resposta corrigida')

    expect(updates).toEqual([
      { kind: 'append', text: 'Parcial' },
      { kind: 'append', text: ' completo' },
      { kind: 'replace', text: 'Resposta corrigida' },
    ])
    expect(updates.reduce(applySubagentTextUpdate, '')).toBe('Resposta corrigida')
  })
})
