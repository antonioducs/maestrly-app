import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  FLEET_IMAGE_LIMITS,
  fleetInstanceInputSchema,
  type FleetInstanceInput,
  type FleetInputReceipt,
  type FleetImageRef,
} from '@maestrly/bot-fleet-protocol'
import { z } from 'zod'
import type { ChatAttachmentInput } from '../../../shared/chat'
import { imageMediaType } from './images'

type StoredInput = Omit<FleetInstanceInput, 'attachments'>
const previousRunSchema = z.object({
  at: z.string(),
  status: z.enum(['delivered', 'completed', 'failed', 'cancelled', 'unknown']),
  summary: z.string().nullable(),
  pending: z.string().nullable(),
  notes: z.string().nullable(),
})
const storedInputSchema = z.object({
  idempotencyKey: z.uuid(),
  text: z.string(),
  source: z.enum(['owner', 'routine', 'peer', 'continuation']),
  routine: z
    .object({
      id: z.string(),
      title: z.string(),
      runId: z.string().optional(),
      previousRuns: z.array(previousRunSchema).max(3).optional(),
    })
    .optional(),
  peer: z.object({ botId: z.string(), name: z.string() }).optional(),
})
const attachmentSchema = z.object({
  id: z.string().regex(/^q-[a-f0-9-]{36}-[0-7]$/),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  byteSize: z.number().int().positive().max(FLEET_IMAGE_LIMITS.attachmentMaxBytes),
  name: z.string(),
})

export interface QueuedInput {
  id: string
  at: string
  input: StoredInput
  attachments: z.infer<typeof attachmentSchema>[]
  itemId: string
  started: boolean
  nativeMessageId?: string
}
const recordSchema = z.object({
  id: z.string().uuid(),
  at: z.iso.datetime(),
  input: storedInputSchema,
  attachments: z.array(attachmentSchema).default([]),
  itemId: z.string(),
  started: z.boolean(),
  nativeMessageId: z.string().optional(),
})
const stateSchema = z.object({ items: z.array(recordSchema) })

