import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyMigrationSidecars,
  inspectMigrationSidecars,
  MAX_IGNORED_TOTAL_BYTES,
  planMigrationSidecars,
  rollbackMigrationSidecars,
  validateIgnoredSelection,
  verifyMigrationSidecars,
} from '../../src/main/conversation-migration/sidecars'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function mutationToken(mutation: Record<string, unknown>): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        path: mutation.path,
        kind: mutation.kind,
        entry: mutation.entry,
        created: mutation.created,
        before: mutation.beforeContentBase64,
        beforeMode: mutation.beforeMode,
        after: mutation.afterSha256,
        afterMode: mutation.afterMode,
      })
    )
    .digest('hex')
    .slice(0, 24)
}

function planToken(mutations: Array<Record<string, unknown>>): string {
  return createHash('sha256').update(mutations.map(mutationToken).join('\0')).digest('hex').slice(0, 24)
}

let root: string
let source: string
let destination: string
let head: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-sidecars-'))
  source = path.join(root, 'source')
  destination = path.join(root, 'destination')
  await fs.mkdir(source)
  await fs.mkdir(destination)
  git(source, ['init', '-q'])
  git(source, ['config', 'user.email', 'test@test'])
  git(source, ['config', 'user.name', 'Test'])
  git(source, ['config', 'commit.gpgsign', 'false'])
  await fs.writeFile(
    path.join(source, '.gitignore'),
    [
      '.env',
      'cache/',
      'bundle/',
      'parent/*',
      'large.bin',
      'linked',
      '.agents/',
      '.mcp.json',
      '.claude/settings.local.json',
      '.legacy-tool/config.json',
      'opencode.json',
      '.agent-task-*.md',
      '.agent-handoff.md',
      '.maestrly/',
    ].join('\n') + '\n'
  )
  await fs.writeFile(path.join(source, 'README.md'), '# repo\n')
  git(source, ['add', '-A'])
  git(source, ['commit', '-q', '-m', 'init'])
  head = git(source, ['rev-parse', 'HEAD'])
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('conversation migration sidecars', () => {
  it('inventories ignored files without selecting them by default and blocks current symlinks, notes and sidecars', async () => {
    await fs.writeFile(path.join(source, '.env'), 'TOKEN=secret\n')
    await fs.mkdir(path.join(source, 'cache'))
    await fs.writeFile(path.join(source, 'cache', 'data.bin'), 'cache')
    await fs.symlink(path.join(source, 'README.md'), path.join(source, 'linked'))
    await fs.mkdir(path.join(source, '.agents', 'notes'), { recursive: true })
    await fs.writeFile(path.join(source, '.agents', 'notes', '_pages.json'), '{"pages":[]}')
    await fs.mkdir(path.join(source, '.maestrly'), { recursive: true })
    await fs.writeFile(path.join(source, '.maestrly', 'debug-result.json'), '{}')

    const inspected = await inspectMigrationSidecars(source, head)
    expect(inspected.ignored).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '.env', sensitive: true, selectable: true }),
        expect.objectContaining({ path: 'cache', kind: 'directory', selectable: true }),
        expect.objectContaining({ path: 'linked', kind: 'symlink', selectable: false }),
        expect.objectContaining({ path: '.agents', selectable: false }),
        expect.objectContaining({ path: '.maestrly', selectable: false }),
      ])
    )
    expect(await fs.readdir(destination)).toEqual([])
  })

  it('treats legacy CLI configurations and agent files as ordinary ignored files', async () => {
    const filePaths = [
      '.mcp.json',
      '.claude/settings.local.json',
      '.legacy-tool/config.json',
      'opencode.json',
      '.agent-task-legacy.md',
      '.agent-handoff.md',
    ]
    for (const relative of filePaths) {
      const absolute = path.join(source, ...relative.split('/'))
      await fs.mkdir(path.dirname(absolute), { recursive: true })
      await fs.writeFile(absolute, '{}')
    }

    const inspected = await inspectMigrationSidecars(source, head)
    const inventoryPaths = [
      '.mcp.json',
      '.claude',
      '.legacy-tool',
      'opencode.json',
      '.agent-task-legacy.md',
      '.agent-handoff.md',
    ]
    for (const relative of inventoryPaths) {
      expect(inspected.ignored).toContainEqual(expect.objectContaining({ path: relative, selectable: true }))
    }

    const plan = await planMigrationSidecars({
      sourceCwd: source,
      destinationCwd: destination,
      targetOid: head,
      selectedIgnoredPaths: [],
      confirmedSensitivePaths: [],
    })
    expect(plan.mutations).toEqual([])
    await expect(fs.readdir(destination)).resolves.toEqual([])
  })

  it('requires additional confirmation, copies notes and rolls back by hash', async () => {
    await fs.writeFile(path.join(source, '.env'), 'TOKEN=user-secret\n')
    await fs.mkdir(path.join(source, 'cache'))
    await fs.writeFile(path.join(source, 'cache', 'data.bin'), 'cache')
    await fs.mkdir(path.join(source, '.agents', 'notes', 'assets'), { recursive: true })
    await fs.writeFile(path.join(source, '.agents', 'notes', '_pages.json'), '{"pages":[{"id":"p"}]}')
    await fs.writeFile(path.join(source, '.agents', 'notes', 'p.md'), 'note ![](assets/a.png)')
    await fs.writeFile(path.join(source, '.agents', 'notes', 'assets', 'a.png'), Buffer.from([1, 2, 3]))
    await expect(
      applyMigrationSidecars({
        sourceCwd: source,
        destinationCwd: destination,
        targetOid: head,
        selectedIgnoredPaths: ['.env'],
        confirmedSensitivePaths: [],
      })
    ).rejects.toThrow('additional confirmation')
    await expect(fs.readdir(destination)).resolves.toEqual([])

    const applied = await applyMigrationSidecars({
      sourceCwd: source,
      destinationCwd: destination,
      targetOid: head,
      selectedIgnoredPaths: ['.env', 'cache'],
      confirmedSensitivePaths: ['.env'],
    })
    expect(await fs.readFile(path.join(destination, '.env'), 'utf8')).toBe('TOKEN=user-secret\n')
    expect(await fs.readFile(path.join(destination, 'cache', 'data.bin'), 'utf8')).toBe('cache')
    expect(await fs.readFile(path.join(destination, '.agents', 'notes', 'p.md'), 'utf8')).toContain('note')
    expect(await fs.readFile(path.join(source, '.agents', 'notes', 'p.md'), 'utf8')).toContain('note')
    await expect(verifyMigrationSidecars(destination, applied.mutations)).resolves.toBe(true)
    await expect(rollbackMigrationSidecars(destination, applied.mutations)).resolves.toBe(true)
    await expect(fs.stat(path.join(destination, '.env'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(path.join(destination, '.agents', 'notes'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.skipIf(process.platform === 'win32')(
    'preserves a literal backslash without conflating two distinct ignored paths',
    async () => {
      await fs.appendFile(path.join(source, '.gitignore'), 'foo?bar\nfoo/bar\n')
      await fs.mkdir(path.join(source, 'foo'))
      await fs.writeFile(path.join(source, 'foo', '.keep'), 'tracked')
      git(source, ['add', '-f', 'foo/.keep'])
      git(source, ['commit', '-q', '-m', 'track foo parent'])
      head = git(source, ['rev-parse', 'HEAD'])
      await fs.writeFile(path.join(source, 'foo\\bar'), 'literal-backslash')
      await fs.writeFile(path.join(source, 'foo', 'bar'), 'nested-path')

      const inspected = await inspectMigrationSidecars(source, head)
      expect(inspected.ignored).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'foo\\bar', selectable: true }),
          expect.objectContaining({ path: 'foo/bar', selectable: true }),
        ])
      )

      const applied = await applyMigrationSidecars({
        sourceCwd: source,
        destinationCwd: destination,
        targetOid: head,
        selectedIgnoredPaths: ['foo\\bar'],
        confirmedSensitivePaths: [],
      })
      expect(await fs.readFile(path.join(destination, 'foo\\bar'), 'utf8')).toBe('literal-backslash')
      await expect(fs.stat(path.join(destination, 'foo', 'bar'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(applied.mutations).toContainEqual(
        expect.objectContaining({
          path: 'foo\\bar',
          kind: 'ignored',
        })
      )
    }
  )

  it('rejects traversal and preserves externally modified sidecars during rollback', async () => {
    await fs.mkdir(path.join(source, 'cache'))
    await fs.writeFile(path.join(source, 'cache', 'data.bin'), 'cache')
    await expect(
      applyMigrationSidecars({
        sourceCwd: source,
        destinationCwd: destination,
        targetOid: head,
        selectedIgnoredPaths: ['../outside'],
        confirmedSensitivePaths: [],
      })
    ).rejects.toThrow('invalid path')

    const applied = await applyMigrationSidecars({
      sourceCwd: source,
      destinationCwd: destination,
      targetOid: head,
      selectedIgnoredPaths: ['cache'],
      confirmedSensitivePaths: [],
    })
    await fs.writeFile(path.join(destination, 'cache', 'data.bin'), 'alterado fora')
    await expect(rollbackMigrationSidecars(destination, applied.mutations)).resolves.toBe(false)
    await expect(fs.readFile(path.join(destination, 'cache', 'data.bin'), 'utf8')).resolves.toBe('alterado fora')
  })

  it('propagates sensitivity from descendants', async () => {
    await fs.mkdir(path.join(source, 'cache', 'nested'), { recursive: true })
    await fs.writeFile(path.join(source, 'cache', 'nested', 'credentials.json'), '{}')

    const inspected = await inspectMigrationSidecars(source, head)
    expect(inspected.ignored).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'cache', kind: 'directory', sensitive: true, selectable: true }),
      ])
    )
    await expect(
      applyMigrationSidecars({
        sourceCwd: source,
        destinationCwd: destination,
        targetOid: head,
        selectedIgnoredPaths: ['cache'],
        confirmedSensitivePaths: [],
      })
    ).rejects.toThrow('additional confirmation')
  })

  it('rejects destination symlink ancestors and oversized ignored files', async () => {
    await fs.mkdir(path.join(source, 'parent'), { recursive: true })
    await fs.writeFile(path.join(source, 'parent', '.keep'), 'tracked')
    git(source, ['add', '-f', 'parent/.keep'])
    git(source, ['commit', '-q', '-m', 'tracked parent'])
    head = git(source, ['rev-parse', 'HEAD'])
    await fs.writeFile(path.join(source, 'parent', 'data.bin'), 'cache')
    const outside = path.join(root, 'outside')
    await fs.mkdir(outside)
    await fs.symlink(outside, path.join(destination, 'parent'))
    await expect(
      applyMigrationSidecars({
        sourceCwd: source,
        destinationCwd: destination,
        targetOid: head,
        selectedIgnoredPaths: ['parent/data.bin'],
        confirmedSensitivePaths: [],
      })
    ).rejects.toThrow('Unsafe ancestor')
    await expect(fs.readdir(outside)).resolves.toEqual([])

    await fs.rm(path.join(destination, 'parent'))
    await fs.writeFile(path.join(source, 'large.bin'), Buffer.alloc(25 * 1024 * 1024 + 1))
    const inspected = await inspectMigrationSidecars(source, head)
    expect(inspected.ignored).toContainEqual(
      expect.objectContaining({
        path: 'large.bin',
        selectable: false,
        reasonCode: 'unsafe',
      })
    )
  })

  it('enforces the total budget and rejects overlapping ancestor and descendant selections', async () => {
    await fs.mkdir(path.join(source, 'cache'))
    await fs.writeFile(path.join(source, 'cache', 'nested.bin'), 'nested')
    const inspected = await inspectMigrationSidecars(source, head)
    const cache = inspected.ignored.find((entry) => entry.path === 'cache')!

    expect(() =>
      validateIgnoredSelection(
        [cache, { ...cache, path: 'cache/nested.bin', kind: 'file' }],
        ['cache', 'cache/nested.bin'],
        []
      )
    ).toThrow('overlapping paths')

    cache.size = MAX_IGNORED_TOTAL_BYTES + 1
    expect(() => validateIgnoredSelection([cache], ['cache'], [])).toThrow('exceeds 100 MB')
  })

  it('copies legacy notes without deleting the source', async () => {
    await fs.mkdir(path.join(source, '.agents'), { recursive: true })
    await fs.writeFile(path.join(source, '.agents', 'notes.md'), 'legacy note')

    const applied = await applyMigrationSidecars({
      sourceCwd: source,
      destinationCwd: destination,
      targetOid: head,
      selectedIgnoredPaths: [],
      confirmedSensitivePaths: [],
    })
    expect(await fs.readFile(path.join(destination, '.agents', 'notes.md'), 'utf8')).toBe('legacy note')
    expect(await fs.readFile(path.join(source, '.agents', 'notes.md'), 'utf8')).toBe('legacy note')
    expect(applied.mutations).toContainEqual(expect.objectContaining({ path: '.agents/notes.md', kind: 'note' }))
  })

  it('revalidates secrets added to directories after inventory', async () => {
    await fs.mkdir(path.join(source, 'cache'))
    await fs.writeFile(path.join(source, 'cache', 'data.bin'), 'cache')
    let listings = 0
    const readdir = fs.readdir.bind(fs)
    const spy = vi.spyOn(fs, 'readdir').mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
      const result = await (readdir as (...inner: Parameters<typeof fs.readdir>) => ReturnType<typeof fs.readdir>)(
        ...args
      )
      if (String(args[0]) === path.join(source, 'cache')) {
        listings += 1
        if (listings === 2) await fs.writeFile(path.join(source, 'cache', 'credentials.json'), '{}')
      }
      return result as any
    })
    try {
      await expect(
        applyMigrationSidecars({
          sourceCwd: source,
          destinationCwd: destination,
          targetOid: head,
          selectedIgnoredPaths: ['cache'],
          confirmedSensitivePaths: [],
        })
      ).rejects.toThrow('additional confirmation')
      await expect(fs.stat(path.join(destination, 'cache'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      spy.mockRestore()
    }
  })

  it('preserves divergent ignored staging for manual review', async () => {
    await fs.writeFile(path.join(source, '.env'), 'TOKEN=secret\n')
    const args = {
      sourceCwd: source,
      destinationCwd: destination,
      targetOid: head,
      selectedIgnoredPaths: ['.env'],
      confirmedSensitivePaths: ['.env'],
    }
    const plan = await planMigrationSidecars(args)
    const mutation = plan.mutations.find((entry) => entry.path === '.env')!
    const staging = path.join(
      destination,
      `.migration-${mutationToken(mutation as unknown as Record<string, unknown>)}`
    )
    await fs.writeFile(staging, 'TOKEN=externo\n')

    await expect(applyMigrationSidecars(args, plan.mutations)).rejects.toThrow('manual recovery')
    await expect(fs.readFile(staging, 'utf8')).resolves.toBe('TOKEN=externo\n')
  })

  it('resumes deterministic ignored staging without orphaning sensitive copies', async () => {
    await fs.writeFile(path.join(source, '.env'), 'TOKEN=secret\n')
    const args = {
      sourceCwd: source,
      destinationCwd: destination,
      targetOid: head,
      selectedIgnoredPaths: ['.env'],
      confirmedSensitivePaths: ['.env'],
    }
    const plan = await planMigrationSidecars(args)
    const mutation = plan.mutations.find((entry) => entry.path === '.env')!
    const staging = path.join(
      destination,
      `.migration-${mutationToken(mutation as unknown as Record<string, unknown>)}`
    )
    await fs.writeFile(staging, 'TOKEN=secret\n')

    const applied = await applyMigrationSidecars(args, plan.mutations)

    await expect(fs.readFile(path.join(destination, '.env'), 'utf8')).resolves.toBe('TOKEN=secret\n')
    await expect(fs.stat(staging)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(verifyMigrationSidecars(destination, applied.mutations)).resolves.toBe(true)
  })

  it('resumes modern notebook staging after a crash before rename', async () => {
    const sourceNotes = path.join(source, '.agents', 'notes')
    await fs.mkdir(sourceNotes, { recursive: true })
    await fs.writeFile(path.join(sourceNotes, '_pages.json'), '{"pages":[{"id":"p"}]}')
    await fs.writeFile(path.join(sourceNotes, 'p.md'), 'modern note')
    const args = {
      sourceCwd: source,
      destinationCwd: destination,
      targetOid: head,
      selectedIgnoredPaths: [],
      confirmedSensitivePaths: [],
    }
    const plan = await planMigrationSidecars(args)
    const mutation = plan.mutations.find((entry) => entry.kind === 'note')!
    const staging = path.join(
      destination,
      '.agents',
      `.notes-migration-${mutationToken(mutation as unknown as Record<string, unknown>)}`
    )
    await fs.mkdir(path.dirname(staging), { recursive: true })
    await fs.cp(sourceNotes, staging, { recursive: true })

    const applied = await applyMigrationSidecars(args, plan.mutations)

    await expect(fs.readFile(path.join(destination, '.agents', 'notes', 'p.md'), 'utf8')).resolves.toBe('modern note')
    await expect(fs.stat(staging)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(verifyMigrationSidecars(destination, applied.mutations)).resolves.toBe(true)
  })

  it('resumes legacy note staging after a crash before linking', async () => {
    const sourceNotes = path.join(source, '.agents', 'notes.md')
    await fs.mkdir(path.dirname(sourceNotes), { recursive: true })
    await fs.writeFile(sourceNotes, 'legacy note')
    const args = {
      sourceCwd: source,
      destinationCwd: destination,
      targetOid: head,
      selectedIgnoredPaths: [],
      confirmedSensitivePaths: [],
    }
    const plan = await planMigrationSidecars(args)
    const mutation = plan.mutations.find((entry) => entry.kind === 'note')!
    const staging = path.join(
      destination,
      '.agents',
      `.legacy-notes-${mutationToken(mutation as unknown as Record<string, unknown>)}`
    )
    await fs.mkdir(path.dirname(staging), { recursive: true })
    await fs.copyFile(sourceNotes, staging)

    const applied = await applyMigrationSidecars(args, plan.mutations)

    await expect(fs.readFile(path.join(destination, '.agents', 'notes.md'), 'utf8')).resolves.toBe('legacy note')
    await expect(fs.stat(staging)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(verifyMigrationSidecars(destination, applied.mutations)).resolves.toBe(true)
  })

  it('preserves divergent note staging for manual review', async () => {
    const sourceNotes = path.join(source, '.agents', 'notes')
    await fs.mkdir(sourceNotes, { recursive: true })
    await fs.writeFile(path.join(sourceNotes, '_pages.json'), '{"pages":[]}')
    const args = {
      sourceCwd: source,
      destinationCwd: destination,
      targetOid: head,
      selectedIgnoredPaths: [],
      confirmedSensitivePaths: [],
    }
    const plan = await planMigrationSidecars(args)
    const mutation = plan.mutations.find((entry) => entry.kind === 'note')!
    const staging = path.join(
      destination,
      '.agents',
      `.notes-migration-${mutationToken(mutation as unknown as Record<string, unknown>)}`
    )
    await fs.mkdir(staging, { recursive: true })
    await fs.writeFile(path.join(staging, 'foreign.md'), 'do not delete')

    await expect(applyMigrationSidecars(args, plan.mutations)).rejects.toThrow('staging')
    await expect(fs.readFile(path.join(staging, 'foreign.md'), 'utf8')).resolves.toBe('do not delete')
  })

  it('clears residual staging after installation and during rollback without installed sidecars', async () => {
    const sourceNotes = path.join(source, '.agents', 'notes')
    await fs.mkdir(sourceNotes, { recursive: true })
    await fs.writeFile(path.join(sourceNotes, '_pages.json'), '{"pages":[]}')
    const args = {
      sourceCwd: source,
      destinationCwd: destination,
      targetOid: head,
      selectedIgnoredPaths: [],
      confirmedSensitivePaths: [],
    }
    const plan = await planMigrationSidecars(args)
    const mutation = plan.mutations.find((entry) => entry.kind === 'note')!
    const staging = path.join(
      destination,
      '.agents',
      `.notes-migration-${mutationToken(mutation as unknown as Record<string, unknown>)}`
    )
    const installed = path.join(destination, '.agents', 'notes')
    await fs.mkdir(path.dirname(staging), { recursive: true })
    await fs.cp(sourceNotes, staging, { recursive: true })
    await fs.cp(sourceNotes, installed, { recursive: true })

    await applyMigrationSidecars(args, plan.mutations)

    await expect(fs.stat(staging)).rejects.toMatchObject({ code: 'ENOENT' })
    await fs.rm(installed, { recursive: true })
    await fs.cp(sourceNotes, staging, { recursive: true })
    await expect(rollbackMigrationSidecars(destination, plan.mutations)).resolves.toBe(true)
    await expect(fs.stat(staging)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('resumes rollback after a crash with the first sidecar already quarantined', async () => {
    await fs.writeFile(path.join(source, '.env'), 'TOKEN=secret\n')
    await fs.mkdir(path.join(source, 'cache'))
    await fs.writeFile(path.join(source, 'cache', 'data.bin'), 'cache')
    const args = {
      sourceCwd: source,
      destinationCwd: destination,
      targetOid: head,
      selectedIgnoredPaths: ['.env', 'cache'],
      confirmedSensitivePaths: ['.env'],
    }
    const applied = await applyMigrationSidecars(args)
    const reversed = [...applied.mutations].reverse()
    const first = reversed[0]!
    const quarantine = path.join(
      destination,
      `.migration-rollback-${planToken(applied.mutations as unknown as Array<Record<string, unknown>>)}`
    )
    await fs.mkdir(quarantine)
    await fs.rename(
      path.join(destination, ...first.path.split('/')),
      path.join(quarantine, `migrated-${mutationToken(first as unknown as Record<string, unknown>)}`)
    )

    await expect(rollbackMigrationSidecars(destination, applied.mutations)).resolves.toBe(true)

    await expect(fs.stat(path.join(destination, '.env'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(path.join(destination, 'cache'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(quarantine)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
