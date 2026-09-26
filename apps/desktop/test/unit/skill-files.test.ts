import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { freshDb, closeDb } from '../helpers/db'
import { getAppSetting } from '../../src/main/store'
import { FLEET_PROVISIONING_LIMITS as limits } from '@maestrly/bot-fleet-protocol'
import { packageSkillDirectory, measureSkillDirectory } from '../../src/main/chat/skill-package'
import {
  installSkillFiles,
  removeGlobalSkill,
  skillFilesProblem,
  skillFilesDigest,
  type SkillFile,
} from '../../src/main/chat/skills-registry'

let root = ''
const file = (path: string, text = 'body', executable = false): SkillFile => ({
  path,
  data: Buffer.from(text),
  executable,
})
beforeEach(async () => {
  freshDb()
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'skill-files-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  closeDb()
  await fsp.rm(root, { recursive: true, force: true })
})

describe('skill file packaging', () => {
  it('follows a linked root, preserves executability and skips ignored files and nested links', async () => {
    const dir = path.join(root, 'original')
    for (const rel of ['scripts', '.git', 'node_modules', '__pycache__'])
      await fsp.mkdir(path.join(dir, rel), { recursive: true })
    for (const rel of [
      'SKILL.md',
      'scripts/run.sh',
      '.git/config',
      '.DS_Store',
      'node_modules/x.js',
      '__pycache__/x.py',
    ])
      await fsp.writeFile(path.join(dir, rel), 'body')
    await fsp.chmod(path.join(dir, 'scripts/run.sh'), 0o755)
    await fsp.symlink(path.join(dir, 'SKILL.md'), path.join(dir, 'nested-link'))
    await fsp.symlink(dir, path.join(dir, 'nested-directory'))
    const linked = path.join(root, 'linked')
    await fsp.symlink(dir, linked)
    const files = await packageSkillDirectory(linked)
    expect(files).toEqual([file('SKILL.md'), file('scripts/run.sh', 'body', true)])
    expect(await measureSkillDirectory(linked)).toEqual({ files: 2, bytes: 8, scripts: true, problem: null })
  })
  it('reports a missing root SKILL.md and too many files consistently', async () => {
    expect((await measureSkillDirectory(root)).problem).toBe('no-skill-md')
    await expect(packageSkillDirectory(root)).rejects.toThrow('no-skill-md')
    await fsp.writeFile(path.join(root, 'SKILL.md'), 'body')
    await Promise.all(Array.from({ length: 400 }, (_, i) => fsp.writeFile(path.join(root, 'f' + i), 'x')))
    expect((await measureSkillDirectory(root)).problem).toBe('too-many-files')
    await expect(packageSkillDirectory(root)).rejects.toThrow('too-many-files')
  })
  it('measures oversized files before reading their contents', async () => {
    await fsp.writeFile(path.join(root, 'SKILL.md'), 'body')
    const handle = await fsp.open(path.join(root, 'large'), 'w')
    await handle.truncate(limits.skillFileBytesMax + 1)
    await handle.close()
    expect((await measureSkillDirectory(root)).problem).toBe('too-large')
    await expect(packageSkillDirectory(root)).rejects.toThrow('too-large')
  })
})

describe('skill file validation and digest', () => {
  it('rejects unsafe paths, duplicates, absent manifests and limit violations', () => {
    const valid = [file('SKILL.md'), file('scripts/run.sh')]
    expect(skillFilesProblem(valid)).toBeNull()
    for (const name of [
      '../x',
      '/abs',
      'a/../b',
      '.hidden/x',
      'a/.hidden',
      'a\\b',
      '',
      'a//b',
      'a/./b',
      'a\0b',
      'C:/x',
      'x'.repeat(241),
    ])
      expect(skillFilesProblem([file('SKILL.md'), file(name)])).not.toBeNull()
    expect(skillFilesProblem([file('SKILL.md'), file('SKILL.md')])).not.toBeNull()
    expect(skillFilesProblem([file('readme')])).not.toBeNull()
    expect(skillFilesProblem([])).not.toBeNull()
    expect(skillFilesProblem(Array.from({ length: 401 }, (_, i) => file(i ? 'f' + i : 'SKILL.md')))).not.toBeNull()
    expect(
      skillFilesProblem([{ ...file('SKILL.md'), data: Buffer.alloc(limits.skillFileBytesMax + 1) }])
    ).not.toBeNull()
    expect(
      skillFilesProblem(['SKILL.md', 'a', 'b'].map((name) => ({ ...file(name), data: Buffer.alloc(3 * 1024 * 1024) })))
    ).not.toBeNull()
  })
  it('hashes content, path and executable mode independently of input order', () => {
    const files = [file('SKILL.md'), file('run', 'echo ok', true)]
    expect(skillFilesDigest(files)).toBe(skillFilesDigest([...files].reverse()))
    for (const changed of [
      file('other', 'echo ok', true),
      file('run', 'echo changed', true),
      file('run', 'echo ok', false),
    ])
      expect(skillFilesDigest([files[0], changed])).not.toBe(skillFilesDigest(files))
  })
})

