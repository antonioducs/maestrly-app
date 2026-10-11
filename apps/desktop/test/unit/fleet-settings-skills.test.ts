import { fleetSettingsSkillsSchema, fleetSettingsSkillDocumentSchema } from '@maestrly/bot-fleet-protocol'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { gzipSync } from 'node:zlib'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { freshDb, closeDb } from '../helpers/db'
import {
  createSkillSettingsService,
  type FleetSkillSettingsService,
} from '../../src/main/fleet/instance/settings/skills'
import {
  createSkillGroup,
  listSkillGroups,
  setSkillEnabledGlobal,
  updateSkillGroup,
} from '../../src/main/chat/skill-state'
import { installSkillFiles } from '../../src/main/chat/skills-registry'

let home: string
let service: FleetSkillSettingsService
const markdown = '---\nname: example\ndescription: Example skill\ncustom: preserved\n---\nBody\n'
beforeEach(async () => {
  freshDb()
  home = await fsp.mkdtemp(path.join(os.tmpdir(), 'fleet-settings-skills-'))
  service = createSkillSettingsService(home)
})
afterEach(async () => {
  vi.unstubAllGlobals()
  closeDb()
  await fsp.rm(home, { recursive: true, force: true })
})

it('creates and edits raw manifests without losing unknown fields or resources', async () => {
  const created = await service.createSkill({ name: 'example', markdown })
  expect(created).toMatchObject({ editable: true, editableReason: 'managed', markdown, source: 'local' })
  expect(created.revision).toMatch(/^[0-9a-f-]{36}$/)
  const updated = await service.writeSkill({
    name: 'example',
    markdown: markdown + 'New',
    expectedRevision: created.revision,
  })
  expect(updated.markdown).toBe(markdown + 'New')
  expect(updated.revision).not.toBe(created.revision)
  await expect(
    service.writeSkill({ name: 'example', markdown, expectedRevision: created.revision })
  ).rejects.toMatchObject({ status: 409 })
})

it('rejects a stale revision after external filesystem changes without a preceding read', async () => {
  const created = await service.createSkill({ name: 'example', markdown })
  await fsp.writeFile(path.join(home, '.agents/skills/example/SKILL.md'), markdown + 'External')
  await expect(
    service.writeSkill({ name: 'example', markdown: markdown + 'Remote', expectedRevision: created.revision })
  ).rejects.toMatchObject({ status: 409 })
  expect((await service.skill({ name: 'example' })).markdown).toBe(markdown + 'External')
})

it('detects local enablement and imported package mutations', async () => {
  const created = await service.createSkill({ name: 'example', markdown })
  setSkillEnabledGlobal('example', false)
  await expect(
    service.writeSkill({ name: 'example', markdown, expectedRevision: created.revision })
  ).rejects.toMatchObject({ status: 409 })
  const disabled = await service.skill({ name: 'example' })
  await installSkillFiles({
    name: 'example',
    root: path.join(home, '.agents/skills'),
    source: 'fleet',
    files: [{ path: 'SKILL.md', data: Buffer.from(markdown + 'Imported'), executable: false }],
  })
  await expect(
    service.writeSkill({ name: 'example', markdown, expectedRevision: disabled.revision })
  ).rejects.toMatchObject({ status: 409 })
  expect((await service.skill({ name: 'example' })).enabled).toBe(false)
})

it('lists global alternative roots as read-only and does not disclose filesystem paths', async () => {
  const dir = path.join(home, '.claude/skills/example')
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, 'SKILL.md'), markdown)
  const result = await service.skills({})
  expect(result.skills).toHaveLength(1)
  expect(result.skills[0]).toMatchObject({ editable: false, editableReason: 'read-only' })
  expect(JSON.stringify(result)).not.toContain(home)
  await expect(
    service.removeSkill({ name: 'example', expectedRevision: result.skills[0].revision })
  ).rejects.toMatchObject({ status: 400 })
})

it('serializes concurrent writes so only one succeeds', async () => {
  const created = await service.createSkill({ name: 'example', markdown })
  const results = await Promise.allSettled(
    ['One', 'Two'].map((suffix) =>
      service.writeSkill({ name: 'example', markdown: markdown + suffix, expectedRevision: created.revision })
    )
  )
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
})

it('preserves group descriptions and rejects stale group edits from local callers', async () => {
  const local = createSkillGroup({ name: 'Original', description: 'Keep this', skills: ['example'] })
  const before = await service.skillGroups({})
  const edited = await service.updateSkillGroup({
    id: local.group!.id,
    expectedRevision: before.revision,
    name: 'Renamed',
    skills: ['example'],
  })
  expect(listSkillGroups()[0].description).toBe('Keep this')
  updateSkillGroup(local.group!.id, { name: 'Local edit' })
  await expect(
    service.removeSkillGroup({ id: local.group!.id, expectedRevision: edited.revision })
  ).rejects.toMatchObject({ status: 409 })
})

