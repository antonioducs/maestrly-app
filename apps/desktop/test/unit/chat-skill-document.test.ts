import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  createSkillDocument,
  readSkillDocument,
  writeSkillDocument,
  withSkillMutation,
} from '../../src/main/chat/skill-document'

let home: string
let root: string
const original = '---\nname: example\ndescription: Example\nmetadata:\n  unknown: retained\n---\nOriginal body\n'
beforeEach(async () => {
  home = await fsp.mkdtemp(path.join(os.tmpdir(), 'skill-document-test-'))
  root = path.join(home, '.agents', 'skills')
  await createSkillDocument({ root, name: 'example', markdown: original })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fsp.rm(home, { recursive: true, force: true })
})

describe('raw skill documents', () => {
  it('preserves arbitrary frontmatter and bundled files with an atomic manifest write', async () => {
    const resource = path.join(root, 'example', 'assets', 'example.txt')
    await fsp.mkdir(path.dirname(resource))
    await fsp.writeFile(resource, 'asset')
    const before = await readSkillDocument(root, 'example')
    const markdown = original.replace('Original body', 'Changed body')
    await writeSkillDocument({ root, name: 'example', markdown, expectedFingerprint: before.fingerprint })
    expect((await readSkillDocument(root, 'example')).markdown).toBe(markdown)
    expect(await fsp.readFile(resource, 'utf8')).toBe('asset')
    expect(await fsp.readdir(path.join(root, 'example'))).toEqual(expect.arrayContaining(['SKILL.md', 'assets']))
  })
  it('rejects external edits using the private snapshot', async () => {
    const before = await readSkillDocument(root, 'example')
    await fsp.writeFile(path.join(root, 'example', 'SKILL.md'), original + 'External')
    await expect(
      writeSkillDocument({
        root,
        name: 'example',
        markdown: original + 'Remote',
        expectedFingerprint: before.fingerprint,
      })
    ).rejects.toThrow('stale-revision')
    expect((await readSkillDocument(root, 'example')).markdown).toBe(original + 'External')
  })
  it('preserves the original if atomic replacement fails and cleans staging files', async () => {
    const before = await readSkillDocument(root, 'example')
    vi.spyOn(fsp, 'rename').mockRejectedValueOnce(new Error('synthetic rename failure'))
    await expect(
      writeSkillDocument({ root, name: 'example', markdown: original + 'New', expectedFingerprint: before.fingerprint })
    ).rejects.toThrow('synthetic')
    expect((await readSkillDocument(root, 'example')).markdown).toBe(original)
    expect(await fsp.readdir(path.join(root, 'example'))).toEqual(['SKILL.md'])
  })
  it('rejects traversal and a changed frontmatter name', async () => {
    await expect(createSkillDocument({ root, name: '../escape', markdown: original })).rejects.toThrow(
      'invalid-skill-name'
    )
    await expect(
      writeSkillDocument({
        root,
        name: 'example',
        markdown: original.replace('name: example', 'name: renamed'),
        expectedFingerprint: '',
      })
    ).rejects.toThrow('skill-name-mismatch')
    expect((await readSkillDocument(root, 'example')).markdown).toBe(original)
  })
  it('reports symlinked manifests and skill directories as read-only', async () => {
    const outside = path.join(home, 'outside.md')
    await fsp.writeFile(outside, original)
    const manifest = path.join(root, 'example', 'SKILL.md')
    await fsp.rm(manifest)
    await fsp.symlink(outside, manifest)
    const before = await readSkillDocument(root, 'example')
    expect(before.editableReason).toBe('read-only')
    await expect(
      writeSkillDocument({ root, name: 'example', markdown: original + 'New', expectedFingerprint: before.fingerprint })
    ).rejects.toThrow('read-only')
    expect(await fsp.readFile(outside, 'utf8')).toBe(original)
  })
  it('rejects a symlinked managed root on create', async () => {
    const elsewhere = path.join(home, 'elsewhere')
    await fsp.mkdir(elsewhere)
    const linked = path.join(home, 'linked')
    await fsp.symlink(elsewhere, linked, 'dir')
    await expect(createSkillDocument({ root: linked, name: 'example', markdown: original })).rejects.toThrow(
      'read-only'
    )
    expect(await fsp.readdir(elsewhere)).toEqual([])
  })
  it('serializes with package mutations and rejects the replaced manifest', async () => {
    const before = await readSkillDocument(root, 'example')
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const install = withSkillMutation(path.join(root, 'example'), async () => {
      await blocked
      await fsp.writeFile(path.join(root, 'example', 'SKILL.md'), original + 'Installed')
    })
    const write = writeSkillDocument({
      root,
      name: 'example',
      markdown: original + 'Remote',
      expectedFingerprint: before.fingerprint,
    })
    release()
    await install
    await expect(write).rejects.toThrow('stale-revision')
  })
})

it('leaves the original intact when the caller revision changes before commit', async () => {
  const before = await readSkillDocument(root, 'example')
  await expect(
    writeSkillDocument({
      root,
      name: 'example',
      markdown: original + 'Remote',
      expectedFingerprint: before.fingerprint,
      beforeCommit: () => {
        throw new Error('stale-revision')
      },
    })
  ).rejects.toThrow('stale-revision')
  expect((await readSkillDocument(root, 'example')).markdown).toBe(original)
  expect(await fsp.readdir(path.join(root, 'example'))).toEqual(['SKILL.md'])
})

it('returns capped read-only text for oversized existing manifests', async () => {
  await fsp.writeFile(path.join(root, 'example', 'SKILL.md'), original + 'x'.repeat(270000))
  const document = await readSkillDocument(root, 'example')
  expect(document.editableReason).toBe('read-only')
  expect(Buffer.byteLength(document.markdown)).toBeLessThanOrEqual(262144)
})