describe('skill file installation', () => {
  it('adds, leaves identical files untouched, updates and removes with fleet provenance', async () => {
    const files = [file('SKILL.md'), file('scripts/run.sh', 'echo ok', true)]
    const input = { name: 'sample', files, source: 'fleet' as const, root }
    const first = await installSkillFiles(input)
    expect(first).toEqual({ outcome: 'added', dir: path.join(root, 'sample') })
    const target = path.join(first.dir, 'SKILL.md')
    const before = await fsp.stat(target)
    expect((await fsp.stat(path.join(first.dir, 'scripts/run.sh'))).mode & 0o777).toBe(0o755)
    expect(before.mode & 0o777).toBe(0o644)
    expect((await installSkillFiles(input)).outcome).toBe('unchanged')
    expect((await fsp.stat(target)).mtimeMs).toBe(before.mtimeMs)
    expect((await installSkillFiles({ ...input, files: [file('SKILL.md', 'changed')] })).outcome).toBe('updated')
    expect(await fsp.readFile(target, 'utf8')).toBe('changed')
    expect(JSON.parse(getAppSetting('chat.skills.installed')!)).toMatchObject({
      sample: { source: 'fleet', scope: 'global', dir: first.dir },
    })
    expect(await removeGlobalSkill('sample', root)).toBe(true)
    expect(await removeGlobalSkill('sample', root)).toBe(false)
    expect(JSON.parse(getAppSetting('chat.skills.installed')!)).toEqual({})
  })
  it('leaves an identical symlinked skill root untouched', async () => {
    const source = path.join(root, 'source')
    const installRoot = path.join(root, 'installed')
    await fsp.mkdir(source)
    await fsp.mkdir(installRoot)
    await fsp.writeFile(path.join(source, 'SKILL.md'), 'body')
    const linked = path.join(installRoot, 'sample')
    await fsp.symlink(source, linked)
    expect(
      (await installSkillFiles({ name: 'sample', files: [file('SKILL.md')], source: 'fleet', root: installRoot }))
        .outcome
    ).toBe('unchanged')
    expect((await fsp.lstat(linked)).isSymbolicLink()).toBe(true)
  })
  it('preserves the installed version on a staging collision', async () => {
    const input = { name: 'sample', files: [file('SKILL.md')], source: 'fleet' as const, root }
    await installSkillFiles(input)
    await expect(
      installSkillFiles({ ...input, files: [file('SKILL.md', 'changed'), file('data/child'), file('data')] })
    ).rejects.toThrow()
    expect(await fsp.readFile(path.join(root, 'sample/SKILL.md'), 'utf8')).toBe('body')
    expect(await fsp.readdir(root)).toEqual(['sample'])
  })
  it('restores the backup when the final rename fails', async () => {
    const input = { name: 'sample', files: [file('SKILL.md')], source: 'fleet' as const, root }
    await installSkillFiles(input)
    const rename = fsp.rename.bind(fsp)
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(from).includes('.tmp-')) throw new Error('synthetic rename failure')
      return rename(from, to)
    })
    await expect(installSkillFiles({ ...input, files: [file('SKILL.md', 'changed')] })).rejects.toThrow(
      'synthetic rename failure'
    )
    expect(await fsp.readFile(path.join(root, 'sample/SKILL.md'), 'utf8')).toBe('body')
    expect(await fsp.readdir(root)).toEqual(['sample'])
  })
  it('refuses names that could escape the install root', async () => {
    for (const name of ['', '../escape', '/absolute', '.']) {
      await expect(installSkillFiles({ name, files: [file('SKILL.md')], source: 'fleet', root })).rejects.toThrow(
        'invalid-skill-name'
      )
      await expect(removeGlobalSkill(name, root)).rejects.toThrow('invalid-skill-name')
    }
  })
})