function libraryResponse(name = 'example'): Response {
  const data = Buffer.from(markdown.replace('name: example', 'name: ' + name) + 'Library')
  const header = Buffer.alloc(512)
  header.write('repo/skills/example/SKILL.md')
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124)
  header.write('0', 156)
  header.write('ustar\0' + '00', 257)
  const archive = gzipSync(Buffer.concat([header, data, Buffer.alloc(((512 - (data.length % 512)) % 512) + 1024)]))
  return new Response(new Uint8Array(archive))
}

it('requires explicit overwrite and the current revision to replace a library skill', async () => {
  const created = await service.createSkill({ name: 'example', markdown })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => libraryResponse())
  )
  const request = { source: 'synthetic/library', id: 'synthetic/library/example' }
  await expect(service.installSkill(request)).rejects.toMatchObject({ status: 409, code: 'CONFLICT' })
  expect((await service.skill({ name: 'example' })).markdown).toBe(markdown)
  await service.installSkill({ ...request, overwrite: true, expectedRevision: created.revision })
  expect((await service.skill({ name: 'example' })).markdown).toBe(markdown + 'Library')
  await expect(
    service.installSkill({ ...request, overwrite: true, expectedRevision: created.revision })
  ).rejects.toMatchObject({ status: 409, code: 'CONFLICT' })
})

it('preserves external edits and bundled files when the revision changes during download', async () => {
  const created = await service.createSkill({ name: 'example', markdown })
  const dir = path.join(home, '.agents/skills/example')
  await fsp.writeFile(path.join(dir, 'resource.txt'), 'Keep')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      await fsp.writeFile(path.join(dir, 'SKILL.md'), markdown + 'External')
      return libraryResponse()
    })
  )
  await expect(
    service.installSkill({
      source: 'synthetic/library',
      id: 'example',
      overwrite: true,
      expectedRevision: created.revision,
    })
  ).rejects.toMatchObject({ status: 409, code: 'CONFLICT' })
  expect(await fsp.readFile(path.join(dir, 'SKILL.md'), 'utf8')).toBe(markdown + 'External')
  expect(await fsp.readFile(path.join(dir, 'resource.txt'), 'utf8')).toBe('Keep')
})

it('rejects a mismatched manifest target and failed download without replacing files', async () => {
  const created = await service.createSkill({ name: 'example', markdown })
  const request = {
    source: 'synthetic/library',
    id: 'example',
    overwrite: true,
    expectedRevision: created.revision,
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => libraryResponse('different'))
  )
  await expect(service.installSkill(request)).rejects.toMatchObject({ status: 400, code: 'INVALID_REQUEST' })
  expect((await service.skill({ name: 'example' })).markdown).toBe(markdown)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('download-failed')
    })
  )
  await expect(service.installSkill(request)).rejects.toMatchObject({ status: 400 })
  expect((await service.skill({ name: 'example' })).markdown).toBe(markdown)
  expect(await fsp.readdir(path.join(home, '.agents/skills'))).toEqual(['example'])
})

it('refuses library replacement of read-only global skills', async () => {
  const dir = path.join(home, '.claude/skills/example')
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, 'SKILL.md'), markdown)
  const current = await service.skill({ name: 'example' })
  const fetch = vi.fn(async () => libraryResponse())
  vi.stubGlobal('fetch', fetch)
  await expect(
    service.installSkill({
      source: 'synthetic/library',
      id: 'example',
      overwrite: true,
      expectedRevision: current.revision,
    })
  ).rejects.toMatchObject({ status: 400 })
  expect(fetch).not.toHaveBeenCalled()
  expect(await fsp.readFile(path.join(dir, 'SKILL.md'), 'utf8')).toBe(markdown)
})

it('lists and edits imported names beginning with an underscore', async () => {
  const text = markdown.replace('name: example', 'name: _example')
  await installSkillFiles({
    name: '_example',
    root: path.join(home, '.agents/skills'),
    source: 'fleet',
    files: [{ path: 'SKILL.md', data: Buffer.from(text), executable: false }],
  })
  const list = await service.skills({})
  expect(list.skills).toHaveLength(1)
  expect(list.skills[0].name).toBe('_example')
  const document = await service.skill({ name: '_example' })
  const saved = await service.writeSkill({
    name: '_example',
    markdown: text + 'Revised',
    expectedRevision: document.revision,
  })
  expect(saved.markdown).toContain('Revised')
})

it('bounds long summary descriptions while preserving the complete document', async () => {
  const text = markdown.replace('description: Example skill', 'description: ' + 'x'.repeat(5000))
  const created = await service.createSkill({ name: 'example', markdown: text })
  expect(fleetSettingsSkillDocumentSchema.safeParse(created).success).toBe(true)
  expect(created.description).toHaveLength(4096)
  expect(created.markdown).toBe(text)
  expect(fleetSettingsSkillsSchema.safeParse(await service.skills({})).success).toBe(true)
})
