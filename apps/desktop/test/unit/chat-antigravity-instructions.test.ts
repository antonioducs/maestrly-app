import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { buildAntigravityInstructions } from '../../src/main/chat/antigravity-subscription/session'

const h = vi.hoisted(() => ({ git: vi.fn() }))
vi.mock('../../src/main/git-service', () => ({ gitEnvInfo: h.git }))

let cwd: string

const occurrences = (text: string, needle: string) => text.split(needle).length - 1

const build = (overrides: Partial<Parameters<typeof buildAntigravityInstructions>[0]> = {}) =>
  buildAntigravityInstructions({
    projectId: 'p1',
    cwd,
    conversationId: 'c1',
    mode: 'agent',
    modelId: 'gemini-4-argon',
    ...overrides,
  })

beforeEach(() => {
  freshDb()
  cwd = mkdtempSync(path.join(os.tmpdir(), 'antigravity-instructions-'))
  writeFileSync(path.join(cwd, 'AGENTS.md'), 'PROJECT_RULE_SENTINEL')
  h.git.mockResolvedValue({ branch: 'feature-branch', dirty: false })
})

afterEach(() => {
  closeDb()
  rmSync(cwd, { recursive: true, force: true })
})

describe('Antigravity instructions', () => {
  it.each(['gemini-4-argon', 'gemini-3.1-pro'])(
    'carry the project instructions and the subagent catalog the base layout leaves to the runtime (%s)',
    async (modelId) => {
      const { instructions, agents } = await build({ modelId })
      expect(instructions).toContain('PROJECT_RULE_SENTINEL')
      expect(agents.map((agent) => agent.name)).toContain('explore')
      expect(instructions).toContain('Available Maestrly agents:\n- explore')
      // Separate headings keep the catalogs from reading as part of the project's AGENTS.md.
      expect(instructions).toMatch(/PROJECT_RULE_SENTINEL\n\n# (?:Skills|Subagents)\n/)
      expect(instructions).toContain('\n\n# Subagents\nMaestrly can delegate')
      expect(instructions).toMatch(/\n\n# Maestrly on Antigravity\nYou are running inside Maestrly/)
      expect(occurrences(instructions, '# Durable project memory')).toBe(1)
    }
  )

  it('apply the Gemini profile to Gemini models and the default style to the others', async () => {
    const argon = await build({ modelId: 'gemini-4-argon' })
    expect(argon.instructions).toContain('# Errors and persistence')
    expect(argon.instructions).not.toContain('Be concise, direct and objective')
    const pro = await build({ modelId: 'gemini-3.1-pro' })
    expect(pro.instructions).not.toContain('# Errors and persistence')
    expect(pro.instructions).toContain('Be concise, direct and objective')
  })

  it('keep the date and git state out of the hashed contract', async () => {
    const clean = await build()
    h.git.mockResolvedValue({ branch: 'feature-branch', dirty: true })
    const dirty = await build()
    expect(clean.instructions).not.toContain("Today's date")
    expect(clean.instructions).not.toContain('feature-branch')
    expect(dirty.instructionHash).toBe(clean.instructionHash)
    expect(clean.environment).toMatch(
      /^Today's date: \d{4}-\d{2}-\d{2}\. Project directory: .+\. Git branch: feature-branch \(clean\)\.$/
    )
    expect(dirty.environment).toContain('(uncommitted changes)')
  })

  it('restate the mode, the tools and the project path for resumed sessions', async () => {
    const { turnReminder } = await build({ mode: 'plan' })
    expect(turnReminder).toContain('Maestrly mode: plan.')
    expect(turnReminder).toContain('<maestrly_tools>')
    expect(turnReminder).toContain(cwd)
  })

  it('let Maestrly instructions take precedence over the native Antigravity agent prompt', async () => {
    const { instructions } = await build()
    expect(instructions).toContain('Antigravity adds its own agent instructions')
    expect(instructions).toContain('Use only the tools listed in <maestrly_tools>')
  })

  it('compose a standalone chat as a general assistant with personal memory only', async () => {
    const { instructions } = await build({ projectId: null })
    expect(instructions).toContain('general assistant inside the Maestrly app')
    expect(instructions).not.toContain('coding assistant inside the Maestrly app')
    expect(instructions).not.toContain('PROJECT_RULE_SENTINEL')
    expect(occurrences(instructions, '# Personal chat memory')).toBe(1)
    expect(instructions).not.toContain('# Durable project memory')
  })
})