export class InstanceInputQueue {
  private items: QueuedInput[] = []
  private writeTail: Promise<void> = Promise.resolve()
  constructor(
    private readonly file: string,
    private readonly writer: (file: string, contents: string) => Promise<void> = (file, contents) =>
      fs.writeFile(file, contents, { mode: 0o600 })
  ) {}
  private attachmentDir(id: string): string {
    return path.join(path.dirname(path.dirname(this.file)), 'fleet-inputs', id)
  }
  private attachmentFile(id: string, index: number, mediaType: string): string {
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[mediaType]
    if (!ext || !/^[a-f0-9-]{36}$/.test(id) || index < 0 || index > 7) throw new Error('Invalid queued image reference')
    return path.join(this.attachmentDir(id), index + '.' + ext)
  }
  refs(item: QueuedInput): FleetImageRef[] {
    return item.attachments.map((entry) => ({ ...entry }))
  }
  private async readAttachment(
    item: QueuedInput,
    entry: QueuedInput['attachments'][number],
    index: number
  ): Promise<Buffer> {
    const file = this.attachmentFile(item.id, index, entry.mediaType)
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.byteSize)
      throw new Error('Queued image is invalid')
    const bytes = await fs.readFile(file)
    if (bytes.length !== entry.byteSize || imageMediaType(bytes) !== entry.mediaType)
      throw new Error('Queued image is invalid')
    return bytes
  }
  async readAttachments(item: QueuedInput): Promise<ChatAttachmentInput[]> {
    return Promise.all(
      item.attachments.map(async (entry, index) => {
        const bytes = await this.readAttachment(item, entry, index)
        return { name: entry.name, mediaType: entry.mediaType, kind: 'image' as const, bytes }
      })
    )
  }
  async readImage(imageId: string): Promise<{ mediaType: string; bytes: Uint8Array } | null> {
    for (const item of this.list()) {
      const index = item.attachments.findIndex((entry) => entry.id === imageId)
      if (index < 0) continue
      try {
        const entry = item.attachments[index]
        const bytes = await this.readAttachment(item, entry, index)
        return { mediaType: entry.mediaType, bytes }
      } catch {
        return null
      }
    }
    return null
  }
  async cleanup(id: string): Promise<void> {
    await fs.rm(this.attachmentDir(id), { recursive: true, force: true })
  }
  async sweepAttachments(): Promise<void> {
    const root = path.join(path.dirname(path.dirname(this.file)), 'fleet-inputs')
    let entries: string[]
    try {
      entries = await fs.readdir(root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const pending = new Set(
      this.list()
        .filter((item) => item.attachments.length)
        .map((item) => item.id)
    )
    await Promise.all(
      entries
        .filter((entry) => /^[a-f0-9-]{36}$/.test(entry) && !pending.has(entry))
        .map((entry) => this.cleanup(entry))
    )
  }

  async load(): Promise<void> {
    try {
      this.items = stateSchema.parse(JSON.parse(await fs.readFile(this.file, 'utf8'))).items
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }

  list(): QueuedInput[] {
    return this.items.filter((item) => !item.started)
  }
  all(): QueuedInput[] {
    return [...this.items]
  }

  private async update<T>(change: (items: QueuedInput[]) => { result: T; changed: boolean }): Promise<T> {
    const write = this.writeTail.then(async () => {
      const next = this.items.map((item) => ({ ...item }))
      const { result, changed } = change(next)
      if (!changed) return result
      const contents = JSON.stringify({ items: next })
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
      const temp = this.file + '.' + randomUUID() + '.tmp'
      try {
        await this.writer(temp, contents)
        await fs.rename(temp, this.file)
      } finally {
        await fs.rm(temp, { force: true }).catch(() => undefined)
      }
      this.items = next
      return result
    })
    this.writeTail = write.then(
      () => undefined,
      () => undefined
    )
    return write
  }

  async enqueue(
    raw: Omit<FleetInstanceInput, 'attachments'> & { attachments?: FleetInstanceInput['attachments'] }
  ): Promise<FleetInputReceipt> {
    const input = fleetInstanceInputSchema.parse(raw)
    if (input.source === 'routine' && !input.routine) throw new Error('Routine source requires routine metadata.')
    if (input.source === 'peer' && !input.peer) throw new Error('Peer source requires peer metadata.')
    const existing = this.items.find(
      (item) => item.input.idempotencyKey === input.idempotencyKey && Date.now() - Date.parse(item.at) < 86_400_000
    )
    if (existing) return { inputId: existing.id, itemId: existing.itemId, queued: !existing.started }
    const id = randomUUID()
    const attachments: QueuedInput['attachments'] = []
    try {
      for (const [index, attachment] of input.attachments.entries()) {
        const bytes = Buffer.from(attachment.dataBase64, 'base64')
        if (imageMediaType(bytes) !== attachment.mediaType) throw new Error('Attachment bytes do not match media type')
        const destination = this.attachmentFile(id, index, attachment.mediaType)
        await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
        const temporary = destination + '.' + randomUUID() + '.tmp'
        try {
          await fs.writeFile(temporary, bytes, { mode: 0o600 })
          await fs.rename(temporary, destination)
        } finally {
          await fs.rm(temporary, { force: true }).catch(() => undefined)
        }
        attachments.push({
          id: `q-${id}-${index}`,
          name: attachment.name,
          mediaType: attachment.mediaType,
          byteSize: bytes.length,
        })
      }
      const result = await this.update((items) => {
        const now = Date.now()
        const existing = [...items]
          .reverse()
          .find(
            (item) =>
              item.input.idempotencyKey === input.idempotencyKey && now - Date.parse(item.at) < 24 * 60 * 60 * 1_000
          )
        if (existing)
          return {
            result: { inputId: existing.id, itemId: existing.itemId, queued: !existing.started },
            changed: false,
          }
        const { attachments: _data, ...storedInput } = input
        const item: QueuedInput = {
          id,
          at: new Date().toISOString(),
          input: storedInput,
          attachments,
          itemId: 'input:' + id,
          started: false,
        }
        if (input.source === 'continuation') items.unshift(item)
        else items.push(item)
        return { result: { inputId: id, itemId: item.itemId, queued: true }, changed: true }
      })
      if (result.inputId !== id) await this.cleanup(id)
      return result
    } catch (error) {
      await this.cleanup(id)
      throw error
    }
  }

  async delete(id: string): Promise<'deleted' | 'started' | 'missing'> {
    return this.update((items) => {
      const index = items.findIndex((item) => item.id === id)
      if (index < 0) return { result: 'missing' as const, changed: false }
      if (items[index].started) return { result: 'started' as const, changed: false }
      items.splice(index, 1)
      return { result: 'deleted' as const, changed: true }
    })
  }

  async markStarted(id: string): Promise<void> {
    await this.update((items) => {
      const item = items.find((candidate) => candidate.id === id)
      if (!item) throw new Error('Input not found')
      item.started = true
      return { result: undefined, changed: true }
    })
  }

  async mapNativeMessage(id: string, messageId: string): Promise<void> {
    await this.update((items) => {
      const item = items.find((candidate) => candidate.id === id)
      if (!item?.started) throw new Error('Started input not found')
      item.nativeMessageId = messageId
      return { result: undefined, changed: true }
    })
  }

  async reconcile(nativeUsers: Array<{ id: string; at: number; text: string }>): Promise<void> {
    await this.update((items) => {
      const claimed = new Set(items.map((item) => item.nativeMessageId).filter((id): id is string => !!id))
      let changed = false
      for (const item of items) {
        if (!item.started || item.nativeMessageId) continue
        const match = nativeUsers.find(
          (user) =>
            !claimed.has(user.id) && user.at >= Date.parse(item.at) - 1_000 && user.text === promptForInput(item.input)
        )
        if (match) {
          item.nativeMessageId = match.id
          claimed.add(match.id)
        } else item.started = false
        changed = true
      }
      return { result: undefined, changed }
    })
  }
}

function routinePrompt(input: StoredInput): string {
  const base = `Scheduled routine "${input.routine?.title ?? ''}". Do this now:\n\n${input.text}`
  if (!input.routine?.runId) return base
  const runs = input.routine.previousRuns ?? []
  const history = runs.length
    ? `Previous runs of this routine, newest first:\n${runs.map((run) => `- ${run.at.slice(0, 16).replace('T', ' ')} UTC · ${run.status}${run.summary ? ` · Did: ${run.summary}` : ''}${run.pending ? ` · Pending: ${run.pending}` : ''}${run.notes ? ` · Notes for this run: ${run.notes}` : ''}`).join('\n')}`
    : 'This is the first recorded run of this routine.'
  return `${base}\n\n${history}\n\nWhen you finish, call routine_report with a short summary of what you did, anything still pending, and notes for the next run.`
}

export function promptForInput(input: StoredInput): string {
  switch (input.source) {
    case 'owner':
      return input.text
    case 'routine':
      return routinePrompt(input)
    case 'peer':
      return `Message from bot "${input.peer?.name ?? ''}" (id ${input.peer?.botId ?? ''}), delivered by the Maestrly gateway:\n\n${input.text}\n\nIf a reply is useful, send it with bot_peers_send.`
    case 'continuation':
      return input.text
  }
}
