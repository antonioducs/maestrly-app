import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { FLEET_FILE_LIMITS, type FleetAttachmentInput } from '@maestrly/bot-fleet-protocol'
import { InstanceInputQueue } from '../../src/main/fleet/instance/queue'
import { projectChatMessages } from '../../src/main/fleet/instance/transcript'
import { imageId } from '../../src/main/fleet/instance/images'
import { attachmentKind, validateAttachments } from '../../src/renderer/lib/fleet/composer'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const pdf = Buffer.from('%PDF-1.7\nsynthetic document')
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const text = '\uFEFFconst greeting = "Olá 世界"\r\n'
const attachment = (kind: FleetAttachmentInput['kind'], bytes: Uint8Array): FleetAttachmentInput => ({
  kind,
  name: kind === 'text' ? 'source.ts' : `file.${kind}`,
  mediaType: kind === 'image' ? 'image/png' : kind === 'pdf' ? 'application/pdf' : 'text/plain',
  dataBase64: Buffer.from(bytes).toString('base64'),
})
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fleet-incoming-'))
  roots.push(root)
  const file = path.join(root, 'queue.json')
  const attachments = path.join(root, 'attachments')
  const queue = new InstanceInputQueue(file, attachments)
  await queue.load()
  return { root, file, attachments, queue }
}
const input = (attachments: FleetAttachmentInput[]) => ({
  idempotencyKey: randomUUID(),
  source: 'owner' as const,
  text: '',
  attachments,
})

