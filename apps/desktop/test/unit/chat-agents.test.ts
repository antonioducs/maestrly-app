import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listAgents, getAgent } from '../../src/main/chat/agents'

/** Subagents are Markdown files (name/description/model/tools frontmatter and prompt body) in .claude/.agents/agents. */
let dir = ''
const mkAgent = (root: string, file: string, content: string) => {
  mkdirSync(path.join(dir, root), { recursive: true })
  writeFileSync(path.join(dir, root, file), content)
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'chat-agents-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))
// Matching home and cwd isolates fixtures from real user agents.

describe('listAgents', () => {
  it('reads agent frontmatter and body prompts', async () => {
    mkAgent(
      '.claude/agents',
      'reviewer.md',
      '---\nname: Code Reviewer\ndescription: reviews code\nmodel: gpt-5\ntools: Read, Grep, Glob\n---\nReview the diff and identify bugs.'
    )
    const a = (await listAgents(dir, dir)).find((x) => x.name === 'code-reviewer')
    expect(a).toMatchObject({
      description: 'reviews code',
      model: 'gpt-5',
      prompt: 'Review the diff and identify bugs.',
      source: '.claude/agents/reviewer.md',
    })
    expect(a?.tools).toEqual(['read', 'grep', 'glob']) // Normalized to lowercase.
  })

  it('uses filenames for missing names and normalizes underscores', async () => {
    mkAgent('.agents/agents', 'code_review.md', '---\ndescription: searches files\n---\nExplore the codebase.')
    const a = (await listAgents(dir, dir)).find((x) => x.name === 'code-review')
    expect(a).toMatchObject({ name: 'code-review', description: 'searches files' })
    expect(a?.tools).toBeUndefined()
    expect(await getAgent(dir, 'code_review', dir)).toMatchObject({ name: 'code-review' })
  })

  it('project overrides global duplicates, skips bodyless Markdown, and getAgent finds normalized names', async () => {
    mkAgent('.claude/agents', 'empty.md', '---\ndescription: nothing\n---\n   ')
    mkAgent('.claude/agents', 'planner.md', '---\nname: Planner\n---\nCreate a plan.')
    expect((await listAgents(dir, dir)).find((a) => a.name === 'empty')).toBeUndefined()
    expect(await getAgent(dir, 'Planner', dir)).toMatchObject({ name: 'planner', prompt: 'Create a plan.' })
    expect(await getAgent(dir, 'missing', dir)).toBeNull()
  })

  it('normalizes complete agent profiles and categories', async () => {
    mkAgent(
      '.claude/agents',
      'reviewer.md',
      '---\nprovider: openai\nmodel: gpt-5\neffort: HIGH\ncategory: Code Review\n---\nRevise.'
    )
    const agent = (await listAgents(dir, dir)).find((a) => a.name === 'reviewer')
    expect(agent).toMatchObject({
      category: 'code-review',
      profile: { providerId: 'openai', modelId: 'gpt-5', effort: 'high' },
    })
  })

  it('preserves legacy models and diagnoses incomplete profiles', async () => {
    mkAgent('.claude/agents', 'legacy.md', '---\nmodel: legacy-model\n---\nLegacy.')
    mkAgent('.claude/agents', 'inherit.md', '---\nmodel: inherit\n---\nInherit.')
    mkAgent('.claude/agents', 'broken.md', '---\nprovider: openai\nmodel: gpt-5\n---\nBroken.')
    const list = await listAgents(dir, dir)
    expect(list.find((a) => a.name === 'legacy')).toMatchObject({ model: 'legacy-model', legacyModel: 'legacy-model' })
    expect(list.find((a) => a.name === 'inherit')).toMatchObject({ model: 'inherit' })
    expect(list.find((a) => a.name === 'inherit')?.profile).toBeUndefined()
    expect(list.find((a) => a.name === 'broken')?.profileDiagnostics?.[0]?.code).toBe('incomplete-frontmatter')
  })

  it('rejects empty and synthetic efforts but accepts native Ultra', async () => {
    mkAgent('.claude/agents', 'empty.md', '---\nprovider: openai\nmodel: gpt-5\neffort: \n---\nEmpty.')
    mkAgent('.claude/agents', 'off.md', '---\nprovider: openai\nmodel: gpt-5\neffort: off\n---\nOff.')
    mkAgent(
      '.claude/agents',
      'maestrly-ultra.md',
      '---\nprovider: openai\nmodel: gpt-5\neffort: maestrly-ultra\n---\nMaestrly Ultra.'
    )
    mkAgent('.claude/agents', 'ultra.md', '---\nprovider: openai\nmodel: gpt-5\neffort: ultra\n---\nUltra.')
    const list = await listAgents(dir, dir)

    for (const name of ['empty', 'off', 'maestrly-ultra']) {
      const agent = list.find((item) => item.name === name)
      expect(agent?.profile).toBeUndefined()
      expect(agent?.profileDiagnostics?.[0]?.code).toBe(name === 'empty' ? 'incomplete-frontmatter' : 'invalid-effort')
    }
    expect(list.find((item) => item.name === 'ultra')?.profile).toEqual({
      providerId: 'openai',
      modelId: 'gpt-5',
      effort: 'ultra',
    })
  })

  it('returns built-in agents without agent directories', async () => {
    const list = await listAgents(dir, dir)
    expect(list.map((a) => a.name).sort()).toEqual(['explore', 'general-purpose'])
    expect(list.every((a) => a.source === 'built-in')).toBe(true)
    expect(list.find((a) => a.name === 'explore')?.category).toBe('exploration')
    const worker = list.find((a) => a.name === 'general-purpose')
    expect(worker?.category).toBe('implementation')
    expect(worker?.tools).toContain('generate_image')
  })

  it('lets project agents override built-ins', async () => {
    mkAgent('.claude/agents', 'explore.md', '---\ndescription: meu explore\n---\nCustom explore.')
    const list = await listAgents(dir, dir)
    expect(list.find((a) => a.name === 'explore')).toMatchObject({
      description: 'meu explore',
      source: '.claude/agents/explore.md',
    })
    expect(list.some((a) => a.name === 'general-purpose' && a.source === 'built-in')).toBe(true)
  })
})
