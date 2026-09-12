import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { workspaceDataDir } from '../../src/main/app-paths'
import { buildOpenAIProjectContext, buildProjectContext } from '../../src/main/chat/project-context'
import { writeMemory } from '../../src/main/memory-service'
import { setMemoryEnabled } from '../../src/main/store'
import { closeDb, freshDb } from '../helpers/db'
import { makeWorkspace } from '../helpers/factories'

let dir = ''
const workspaceIds: string[] = []

beforeEach(() => {
  freshDb()
  dir = mkdtempSync(path.join(os.tmpdir(), 'chat-openai-pctx-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  for (const workspaceId of workspaceIds.splice(0)) {
    rmSync(workspaceDataDir(workspaceId), { recursive: true, force: true })
  }
  closeDb()
})

function workspaceAt(workspacePath: string): ReturnType<typeof makeWorkspace> {
  const workspace = makeWorkspace({ path: workspacePath })
  workspaceIds.push(workspace.id)
  return workspace
}

describe('canonical project context', () => {
  it('loads root → cwd, records provenance, and uses the nearest file last', async () => {
    const packages = path.join(dir, 'packages')
    const cwd = path.join(packages, 'app')
    mkdirSync(cwd, { recursive: true })
    const workspace = workspaceAt(dir)
    setMemoryEnabled(workspace.id, false)

    writeFileSync(path.join(dir, 'AGENTS.md'), 'Root guidance.')
    writeFileSync(path.join(packages, 'CLAUDE.md'), 'Package fallback guidance.')
    writeFileSync(path.join(cwd, 'AGENTS.md'), 'Ignored same-directory guidance.')
    writeFileSync(path.join(cwd, 'AGENTS.override.md'), 'Closest override guidance.')

    const out = await buildProjectContext(workspace.id, cwd)

    expect(out).toContain('Source: AGENTS.md\nRoot guidance.')
    expect(out).toContain('Source: packages/CLAUDE.md\nPackage fallback guidance.')
    expect(out).toContain('Source: packages/app/AGENTS.override.md\nClosest override guidance.')
    expect(out).not.toContain('Ignored same-directory guidance.')
    expect(out.indexOf('Root guidance.')).toBeLessThan(out.indexOf('Package fallback guidance.'))
    expect(out.indexOf('Package fallback guidance.')).toBeLessThan(out.indexOf('Closest override guidance.'))
  })

  it('ignores empty overrides and uses AGENTS.md before falling back to CLAUDE.md', async () => {
    const workspace = workspaceAt(dir)
    setMemoryEnabled(workspace.id, false)
    writeFileSync(path.join(dir, 'AGENTS.override.md'), '  \n')
    writeFileSync(path.join(dir, 'AGENTS.md'), 'Codex project guidance.')
    writeFileSync(path.join(dir, 'CLAUDE.md'), 'Lower-priority fallback.')

    const out = await buildOpenAIProjectContext(workspace.id, dir)

    expect(out).toContain('Source: AGENTS.md\nCodex project guidance.')
    expect(out).not.toContain('Lower-priority fallback.')
  })

  it('uses the worktree Git root when cwd is outside the workspace path', async () => {
    const workspacePath = path.join(dir, 'original-workspace')
    const repo = path.join(dir, 'external-worktree')
    const cwd = path.join(repo, 'src', 'feature')
    mkdirSync(workspacePath, { recursive: true })
    mkdirSync(path.join(repo, '.git'), { recursive: true })
    mkdirSync(cwd, { recursive: true })
    const workspace = workspaceAt(workspacePath)
    setMemoryEnabled(workspace.id, false)
    writeFileSync(path.join(repo, 'AGENTS.md'), 'Worktree root guidance.')
    writeFileSync(path.join(repo, 'src', 'AGENTS.md'), 'Source tree guidance.')

    const out = await buildOpenAIProjectContext(workspace.id, cwd)

    expect(out).toContain('Source: AGENTS.md\nWorktree root guidance.')
    expect(out).toContain('Source: src/AGENTS.md\nSource tree guidance.')
  })

  it('applies the combined byte limit without splitting UTF-8 and preserves the most specific instruction', async () => {
    const cwd = path.join(dir, 'nested')
    mkdirSync(cwd)
    const workspace = workspaceAt(dir)
    setMemoryEnabled(workspace.id, false)
    writeFileSync(path.join(dir, 'AGENTS.md'), 'é'.repeat(20_000))
    writeFileSync(path.join(cwd, 'AGENTS.md'), 'Guidance beyond the Codex-compatible byte budget.')

    const out = await buildOpenAIProjectContext(workspace.id, cwd)

    expect(out).toContain('… (truncated)')
    expect(out).toContain('Guidance beyond the Codex-compatible byte budget.')
    expect(out.indexOf('… (truncated)')).toBeLessThan(out.indexOf('Guidance beyond the Codex-compatible byte budget.'))
    expect(out).not.toContain('�')
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThan(34_000)
  })

  it('keeps memory out of the stable prefix and assembles it in transient turn context', async () => {
    const workspace = workspaceAt(dir)
    await writeMemory(workspace.id, 'Remember the project release checklist.')

    const out = await buildOpenAIProjectContext(workspace.id, dir)

    expect(out).not.toContain('## Project memory')
    expect(out).not.toContain('Source: Maestrly workspace memory')
    expect(out).not.toContain('Remember the project release checklist.')
  })

  it('exposes the same block through the OpenAI alias and uses fallback instead of combining files from one directory', async () => {
    const cwd = path.join(dir, 'nested')
    mkdirSync(cwd)
    const workspace = workspaceAt(dir)
    setMemoryEnabled(workspace.id, false)
    writeFileSync(path.join(dir, 'AGENTS.md'), 'Root-only guidance.')
    writeFileSync(path.join(cwd, 'AGENTS.md'), 'Legacy AGENTS guidance.')
    writeFileSync(path.join(cwd, 'CLAUDE.md'), 'Legacy CLAUDE guidance.')

    const canonical = await buildProjectContext(workspace.id, cwd)
    await expect(buildOpenAIProjectContext(workspace.id, cwd)).resolves.toBe(canonical)
    expect(canonical).toContain('Source: AGENTS.md\nRoot-only guidance.')
    expect(canonical).toContain('Source: nested/AGENTS.md\nLegacy AGENTS guidance.')
    expect(canonical).not.toContain('Legacy CLAUDE guidance.')
  })
})