describe('incoming fleet documents', () => {
  it('retains permanently rejected documents after restart so the owner can download or remove them', async () => {
    const { queue, file, attachments } = await setup()
    const receipt = await queue.enqueue(input([attachment('pdf', pdf)]))
    await queue.markStarted(receipt.inputId)
    await queue.failAttachment(receipt.inputId, 'pdf-unreadable')
    const restarted = new InstanceInputQueue(file, attachments)
    await restarted.load()
    await restarted.sweepAttachments()
    const item = restarted.list()[0]
    expect(item).toMatchObject({ started: false, attachmentError: 'pdf-unreadable' })
    expect((await restarted.readFile(item.attachments[0].id))?.bytes).toEqual(pdf)
    expect(await restarted.delete(item.id)).toBe('deleted')
    await restarted.sweepAttachments()
    expect(await restarted.readFile(item.attachments[0].id)).toBeNull()
  })
  it('recognizes document extensions with empty MIME and rejects arbitrary binary files', () => {
    for (const [name, kind] of [
      ['REPORT.PDF', 'pdf'],
      ['code.ts', 'text'],
      ['notes.md', 'text'],
      ['archive.zip', null],
    ] as const)
      expect(attachmentKind({ name, type: '', size: 10 })).toBe(kind)
    expect(attachmentKind({ name: 'binary.exe', type: 'application/octet-stream', size: 10 })).toBeNull()
    expect(attachmentKind({ name: 'fake.txt', type: 'application/zip', size: 10 })).toBeNull()
    const file = { name: 'document.pdf', type: '', size: FLEET_FILE_LIMITS.pdfMaxBytes }
    expect(validateAttachments([], [file, file])).toBeNull()
    expect(validateAttachments([file, file], [{ name: 'code.ts', type: '', size: 1 }])).toBe('total')
    expect(validateAttachments([], Array(5).fill({ ...file, size: 1 }))).toBe('pdfCount')
    expect(validateAttachments([], [{ name: 'code.ts', type: '', size: FLEET_FILE_LIMITS.textMaxBytes + 1 }])).toBe(
      'size'
    )
  })
  it('durably preserves mixed attachments, UTF-8 bytes and idempotency across restart', async () => {
    const { queue, file, attachments } = await setup()
    const request = input([attachment('pdf', pdf), attachment('text', Buffer.from(text)), attachment('image', png)])
    const receipt = await queue.enqueue(request)
    const restarted = new InstanceInputQueue(file, attachments)
    await restarted.load()
    expect(await restarted.enqueue(request)).toEqual(receipt)
    const item = restarted.list()[0]
    expect(restarted.refs(item)).toHaveLength(1)
    expect(restarted.fileRefs(item)).toHaveLength(2)
    expect(restarted.fileRefs(item)[0].id).toBe(`q-file-${receipt.inputId}-0`)
    expect(await restarted.readAttachments(item)).toEqual([
      { name: 'file.pdf', kind: 'pdf', mediaType: 'application/pdf', bytes: pdf },
      { name: 'source.ts', kind: 'text', mediaType: 'text/plain', data: text },
      { name: 'file.image', kind: 'image', mediaType: 'image/png', bytes: png },
    ])
    expect(await restarted.readFile(item.attachments[1].id)).toEqual({
      ref: restarted.fileRefs(item)[1],
      bytes: Buffer.from(text),
    })
    expect(await restarted.fileMeta(item.attachments[1].id)).toEqual(restarted.fileRefs(item)[1])
    expect(await restarted.readImage(item.attachments[0].id)).toBeNull()
    await restarted.delete(item.id)
    await restarted.sweepAttachments()
    expect(await restarted.readFile(item.attachments[0].id)).toBeNull()
  })
  it('loads queues written before attachment kind was introduced', async () => {
    const { queue, file, attachments } = await setup()
    await queue.enqueue(input([attachment('image', png)]))
    const saved = JSON.parse(await readFile(file, 'utf8'))
    delete saved.items[0].attachments[0].kind
    await writeFile(file, JSON.stringify(saved))
    const restarted = new InstanceInputQueue(file, attachments)
    await restarted.load()
    expect((await restarted.readAttachments(restarted.list()[0]))[0].kind).toBe('image')
  })
  it('rejects invalid PDF signatures, invalid UTF-8 and null-containing text before queuing', async () => {
    const { queue } = await setup()
    for (const value of [
      attachment('pdf', png),
      attachment('pdf', Buffer.from([0xa5, 0xd0, 0xc4, 0xc6, 0xad])),
      attachment('text', new Uint8Array([0xff])),
      attachment('text', Buffer.from('a\0b')),
    ])
      await expect(queue.enqueue(input([value]))).rejects.toThrow()
    expect(queue.list()).toEqual([])
    await queue.enqueue(input([attachment('text', Buffer.alloc(0))]))
    expect((await queue.readAttachments(queue.list()[0]))[0].data).toBe('')
  })
  it('enforces document counts and byte limits before durable admission', async () => {
    const { queue } = await setup()
    await expect(queue.enqueue(input(Array(5).fill(attachment('pdf', pdf))))).rejects.toThrow()
    await expect(
      queue.enqueue(input([attachment('text', Buffer.alloc(FLEET_FILE_LIMITS.textMaxBytes + 1, 65))]))
    ).rejects.toThrow()
    await expect(
      queue.enqueue(input([attachment('pdf', Buffer.alloc(FLEET_FILE_LIMITS.pdfMaxBytes + 1))]))
    ).rejects.toThrow()
    await expect(queue.enqueue(input(Array(9).fill(attachment('text', Buffer.from('a')))))).rejects.toThrow()
    expect(queue.list()).toEqual([])
  })
  it('rejects mutated files and symlinked queued attachments', async () => {
    const { queue, root, attachments } = await setup()
    await queue.enqueue(input([attachment('text', Buffer.from('abc'))]))
    const item = queue.list()[0]
    const file = path.join(attachments, item.id, '0.txt')
    await writeFile(file, Buffer.from([0xff, 0xff, 0xff]))
    await expect(queue.readAttachments(item)).rejects.toThrow()
    await rm(file)
    const target = path.join(root, 'target.txt')
    await writeFile(target, 'abc')
    await symlink(target, file)
    expect(await queue.readFile(item.attachments[0].id)).toBeNull()
  })
  it('projects document-only native messages with stable ids, including empty text parts', async () => {
    const { queue } = await setup()
    await queue.enqueue(input([attachment('text', Buffer.from(text)), attachment('pdf', pdf)]))
    const queued = queue.list()[0]
    await queue.markStarted(queued.id)
    await queue.mapNativeMessage(queued.id, 'native')
    const message = {
      id: 'native',
      conversationId: 'conversation',
      role: 'user' as const,
      createdAt: Date.now(),
      parts: [
        {
          type: 'file' as const,
          id: 'code',
          name: 'source.ts',
          kind: 'text' as const,
          mediaType: 'text/plain',
          data: text,
        },
        {
          type: 'file' as const,
          id: 'pdf',
          name: 'report.pdf',
          kind: 'pdf' as const,
          mediaType: 'application/pdf',
          artifactId: 'artifact',
          byteSize: pdf.length,
        },
      ],
    }
    const expected = {
      kind: 'user',
      id: queued.itemId,
      text: '',
      images: [],
      files: [
        {
          id: imageId('a', 'native', 'code'),
          name: 'source.ts',
          mediaType: 'text/plain',
          byteSize: Buffer.byteLength(text),
        },
        { id: imageId('a', 'native', 'pdf'), name: 'report.pdf', mediaType: 'application/pdf', byteSize: pdf.length },
      ],
    }
    expect(projectChatMessages([message], queue.all())).toMatchObject([expected])
    expect(
      projectChatMessages([{ ...message, parts: [{ type: 'text', id: 'text', text: '' }, ...message.parts] }])
    ).toMatchObject([{ ...expected, id: 'native:0' }])
  })
})
