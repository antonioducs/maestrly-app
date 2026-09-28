import { describe, expect, it } from 'vitest'
import {
  MEMORY_RELEVANCE,
  calibratedVectorRelevance,
  cosineFromL2,
  lexicalRelevance,
  memorySnippet,
  passesRecallFloor,
  passesSearchFloor,
  queryStems,
} from '../../src/main/memory/relevance'

const df = (entries: Record<string, number>) => new Map(Object.entries(entries))

describe('memory relevance', () => {
  it('drops stopwords and diacritics and stems common suffixes', () => {
    expect(queryStems('Como faço a compactação das conversas?')).toEqual(['faco', 'compacta', 'conversa'])
    expect(queryStems('Deploying the releases')).toEqual(['deploy', 'releas'])
    expect(queryStems('ok, obrigado')).toEqual([])
  })

  it('matches a stem against inflected words in title and content', () => {
    const stems = queryStems('compactação')
    const match = lexicalRelevance(stems, df({ compacta: 1 }), 10, {
      title: 'Compactar conversas longas',
      content: 'Use o modelo de compactação.',
      tags: [],
    })
    expect(match.matched).toEqual(['compacta'])
    expect(match.titleMatched).toBe(1)
    expect(match.relevance).toBe(1)
  })

  it('weights by idf, penalizes words unknown to the space mildly, and applies the floors', () => {
    const stems = queryStems('vou criar a tag da release, algum cuidado?')
    const match = lexicalRelevance(stems, df({ tag: 1, releas: 1 }), 48, {
      title: 'Release tags are signed',
      content: 'Create release tags with git tag -s.',
      tags: [],
    })
    expect(match.matched.sort()).toEqual(['releas', 'tag'])
    expect(match.relevance).toBeGreaterThanOrEqual(MEMORY_RELEVANCE.recallMin)
    expect(passesRecallFloor(match, stems.length)).toBe(true)
    const partial = lexicalRelevance(queryStems('port number for the database'), df({ port: 1 }), 48, {
      title: 'Staging SSH uses port 2222',
      content: 'Only on port 2222.',
      tags: [],
    })
    expect(passesRecallFloor(partial, 3)).toBe(false)
    expect(passesSearchFloor(partial)).toBe(true)
  })

  it('converts sqlite-vec L2 distances between unit vectors into calibrated cosine relevance', () => {
    expect(cosineFromL2(0)).toBe(1)
    expect(cosineFromL2(Math.SQRT2)).toBeCloseTo(0)
    expect(calibratedVectorRelevance(0.3)).toBe(0)
    expect(calibratedVectorRelevance(0.65)).toBeCloseTo(1)
  })

  it('cuts a snippet around the first match', () => {
    const content = `${'intro '.repeat(100)}the deploy switches blue to green ${'tail '.repeat(100)}`
    const snippet = memorySnippet(content, ['deploy'], 120)
    expect(snippet.length).toBeLessThanOrEqual(120)
    expect(snippet).toContain('deploy')
  })
})
