import path from 'node:path'
import { promises as fs } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  home: `/tmp/maestrly-transcript-reader-codex-${process.pid}`,
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    default: { ...actual, homedir: () => h.home },
    homedir: () => h.home,
  }
})

import { readTranscript } from '../../src/main/transcript-reader'

const sessionsDir = path.join(h.home, '.codex', 'sessions', '2026', '07', '14')
const cwdA = path.join(h.home, 'worktree-a')
const cwdB = path.join(h.home, 'worktree-b')

function sessionMeta(id: string, cwd: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: '2026-07-14T12:00:00.000Z',
    type: 'session_meta',
    payload: {
      id,
      session_id: id,
      cwd,
      originator: 'codex-tui',
      source: 'cli',
      thread_source: 'user',
      ...overrides,
    },
  }
}

function message(role: 'developer' | 'user', text: string): Record<string, unknown> {
  return {
    timestamp: '2026-07-14T12:00:01.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role,
      content: [{ type: 'input_text', text }],
    },
  }
}

async function writeRollout(filenameId: string, lines: Record<string, unknown>[], mtime: number): Promise<string> {
  const file = path.join(sessionsDir, `rollout-test-${filenameId}.jsonl`)
  await fs.writeFile(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8')
  await fs.utimes(file, mtime / 1000, mtime / 1000)
  return file
}

beforeEach(async () => {
  await fs.rm(h.home, { recursive: true, force: true })
  await fs.mkdir(sessionsDir, { recursive: true })
  await fs.mkdir(cwdA, { recursive: true })
  await fs.mkdir(cwdB, { recursive: true })
})

afterAll(async () => {
  await fs.rm(h.home, { recursive: true, force: true })
})

describe('transcript-reader — Codex reading by session ID', () => {
  it('does not switch to the latest sibling conversation in the same cwd', async () => {
    await writeRollout('root-a', [sessionMeta('root-a', cwdA), message('user', 'turno A')], 1_000)
    await writeRollout('root-b', [sessionMeta('root-b', cwdA), message('user', 'turno B')], 2_000)

    await expect(readTranscript('codex', cwdA, 'conv-a', { cliSessionId: 'root-a' })).resolves.toEqual([
      { role: 'user', text: 'turno A' },
    ])
  })

  it('does not import a missing, colliding, or foreign-cwd ID', async () => {
    await writeRollout('root-a', [sessionMeta('root-a', cwdA), message('user', 'turno A')], 1_000)
    await writeRollout('collision', [sessionMeta('other-id', cwdA), message('user', 'collision')], 2_000)

    await expect(readTranscript('codex', cwdB, 'conv', { cliSessionId: 'root-a' })).resolves.toEqual([])
    await expect(readTranscript('codex', cwdA, 'conv', { cliSessionId: 'collision' })).resolves.toEqual([])
    await expect(readTranscript('codex', cwdA, 'conv')).resolves.toEqual([])
  })
})
