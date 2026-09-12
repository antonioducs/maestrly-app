import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { freshDb, closeDb } from '../helpers/db'
import {
  addUserPrompt,
  listUserPrompts,
  updateUserPrompt,
  removeUserPrompt,
  normalizeCommandName,
  listProjectCommands,
} from '../../src/main/chat/commands'

describe('normalizeCommandName', () => {
  it('strips slashes, lowercases, replaces spaces with hyphens, and removes symbols', () => {
    // Preserve Portuguese input to cover removal of accented characters.
    expect(normalizeCommandName('/Revisar Código!')).toBe('revisar-cdigo')
    expect(normalizeCommandName('  tests  ')).toBe('tests')
    expect(normalizeCommandName('//x')).toBe('x')
  })
})

describe('user prompts (app_settings)', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('round-trips add → list and normalizes the name', () => {
    const p = addUserPrompt({ name: '/Review', description: 'reviews the diff', content: 'Review: $ARGUMENTS' })
    expect(p.name).toBe('review')
    const list = listUserPrompts()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: 'review', description: 'reviews the diff', content: 'Review: $ARGUMENTS' })
  })

  it('rejects empty names and content', () => {
    expect(() => addUserPrompt({ name: '', content: 'x' })).toThrow()
    expect(() => addUserPrompt({ name: 'x', content: '   ' })).toThrow()
  })

  it('updates fields and removes prompts', () => {
    const p = addUserPrompt({ name: 'a', content: 'content' })
    updateUserPrompt(p.id, { name: 'b', content: 'new' })
    expect(listUserPrompts()[0]).toMatchObject({ name: 'b', content: 'new' })
    removeUserPrompt(p.id)
    expect(listUserPrompts()).toHaveLength(0)
  })
})

describe('project commands (.md files on disk)', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'chat-cmd-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads .md files from .agents/commands and .claude/commands and parses frontmatter descriptions', async () => {
    mkdirSync(path.join(dir, '.agents', 'commands'), { recursive: true })
    mkdirSync(path.join(dir, '.claude', 'commands'), { recursive: true })
    writeFileSync(
      path.join(dir, '.agents', 'commands', 'review.md'),
      '---\ndescription: reviews the code\n---\nReview the following.'
    )
    writeFileSync(path.join(dir, '.claude', 'commands', 'tests.md'), 'Write tests.')

    const cmds = await listProjectCommands(dir)
    const byName = Object.fromEntries(cmds.map((c) => [c.name, c]))
    expect(byName.review).toMatchObject({
      description: 'reviews the code',
      content: 'Review the following.',
      source: '.agents/commands/review.md',
    })
    expect(byName.tests).toMatchObject({ content: 'Write tests.', source: '.claude/commands/tests.md' })
  })

  it('prioritizes .agents over .claude for duplicate names and skips empty .md files', async () => {
    mkdirSync(path.join(dir, '.agents', 'commands'), { recursive: true })
    mkdirSync(path.join(dir, '.claude', 'commands'), { recursive: true })
    writeFileSync(path.join(dir, '.agents', 'commands', 'x.md'), 'from agents')
    writeFileSync(path.join(dir, '.claude', 'commands', 'x.md'), 'from claude')
    writeFileSync(path.join(dir, '.agents', 'commands', 'empty.md'), '   ')

    const cmds = await listProjectCommands(dir)
    expect(cmds.filter((c) => c.name === 'x')).toHaveLength(1)
    expect(cmds.find((c) => c.name === 'x')?.content).toBe('from agents')
    expect(cmds.find((c) => c.name === 'empty')).toBeUndefined()
  })

  it('returns an empty list when command directories are absent', async () => {
    expect(await listProjectCommands(dir)).toEqual([])
  })
})
