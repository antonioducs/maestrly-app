import { describe, expect, it } from 'vitest'
import { detectExplicitSubagentRequests } from '../../src/main/chat/subagent-explicit-request'

const available = ['api-integration-engineer', 'explore', 'general-purpose', 'runtime-reviewer']

function detected(text: string): string[] {
  return detectExplicitSubagentRequests(text, available).agentNames
}

describe('detectExplicitSubagentRequests', () => {
  it('detects Portuguese explicit agent imperatives', () => {
    expect(detected('Use o `api-integration-engineer`.')).toEqual(['api-integration-engineer'])
  })

  it('detects Portuguese task delegation requests', () => {
    expect(detected('Quero utilizar o api-integration-engineer nessa tarefa.')).toEqual(['api-integration-engineer'])
  })

  it('detects Portuguese delegation after an introductory clause', () => {
    expect(detected('Antes de começar, use o api-integration-engineer.')).toEqual(['api-integration-engineer'])
  })

  it('detects English delegation requests', () => {
    expect(detected('Delegate to api-integration-engineer.')).toEqual(['api-integration-engineer'])
  })

  it('recognizes Portuguese and English delegation verbs', () => {
    const texts = [
      'usar o api-integration-engineer',
      'utilize o api-integration-engineer',
      'utiliza o api-integration-engineer',
      'utilizar o api-integration-engineer',
      'chame o api-integration-engineer',
      'delegue para o api-integration-engineer',
      'rode o api-integration-engineer',
      'call api-integration-engineer',
      'invoke api-integration-engineer',
      'run api-integration-engineer',
    ]
    for (const text of texts) {
      expect(detected(text)).toEqual(['api-integration-engineer'])
    }
  })

  it('ignores questions that merely mention agent names', () => {
    expect(detected('Por que o `api-integration-engineer` está usando o `general-purpose`?')).toEqual([])
  })

  it('ignores questions ending in question marks', () => {
    expect(detected('Use o api-integration-engineer?')).toEqual([])
    expect(detected('Utilizar o api-integration-engineer é melhor?')).toEqual([])
  })

  it('detects equivalent declarative imperatives', () => {
    expect(detected('Use o api-integration-engineer.')).toEqual(['api-integration-engineer'])
  })

  it('detects imperatives after separate questions', () => {
    expect(detected('Usar o api-integration-engineer é melhor? Use o runtime-reviewer.')).toEqual(['runtime-reviewer'])
  })

  it('ignores descriptive observations', () => {
    expect(detected('O `api-integration-engineer` está sendo substituído por `general-purpose`.')).toEqual([])
  })

  it('ignores negated requests', () => {
    expect(detected('Não use o `api-integration-engineer`.')).toEqual([])
    expect(detected("don't use explore")).toEqual([])
  })

  it('distinguishes negated and requested agents across clauses', () => {
    expect(detected('Não use o api-integration-engineer; use o general-purpose.')).toEqual(['general-purpose'])
    expect(detected('Não use o api-integration-engineer. Use o general-purpose.')).toEqual(['general-purpose'])
  })

  it('ignores documentation references', () => {
    expect(detected('Veja `api-integration-engineer` na documentação.')).toEqual([])
  })

  it('ignores backticks without delegation verbs', () => {
    expect(detected('O `api-integration-engineer` analisa as APIs do projeto.')).toEqual([])
    expect(detected('`api-integration-engineer` é o agente de integrações.')).toEqual([])
  })

  it('recognizes backticks with delegation verbs', () => {
    expect(detected('chame o `api-integration-engineer`')).toEqual(['api-integration-engineer'])
  })

  it('detects multiple explicitly requested agents', () => {
    expect(detected('use o api-integration-engineer e também chame o runtime-reviewer')).toEqual(
      expect.arrayContaining(['api-integration-engineer', 'runtime-reviewer'])
    )
  })

  it('detects complete requests with helper agents', () => {
    expect(
      detected(
        'Use o api-integration-engineer para implementar. Antes, use explore para mapear os pontos e depois runtime-reviewer para revisar.'
      )
    ).toEqual(expect.arrayContaining(['api-integration-engineer', 'explore', 'runtime-reviewer']))
  })

  it('ignores code blocks and long inline spans', () => {
    const fenced = ['Veja o exemplo:', '```', 'task(agent="api-integration-engineer")', '```', 'continue'].join('\n')
    expect(detected(fenced)).toEqual([])
    expect(detected('rode `use api-integration-engineer` no terminal')).toEqual([])
  })

  it('ignores unknown and partial agent names', () => {
    expect(detected('usa o missing-agent')).toEqual([])
    expect(detected('usa o api-integration')).toEqual([])
  })

  it('distinguishes the English explore verb from the agent name', () => {
    expect(detected('explore the codebase carefully')).toEqual([])
  })

  it('ignores subjects preceding delegation verbs', () => {
    expect(detected('O api-integration-engineer usa o general-purpose.')).toEqual([])
  })

  it('preserves positive requests after negated segments', () => {
    expect(detected('Não use o general-purpose e use o api-integration-engineer.')).toEqual([
      'api-integration-engineer',
    ])
    expect(detected('Use o api-integration-engineer e não use o general-purpose.')).toEqual([
      'api-integration-engineer',
    ])
    expect(detected("Don't use general-purpose and use api-integration-engineer.")).toEqual([
      'api-integration-engineer',
    ])
  })

  it('collects coordinated positive requests', () => {
    expect(detected('Use o api-integration-engineer e chame o runtime-reviewer.')).toEqual(
      expect.arrayContaining(['api-integration-engineer', 'runtime-reviewer'])
    )
  })

  it('ignores entirely negated coordinated requests', () => {
    expect(detected('Não use o api-integration-engineer e não use o general-purpose.')).toEqual([])
  })

  it('does not split ordinary Portuguese conjunctions', () => {
    expect(detected('Analise autenticação e autorização com cuidado.')).toEqual([])
  })

  it('supports Portuguese and English contrastive action conjunctions', () => {
    expect(detected('Não use general-purpose, mas use api-integration-engineer.')).toEqual(['api-integration-engineer'])
    expect(detected("Don't use general-purpose, but use api-integration-engineer.")).toEqual([
      'api-integration-engineer',
    ])
  })
})
