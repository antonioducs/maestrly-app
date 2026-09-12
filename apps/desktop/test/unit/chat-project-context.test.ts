import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { freshDb, closeDb } from '../helpers/db'
import { makeWorkspace } from '../helpers/factories'
import { setMemoryEnabled } from '../../src/main/store'
import { buildProjectContext } from '../../src/main/chat/project-context'

/** Canonical context injected into every chat runtime. */
let dir = ''

beforeEach(() => {
  freshDb()
  dir = mkdtempSync(path.join(os.tmpdir(), 'chat-pctx-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  closeDb()
})

describe('buildProjectContext', () => {
  it('prefers AGENTS.md and uses CLAUDE.md only as fallback in the same directory', async () => {
    const ws = makeWorkspace({ path: dir })
    writeFileSync(path.join(dir, 'AGENTS.md'), 'Use TypeScript estrito.')
    writeFileSync(path.join(dir, 'CLAUDE.md'), 'Run tests before committing.')

    const out = await buildProjectContext(ws.id, dir)
    expect(out).toContain('Source: AGENTS.md')
    expect(out).toContain('Use TypeScript estrito.')
    expect(out).not.toContain('Run tests before committing.')

    const nested = path.join(dir, 'nested')
    mkdirSync(nested)
    writeFileSync(path.join(nested, 'CLAUDE.md'), 'Specific fallback.')
    const nestedOut = await buildProjectContext(ws.id, nested)
    expect(nestedOut).toContain('Source: nested/CLAUDE.md\nSpecific fallback.')
  })

  it('no convention files and memory disabled → empty string', async () => {
    const ws = makeWorkspace({ path: dir })
    setMemoryEnabled(ws.id, false)
    expect(await buildProjectContext(ws.id, dir)).toBe('')
  })

  it('truncates a huge convention file', async () => {
    const ws = makeWorkspace({ path: dir })
    setMemoryEnabled(ws.id, false)
    writeFileSync(path.join(dir, 'AGENTS.md'), 'x'.repeat(40_000))

    const out = await buildProjectContext(ws.id, dir)
    expect(out).toContain('… (truncated)')
    expect(out.length).toBeLessThan(40_000)
  })

  it('empty cwd and missing workspace return an empty string without throwing', async () => {
    expect(await buildProjectContext('nope', '')).toBe('')
  })
})
