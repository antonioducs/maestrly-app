import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  FLEET_IMAGE_LIMITS,
  fleetImageMediaTypeSchema,
  type FleetImageMediaType,
  type FleetImageRef,
} from '@maestrly/bot-fleet-protocol'
import type { ChatMessage, ChatToolImage, MessagePart } from '../../../shared/chat'
import { toolOutputImages } from '../../../shared/chat'
import { readAttachmentImage } from '../../chat/attachment-artifacts'
import { readGeneratedImage } from '../../chat/generated-images'
import { getEphemeralToolImage } from '../../chat/tool-output'

export function imageMediaType(bytes: Uint8Array): FleetImageMediaType | null {
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString() === 'RIFF' &&
    Buffer.from(bytes.subarray(8, 12)).toString() === 'WEBP'
  )
    return 'image/webp'
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(Buffer.from(bytes.subarray(0, 6)).toString()))
    return 'image/gif'
  return null
}
export function imageId(prefix: 'a' | 'g', messageId: string, partId: string): string {
  return (
    prefix +
    '-' +
    createHash('sha256')
      .update(messageId + '\0' + partId)
      .digest('base64url')
      .slice(0, 32)
  )
}
const toolId = (bytes: Uint8Array) => 't-' + createHash('sha256').update(bytes).digest('base64url').slice(0, 32)
type Entry = {
  id: string
  sourceIds: string[]
  mediaType: FleetImageMediaType
  byteSize: number
  name: string | null
  createdAt: number
  evicted?: boolean
}
const ref = (entry: Entry): FleetImageRef => ({
  id: entry.id,
  mediaType: entry.mediaType,
  byteSize: entry.byteSize,
  name: entry.name,
})

export class FleetImageStore {
  private entries = new Map<string, Entry>()
  private writing = Promise.resolve()
  constructor(private readonly root: string) {}
  async load(): Promise<void> {
    try {
      const data: unknown = JSON.parse(await fs.readFile(path.join(this.root, 'index.json'), 'utf8'))
      if (!Array.isArray(data)) throw new Error('Invalid fleet image index')
      for (const item of data) {
        if (
          item &&
          typeof item === 'object' &&
          typeof item.id === 'string' &&
          /^t-[A-Za-z0-9_-]{32}$/.test(item.id) &&
          fleetImageMediaTypeSchema.safeParse(item.mediaType).success &&
          Array.isArray(item.sourceIds) &&
          item.sourceIds.every((id: unknown) => typeof id === 'string') &&
          Number.isSafeInteger(item.byteSize) &&
          item.byteSize > 0 &&
          Number.isFinite(item.createdAt)
        )
          this.entries.set(item.id, item as Entry)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  private async persist(): Promise<void> {
    const file = path.join(this.root, 'index.json')
    const temporary = file + '.' + randomUUID() + '.tmp'
    try {
      await fs.writeFile(temporary, JSON.stringify([...this.entries.values()]), { mode: 0o600 })
      await fs.rename(temporary, file)
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
    }
  }
  async capture(image: ChatToolImage): Promise<FleetImageRef | null> {
    const cached = getEphemeralToolImage(image)
    if (!cached || cached.byteSize > FLEET_IMAGE_LIMITS.imageReadMaxBytes) return null
    const mediaType = imageMediaType(cached.bytes)
    if (!mediaType || mediaType !== cached.mediaType) return null
    const id = toolId(cached.bytes)
    const write = this.writing.then(async () => {
      const existing = this.entries.get(id)
      if (existing) {
        if (!existing.sourceIds.includes(image.id)) {
          existing.sourceIds.push(image.id)
          await this.persist()
        }
        return ref(existing)
      }
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 })
      const temporary = path.join(this.root, id + '.' + randomUUID() + '.tmp')
      try {
        await fs.writeFile(temporary, cached.bytes, { mode: 0o600 })
        await fs.rename(temporary, path.join(this.root, id))
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined)
      }
      const entry: Entry = {
        id,
        sourceIds: [image.id],
        mediaType,
        byteSize: cached.byteSize,
        name: image.name?.slice(0, 200) ?? null,
        createdAt: Date.now(),
      }
      this.entries.set(id, entry)
      let total = [...this.entries.values()]
        .filter((item) => !item.evicted)
        .reduce((sum, item) => sum + item.byteSize, 0)
      let count = [...this.entries.values()].filter((item) => !item.evicted).length
      for (const oldest of [...this.entries.values()]
        .filter((item) => !item.evicted)
        .sort((a, b) => a.createdAt - b.createdAt)) {
        if (count <= 1000 && total <= 400 * 1024 * 1024) break
        oldest.evicted = true
        count--
        total -= oldest.byteSize
        await fs.rm(path.join(this.root, oldest.id), { force: true })
      }
      await this.persist()
      return entry.evicted ? null : ref(entry)
    })
    this.writing = write.then(
      () => undefined,
      () => undefined
    )
    return write
  }
  toolRefs(part: Extract<MessagePart, { type: 'tool' }>): FleetImageRef[] {
    if (part.state.status !== 'completed') return []
    return toolOutputImages(part.state.output)
      .slice(0, FLEET_IMAGE_LIMITS.imagesPerItemMax)
      .flatMap((image) => {
        const entry = [...this.entries.values()].find((candidate) => candidate.sourceIds.includes(image.id))
        return entry ? [ref(entry)] : []
      })
  }
  async captureMessages(messages: ChatMessage[]): Promise<void> {
    for (const message of messages)
      for (const part of message.parts)
        if (part.type === 'tool' && part.state.status === 'completed')
          for (const image of toolOutputImages(part.state.output).slice(0, FLEET_IMAGE_LIMITS.imagesPerItemMax))
            await this.capture(image)
  }
  async read(
    id: string,
    conversationId: string,
    messages: ChatMessage[]
  ): Promise<{ mediaType: FleetImageMediaType; bytes: Uint8Array } | null> {
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) return null
    const entry = this.entries.get(id)
    if (entry?.evicted) return null
    if (entry) {
      try {
        const stat = await fs.lstat(path.join(this.root, id))
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.size !== entry.byteSize ||
          stat.size > FLEET_IMAGE_LIMITS.imageReadMaxBytes
        )
          return null
        const bytes = await fs.readFile(path.join(this.root, id))
        return imageMediaType(bytes) === entry.mediaType ? { mediaType: entry.mediaType, bytes } : null
      } catch {
        return null
      }
    }
    for (const message of messages) {
      if (message.conversationId !== conversationId) continue
      for (const part of message.parts) {
        if (
          part.type === 'file' &&
          part.kind === 'image' &&
          part.artifactId &&
          id === imageId('a', message.id, part.id)
        ) {
          const result = await readAttachmentImage(conversationId, part.artifactId, part.byteSize)
          const mediaType = result.ok ? imageMediaType(result.bytes) : null
          return result.ok && mediaType && result.byteSize <= FLEET_IMAGE_LIMITS.imageReadMaxBytes
            ? { mediaType, bytes: result.bytes }
            : null
        }
        if (part.type === 'generated-image' && id === imageId('g', message.id, part.id)) {
          const result = await readGeneratedImage(conversationId, part.artifactId, part.byteSize)
          const mediaType = result.ok ? imageMediaType(result.bytes) : null
          return result.ok && mediaType && result.byteSize <= FLEET_IMAGE_LIMITS.imageReadMaxBytes
            ? { mediaType, bytes: result.bytes }
            : null
        }
      }
    }
    return null
  }
}
