import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => h.userData, getVersion: () => 'test' } }))
import { buildExportBundle } from '../../src/main/local-data/data-export'
import { exportOwnedAssets } from '../../src/main/local-data/export-assets'
import { getDb } from '../../src/main/store'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

beforeEach(async () => {
  h.userData = await fs.mkdtemp(path.join(os.tmpdir(), 'local-data-assets-'))
  freshDb()
})
afterEach(async () => {
  vi.restoreAllMocks()
  closeDb()
  await fs.rm(h.userData, { recursive: true, force: true })
})
async function write(relative: string, data = 'asset bytes'): Promise<void> {
  const target = path.join(h.userData, relative)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, data)
}

it('exports image, attachment, notebook, and spill bytes with ownership and integrity, excluding credentials', async () => {
  const workspace = makeWorkspace()
  const conversation = makeConversation(workspace.id)
  const paths = [
    `chat-generated-images/${conversation.id}/generated.png`,
    `chat-attachment-images/${conversation.id}/attachment.png`,
    `workspace-data/${workspace.id}/project-notes/assets/note.png`,
    'chat-tool-output/output.txt',
  ]
  for (const relative of paths) await write(relative)
  await write('credentials.json', 'private token')
  await write(`workspace-data/${workspace.id}/memory-index/private`, 'excluded index')
  const bundle = await buildExportBundle()
  expect(bundle.assets.map((asset) => asset.path).sort()).toEqual(paths.sort())
  for (const asset of bundle.assets) {
    expect(Buffer.from(asset.data, 'base64').toString()).toBe('asset bytes')
    expect(asset.byteSize).toBe(11)
    expect(asset.sha256).toBe(createHash('sha256').update('asset bytes').digest('hex'))
  }
  expect(bundle.assets.find((asset) => asset.path.includes('generated.png'))?.owner).toEqual({
    kind: 'conversation',
    id: conversation.id,
  })
  expect(bundle.assets.find((asset) => asset.path.includes('note.png'))?.owner).toEqual({
    kind: 'workspace',
    id: workspace.id,
  })
  expect(bundle.omissions).toEqual([])
})

it('reports missing referenced images without opening stored paths', async () => {
  const workspace = makeWorkspace()
  const conversation = makeConversation(workspace.id)
  getDb()
    .prepare(`INSERT INTO chat_messages (id, conversation_id, role, parts_json, meta_json, seq, created_at)
    VALUES ('message', ?, 'assistant', ?, '{}', 0, 1)`)
    .run(
      conversation.id,
      JSON.stringify([
        { type: 'generated-image', id: 'part', artifactId: 'missing', name: 'image', mediaType: 'image/png' },
        {
          type: 'file',
          id: 'file',
          artifactId: '../../credentials',
          name: 'file',
          kind: 'image',
          mediaType: 'image/png',
        },
      ])
    )
  const bundle = await buildExportBundle()
  expect(bundle.conversations[0].messages).toHaveLength(1)
  expect(bundle.assets).toEqual([])
  expect(bundle.omissions).toHaveLength(2)
})

it('reports unreadable files and symlinks without exporting their targets', async () => {
  await write('credentials.json', 'private token')
  await write('chat-generated-images/conversation/image.png')
  await fs.symlink(
    path.join(h.userData, 'credentials.json'),
    path.join(h.userData, 'chat-generated-images/conversation/link.png')
  )
  const open = fs.open.bind(fs)
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    if (String(args[0]).endsWith('image.png')) throw new Error('read denied')
    return open(...args)
  })
  const omissions: string[] = []
  expect(await exportOwnedAssets(omissions)).toEqual([])
  expect(omissions).toHaveLength(2)
})

it('retains notebook markdown and reports a referenced missing notebook asset', async () => {
  const workspace = makeWorkspace()
  const root = `workspace-data/${workspace.id}/project-notes`
  await write(
    `${root}/_pages.json`,
    JSON.stringify({ pages: [{ id: 'page', title: 'Design', parentId: null, order: 0 }] })
  )
  await write(`${root}/page.md`, '![Saved](assets/present.png) ![Missing](assets/missing.png)')
  await write(`${root}/assets/present.png`)
  const bundle = await buildExportBundle()
  expect(bundle.projectNotes[0].notes[0].content).toContain('assets/missing.png')
  expect(bundle.assets).toHaveLength(1)
  expect(bundle.omissions).toEqual([`Could not export referenced notebook asset ${root}/assets/missing.png.`])
})

it('does not follow a symlinked app-owned root', async () => {
  await write('private/secret', 'credential')
  await fs.symlink(path.join(h.userData, 'private'), path.join(h.userData, 'chat-attachment-images'))
  const omissions: string[] = []
  expect(await exportOwnedAssets(omissions)).toEqual([])
  expect(omissions).toEqual(['Could not export app-owned asset root chat-attachment-images.'])
})
