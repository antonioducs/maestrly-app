import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  chunkSharedKnowledge,
  discoverSharedKnowledge,
  parseSharedKnowledgeDocument,
} from '../../src/main/memory/shared-knowledge'

let root = ''

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'maestrly-shared-knowledge-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function knowledgeFile(relative: string, content: string): string {
  const file = path.join(root, '.agents', 'knowledge', relative)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
  return file
}

describe('shared knowledge parser', () => {
  it('parses the format emitted by promotion without losing quoted commas or provenance', () => {
    const raw = [
      '---',
      'id: release-decision',
      'type: decision',
      'status: active',
      'scope: "packages/api"',
      'tags: ["release,critical", "api", "api"]',
      'supersedes: [old-release]',
      'always_apply: true',
      '---',
      'Context before the heading.',
      '# Ship safely',
      'Use signed release tags.',
    ].join('\n')

    const document = parseSharedKnowledgeDocument({
      root,
      relativePath: '.agents/knowledge/decision/release.md',
      raw,
      modifiedAt: 123,
    })

    expect(document).toMatchObject({
      id: 'release-decision',
      title: 'Ship safely',
      type: 'decision',
      status: 'active',
      scope: 'packages/api',
      tags: ['release,critical', 'api'],
      supersedes: ['old-release'],
      alwaysApply: true,
      eligibleForContext: true,
      warnings: [],
      modifiedAt: 123,
      provenance: {
        path: '.agents/knowledge/decision/release.md',
        heading: 'Ship safely',
        startLine: 11,
        endLine: 12,
      },
    })
  })

  it('infers the type from a repository-relative .agents/knowledge path', () => {
    const document = parseSharedKnowledgeDocument({
      root,
      relativePath: '.agents/knowledge/constraint/security.md',
      raw: '# Security boundary\nNever follow repository symlinks.',
      modifiedAt: 1,
    })

    expect(document.type).toBe('constraint')
    expect(document.id).toBe('.agents/knowledge/constraint/security')
    expect(document.eligibleForContext).toBe(true)
  })

  it('keeps malformed metadata observable and excludes it from prompt context', () => {
    const document = parseSharedKnowledgeDocument({
      root,
      relativePath: '.agents/knowledge/reference/broken.md',
      raw: [
        '---',
        'id: broken',
        'id: duplicate',
        'status: invented',
        'tags: not-an-array',
        'always_apply: yes',
        'malformed line',
        '---',
        '# Broken metadata',
        'Still visible in the Memory Center.',
      ].join('\n'),
      modifiedAt: 1,
    })

    expect(document.status).toBe('active')
    expect(document.tags).toEqual([])
    expect(document.alwaysApply).toBe(false)
    expect(document.eligibleForContext).toBe(false)
    expect(document.warnings).toEqual(
      expect.arrayContaining([
        'duplicate frontmatter key: id',
        'invalid status: invented',
        'tags must be a string array',
        'always_apply must be boolean',
        'invalid frontmatter at line 7',
      ]),
    )
  })

  it('treats unclosed frontmatter as content and reports the problem', () => {
    const raw = '---\nid: never-closed\n# Heading'
    const document = parseSharedKnowledgeDocument({
      root,
      relativePath: '.agents/knowledge/reference/unclosed.md',
      raw,
      modifiedAt: 1,
    })

    expect(document.content).toBe(raw)
    expect(document.warnings).toContain('frontmatter is not closed')
    expect(document.eligibleForContext).toBe(false)
  })
})

