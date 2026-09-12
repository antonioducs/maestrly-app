import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SharedKnowledgeDocument } from '../../src/shared/memory'
import { chunkSharedKnowledge } from '../../src/main/memory/shared-knowledge/chunker'
import { discoverSharedKnowledge } from '../../src/main/memory/shared-knowledge/discovery'
import { parseSharedKnowledgeDocument } from '../../src/main/memory/shared-knowledge/parser'

function parse(relativePath: string, raw: string): SharedKnowledgeDocument {
  return parseSharedKnowledgeDocument({ root: '/repository', relativePath, raw, modifiedAt: 123 })
}

function document(content: string, startLine = 1): SharedKnowledgeDocument {
  return {
    id: 'doc',
    root: '/repository',
    relativePath: '.agents/knowledge/reference/doc.md',
    title: 'Document',
    content,
    type: 'reference',
    status: 'active',
    scope: '',
    tags: [],
    supersedes: [],
    alwaysApply: false,
    contentHash: 'hash',
    modifiedAt: 123,
    provenance: { repo: '/repository', path: '.agents/knowledge/reference/doc.md', startLine, endLine: 999 },
    warnings: [],
    eligibleForContext: true,
  }
}

describe('shared knowledge frontmatter parser', () => {
  it('applies safe defaults and derives provenance when frontmatter is absent', () => {
    const parsed = parse('decision/release-policy.md', '# Release policy\n\nShip only signed tags.\n')

    expect(parsed).toMatchObject({
      id: 'decision/release-policy',
      relativePath: 'decision/release-policy.md',
      title: 'Release policy',
      content: '# Release policy\n\nShip only signed tags.\n',
      type: 'decision',
      status: 'active',
      scope: '',
      tags: [],
      supersedes: [],
      alwaysApply: false,
      modifiedAt: 123,
      provenance: { heading: 'Release policy', startLine: 1, endLine: 4 },
      warnings: [],
      eligibleForContext: true,
    })
    expect(parsed.contentHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('normalizes CRLF and degrades malformed values to defaults with actionable warnings', () => {
    const raw = [
      '---',
      'id: ""',
      'type: preference',
      'status: archived',
      'scope: true',
      'tags: alpha',
      'supersedes: [old, old, " next "]',
      'always_apply: "true"',
      'id: usable',
      'not valid frontmatter',
      '---',
      '# Heading',
      'Body',
    ].join('\r\n')

    const parsed = parse('lesson/malformed.md', raw)

    expect(parsed).toMatchObject({
      id: 'usable',
      title: 'Heading',
      content: '# Heading\nBody',
      type: 'lesson',
      status: 'active',
      scope: '',
      tags: [],
      supersedes: ['old', 'next'],
      alwaysApply: false,
      provenance: { heading: 'Heading', startLine: 12, endLine: 13 },
      eligibleForContext: false,
    })
    expect(parsed.warnings).toEqual(
      expect.arrayContaining([
        'duplicate frontmatter key: id',
        'invalid frontmatter at line 10',
        'invalid type: preference',
        'invalid status: archived',
        'scope must be a string',
        'tags must be a string array',
        'always_apply must be boolean',
      ])
    )
  })

  it('treats an unclosed frontmatter fence as content and makes the document ineligible', () => {
    const raw = '---\nid: hidden\n# Visible heading'
    const parsed = parse('reference/fallback.md', raw)

    expect(parsed).toMatchObject({
      id: 'reference/fallback',
      title: 'Visible heading',
      content: raw,
      warnings: ['frontmatter is not closed'],
      eligibleForContext: false,
      provenance: { startLine: 3, endLine: 3 },
    })
  })
})

describe('shared knowledge chunker', () => {
  it('chunks by headings, normalizes line endings, and keeps inclusive source lines', () => {
    const chunks = chunkSharedKnowledge(document('# First\r\none\r\n## Second\r\nthree', 10))

    expect(chunks).toEqual([
      {
        id: 'doc:0',
        documentId: 'doc',
        heading: 'First',
        content: '# First\none',
        startLine: 10,
        endLine: 11,
        ordinal: 0,
      },
      {
        id: 'doc:1',
        documentId: 'doc',
        heading: 'Second',
        content: '## Second\nthree',
        startLine: 12,
        endLine: 13,
        ordinal: 1,
      },
    ])
  })

  it('splits oversized sections only at line boundaries and carries the section heading', () => {
    const longLine = 'x'.repeat(3_990)
    const chunks = chunkSharedKnowledge(document(`# Big\n${longLine}\ntail`, 20))

    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toMatchObject({
      heading: 'Big',
      content: `# Big\n${longLine}`,
      startLine: 20,
      endLine: 21,
      ordinal: 0,
    })
    expect(chunks[1]).toMatchObject({
      heading: 'Big',
      content: 'tail',
      startLine: 22,
      endLine: 22,
      ordinal: 1,
    })
  })

  it('keeps chunk lines aligned when standard frontmatter leaves a blank line before the heading', () => {
    const raw = [
      '---',
      'id: doc',
      'type: decision',
      'status: active',
      'always_apply: false',
      '---',
      '',
      '# Title',
      '',
      'Body',
      '',
    ].join('\n')
    const parsed = parse('.agents/knowledge/decision/doc.md', raw)
    const titleChunk = chunkSharedKnowledge(parsed).find((chunk) => chunk.heading === 'Title')

    expect(titleChunk?.startLine).toBe(8)
  })
})

describe('shared knowledge discovery', () => {
  let root: string

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'shared-knowledge-')))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function writeKnowledge(relativePath: string, raw: string): void {
    const target = path.join(root, '.agents', 'knowledge', relativePath)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, raw)
  }

  function valid(id: string, title: string): string {
    return `---\nid: ${id}\ntype: reference\nstatus: active\n---\n# ${title}\n`
  }

  it('discovers only Markdown below .agents/knowledge in stable path order', async () => {
    writeFileSync(path.join(root, 'outside.md'), '# Outside\n')
    mkdirSync(path.join(root, '.agents'), { recursive: true })
    writeFileSync(path.join(root, '.agents', 'also-outside.md'), '# Also outside\n')
    writeKnowledge('zeta.md', valid('zeta', 'Zeta'))
    writeKnowledge('alpha/02.md', valid('alpha-2', 'Alpha two'))
    writeKnowledge('alpha/01.MD', valid('alpha-1', 'Alpha one'))
    writeKnowledge('alpha/ignored.txt', '# Not Markdown\n')

    const result = await discoverSharedKnowledge(root)

    expect(result.documents.map((entry) => entry.relativePath)).toEqual([
      '.agents/knowledge/alpha/01.MD',
      '.agents/knowledge/alpha/02.md',
      '.agents/knowledge/zeta.md',
    ])
    expect(result.documents.map((entry) => entry.id)).toEqual(['alpha-1', 'alpha-2', 'zeta'])
    expect(result.warnings).toEqual([])
  })

  it.skipIf(process.platform === 'win32')(
    'rejects root and nested symlinks without reading outside the jail',
    async () => {
      const outside = path.join(root, 'outside')
      const knowledge = path.join(root, '.agents', 'knowledge')
      mkdirSync(outside)
      mkdirSync(knowledge, { recursive: true })
      writeFileSync(path.join(outside, 'secret.md'), valid('secret', 'Secret'))
      writeKnowledge('safe.md', valid('safe', 'Safe'))
      symlinkSync(path.join(outside, 'secret.md'), path.join(knowledge, 'file-link.md'))
      symlinkSync(outside, path.join(knowledge, 'directory-link'), 'dir')

      const nested = await discoverSharedKnowledge(root)

      expect(nested.documents.map((entry) => entry.id)).toEqual(['safe'])
      expect(nested.warnings).toEqual(
        expect.arrayContaining([
          'symlink ignored: .agents/knowledge/directory-link',
          'symlink ignored: .agents/knowledge/file-link.md',
        ])
      )

      const linkedRepository = path.join(root, 'linked-repository')
      mkdirSync(path.join(linkedRepository, '.agents'), { recursive: true })
      symlinkSync(outside, path.join(linkedRepository, '.agents', 'knowledge'), 'dir')
      const linkedRoot = await discoverSharedKnowledge(linkedRepository)

      expect(linkedRoot.documents).toEqual([])
      expect(linkedRoot.warnings).toEqual(['.agents/knowledge must be a regular directory'])
    }
  )

  it('marks duplicate ids and supersedes cycles ineligible with discovery warnings', async () => {
    writeKnowledge('a.md', '---\nid: a\ntype: decision\nsupersedes: [b]\n---\n# A\n')
    writeKnowledge('b.md', '---\nid: b\ntype: decision\nsupersedes: [a]\n---\n# B\n')
    writeKnowledge('dupe-one.md', valid('duplicate', 'Duplicate one'))
    writeKnowledge('dupe-two.md', valid('duplicate', 'Duplicate two'))

    const result = await discoverSharedKnowledge(root)

    expect(result.warnings).toEqual(
      expect.arrayContaining(['duplicate shared knowledge id: duplicate', 'supersedes cycle: a -> b -> a'])
    )
    expect(result.documents.filter((entry) => ['a', 'b', 'duplicate'].includes(entry.id))).toSatisfy(
      (documents: SharedKnowledgeDocument[]) => documents.every((entry) => !entry.eligibleForContext)
    )
  })

  it('infers the default type from the directory used by discovery', async () => {
    writeKnowledge('decision/release.md', '# Release\nUse signed tags.\n')

    const result = await discoverSharedKnowledge(root)

    expect(result.documents[0]?.type).toBe('decision')
  })
})
