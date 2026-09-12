import { describe, it, expect, beforeEach, vi } from 'vitest'

/** Read OpenCode history through its official session-list and export commands. Mock execCli to verify exact native session ID selection and directory filtering without opening its SQLite database or running the real binary. */

const h = vi.hoisted(() => ({ execCli: vi.fn() }))

vi.mock('../../src/main/platform', async (orig) => {
  const actual = await orig<typeof import('../../src/main/platform')>()
  return { ...actual, execCli: h.execCli, whichBin: () => '/usr/bin/opencode' }
})

import { readTranscript } from '../../src/main/transcript-reader'

const CWD = '/work/a' // Missing path makes realCwd preserve the literal directory used by the mock.

// Two sessions share cwd; ses_new is newer. Ignore the third session in another directory.
const SESSIONS = [
  { id: 'ses_old', directory: CWD, updated: 1000, created: 900 },
  { id: 'ses_new', directory: CWD, updated: 2000, created: 1500 },
  { id: 'ses_other', directory: '/work/b', updated: 3000, created: 2900 },
]
const EXPORTS: Record<string, unknown> = {
  ses_old: {
    messages: [
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'old greeting' }] },
      {
        info: { role: 'assistant' },
        parts: [{ type: 'text', text: 'OLD response' }],
      },
    ],
  },
  ses_new: {
    messages: [
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'new greeting' }] },
      {
        info: { role: 'assistant' },
        parts: [{ type: 'reasoning' }, { type: 'text', text: 'NEW response' }],
      },
    ],
  },
}

beforeEach(() => {
  h.execCli.mockReset()
  h.execCli.mockImplementation(async (_bin: string, args: string[]) => {
    if (args[0] === 'session' && args[1] === 'list') return { stdout: JSON.stringify(SESSIONS), stderr: '' }
    if (args[0] === 'export')
      return {
        stdout: JSON.stringify(EXPORTS[args[1]] ?? { messages: [] }),
        stderr: '',
      }
    return { stdout: '', stderr: '' }
  })
})

describe('transcript-reader — opencode (#329)', () => {
  it('reads the exact native session ID rather than the newest session', async () => {
    const turns = await readTranscript('opencode', CWD, 'conv-1', {
      cliSessionId: 'ses_old',
    })
    expect(turns).toEqual([
      { role: 'user', text: 'old greeting' },
      { role: 'assistant', text: 'OLD response' },
    ])
  })

  it('import requires the exact ID and never falls back to another session in the directory', async () => {
    await expect(
      readTranscript('opencode', CWD, 'conv-1', {
        cliSessionId: 'ses_sumiu',
        requireExactSession: true,
      })
    ).resolves.toEqual([])
    await expect(
      readTranscript('opencode', CWD, 'conv-1', {
        requireExactSession: true,
      })
    ).resolves.toEqual([])
  })

  it('does not import an exact session belonging to another directory', async () => {
    await expect(
      readTranscript('opencode', CWD, 'conv-1', {
        cliSessionId: 'ses_other',
        requireExactSession: true,
      })
    ).resolves.toEqual([])
  })

  it('best effort: command failure returns [] or null without throwing', async () => {
    h.execCli.mockRejectedValue(new Error('opencode not found'))
    expect(await readTranscript('opencode', CWD, 'conv-1')).toEqual([])
    expect(
      await readTranscript('opencode', CWD, 'conv-1', {
        cliSessionId: 'ses_new',
      })
    ).toEqual([])
  })
})