describe('shared knowledge discovery jail', () => {
  it('returns an empty result when the knowledge directory is absent', async () => {
    await expect(discoverSharedKnowledge(root)).resolves.toMatchObject({ documents: [], warnings: [] })
  })

  it.skipIf(process.platform === 'win32')(
    'discovers Markdown deterministically, ignores symlinks/non-Markdown and preserves repo-relative paths',
    async () => {
      knowledgeFile('decision/z-last.md', '# Last\nZ content')
      knowledgeFile('decision/a-first.md', '# First\nA content')
      knowledgeFile('decision/ignored.txt', 'not knowledge')
      const outside = path.join(root, 'outside.md')
      writeFileSync(outside, '# Outside\nsecret')
      symlinkSync(outside, path.join(root, '.agents', 'knowledge', 'decision', 'escape.md'))

      const result = await discoverSharedKnowledge(root)

      expect(result.documents.map((document) => document.relativePath)).toEqual([
        '.agents/knowledge/decision/a-first.md',
        '.agents/knowledge/decision/z-last.md',
      ])
      expect(result.documents.every((document) => document.type === 'decision')).toBe(true)
      expect(result.warnings).toContain('symlink ignored: .agents/knowledge/decision/escape.md')
      expect(result.documents.map((document) => document.content).join('\n')).not.toContain('secret')
    },
  )

  it.skipIf(process.platform === 'win32')('rejects a symlinked .agents/knowledge root', async () => {
    const outside = path.join(root, 'outside-knowledge')
    mkdirSync(outside)
    mkdirSync(path.join(root, '.agents'))
    symlinkSync(outside, path.join(root, '.agents', 'knowledge'))

    const result = await discoverSharedKnowledge(root)

    expect(result.documents).toEqual([])
    expect(result.warnings).toEqual(['.agents/knowledge must be a regular directory'])
  })

  it('marks duplicate ids and supersession cycles ineligible', async () => {
    knowledgeFile(
      'decision/a.md',
      '---\nid: duplicate\ntype: decision\nstatus: active\nsupersedes: [cycle-b]\n---\n# A\nAlpha',
    )
    knowledgeFile('decision/a-copy.md', '---\nid: duplicate\ntype: decision\n---\n# A copy\nDuplicate')
    knowledgeFile(
      'decision/b.md',
      '---\nid: cycle-b\ntype: decision\nstatus: active\nsupersedes: [duplicate]\n---\n# B\nBeta',
    )

    const result = await discoverSharedKnowledge(root)

    expect(result.warnings).toContain('duplicate shared knowledge id: duplicate')
    expect(result.warnings.some((warning) => warning.startsWith('supersedes cycle:'))).toBe(true)
    expect(result.documents.filter((document) => document.id === 'duplicate')).toHaveLength(2)
    expect(result.documents.every((document) => !document.eligibleForContext)).toBe(true)
  })
})

describe('shared knowledge chunking', () => {
  it('chunks by headings and reports source lines even when text precedes the first heading', () => {
    const raw = [
      '---',
      'id: line-map',
      'type: procedure',
      '---',
      'Introductory context.',
      '# Build',
      'Run typecheck.',
      '## Verify',
      'Run unit tests.',
    ].join('\n')
    const document = parseSharedKnowledgeDocument({
      root,
      relativePath: '.agents/knowledge/procedure/build.md',
      raw,
      modifiedAt: 1,
    })

    expect(chunkSharedKnowledge(document)).toEqual([
      {
        id: 'line-map:0',
        documentId: 'line-map',
        content: 'Introductory context.',
        startLine: 5,
        endLine: 5,
        ordinal: 0,
      },
      {
        id: 'line-map:1',
        documentId: 'line-map',
        heading: 'Build',
        content: '# Build\nRun typecheck.',
        startLine: 6,
        endLine: 7,
        ordinal: 1,
      },
      {
        id: 'line-map:2',
        documentId: 'line-map',
        heading: 'Verify',
        content: '## Verify\nRun unit tests.',
        startLine: 8,
        endLine: 9,
        ordinal: 2,
      },
    ])
  })

  it('bounds ordinary chunks while still making progress on a single oversized line', () => {
    const document = parseSharedKnowledgeDocument({
      root,
      relativePath: '.agents/knowledge/reference/large.md',
      raw: `# Large\n${'x'.repeat(4_500)}\n${'y'.repeat(100)}`,
      modifiedAt: 1,
    })
    const chunks = chunkSharedKnowledge(document)

    expect(chunks).toHaveLength(3)
    expect(chunks[0]?.content).toBe('# Large')
    expect(chunks[1]?.content).toHaveLength(4_500)
    expect(chunks[2]?.content).toHaveLength(100)
  })
})
