import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  FLEET_ROUTINE_RUN_KEPT_FOLDER,
  FLEET_PEER_THREAD_KEPT_FOLDER,
  FLEET_ROUTINE_RUN_LIMITS,
  type FleetImageRef,
  type FleetRoutineRunKept,
  type FleetRoutineRunMedia,
} from '@maestrly/bot-fleet-protocol'
import type { ChatMessage, MessagePart } from '../../../shared/chat'
import { readAttachmentImage, readAttachmentPdf } from '../../chat/attachment-artifacts'
import { listChatMessagesAfter } from '../../chat/chat-store'
import { readGeneratedImage } from '../../chat/generated-images'
import type { FleetImageStore } from './images'
import { imageMediaType } from './images'
import type { LaneRecord, RunRecord } from './routine-runs'
import { projectMessages, transcriptInputs } from './transcript'

type ToolRefs = (part: Extract<MessagePart, { type: 'tool' }>) => FleetImageRef[]

function messagesOf(conversationId: string): ChatMessage[] {
  return listChatMessagesAfter(conversationId, Number.MIN_SAFE_INTEGER).map((row) => row.message)
}

/** What a run's conversation shows the owner, counted as its history lists it: images, videos and other files. */
export function runMedia(conversationId: string, toolRefs: ToolRefs): FleetRoutineRunMedia {
  const media = { images: 0, videos: 0, files: 0 }
  for (const { item } of projectMessages(messagesOf(conversationId), transcriptInputs([]), toolRefs)) {
    if (item.kind !== 'tool') continue
    if (item.shared) media.images += item.images.length
    for (const file of item.files ?? []) {
      if (file.mediaType.startsWith('video/')) media.videos++
      else media.files++
    }
  }
  return media
}

const EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
}

/** A file name of the owner's or the bot's, made safe to write in one folder: no path, no control characters. */
function safeName(value: string | null | undefined, fallback: string, mediaType: string): string {
  const base = path.posix
    .basename((value ?? '').replaceAll('\\', '/'))
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120)
  const name = base || fallback
  const extension = EXTENSIONS[mediaType]
  return extension && !path.extname(name) ? name + extension : name
}

/** A folder name of a title: plain letters and digits joined by dashes. */
function slugOf(title: string, fallback: string): string {
  return (
    title
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/g, '') || fallback
  )
}

/** The folder of one run among the kept ones: by its routine, then the time it ran (UTC). */
export function runKeptFolder(record: Pick<RunRecord, 'routineTitle' | 'createdAt'>): string {
  return path.posix.join(
    FLEET_ROUTINE_RUN_KEPT_FOLDER,
    slugOf(record.routineTitle, 'routine'),
    stampOf(record.createdAt)
  )
}

/** The folder of a side conversation among the kept ones: a run's by its routine, a thread's by the other bot. */
export function laneKeptFolder(record: LaneRecord): string {
  return record.kind === 'routine'
    ? runKeptFolder(record)
    : path.posix.join(FLEET_PEER_THREAD_KEPT_FOLDER, slugOf(record.peerName, 'bot'), stampOf(record.createdAt))
}

function stampOf(createdAt: string): string {
  const at = new Date(createdAt)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}-${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}`
}

type Kept = FleetRoutineRunKept['files'][number]
interface Copy {
  name: string
  mediaType: string
  read: () => Promise<Uint8Array | null>
}

/**
 * Copies what a run's conversation holds outside its folder (the images it generated or shared, and the owner's
 * attachments) into `routines/<routine>/<time>/` in the bot's conversation folder, before that conversation is
 * deleted; the files the run shared are in that folder already and are listed as they are. Nothing the run wrote is
 * ever overwritten: a name taken gets a number.
 */
export async function keepRunFiles(options: {
  record: LaneRecord
  /** The bot's conversation folder, or null when it is gone: nothing is copied then. */
  folder: string | null
  images: FleetImageStore
}): Promise<FleetRoutineRunKept> {
  const { record, images } = options
  const conversationId = record.conversationId
  const copies: Copy[] = []
  const shared: Kept[] = []
  let count = 0
  const next = () => ++count
  for (const message of messagesOf(conversationId)) {
    if (message.internal) continue
    for (const part of message.parts) {
      if (message.role === 'assistant' && part.type === 'generated-image' && part.artifactId) {
        const artifactId = part.artifactId
        copies.push({
          name: safeName(part.name, `image-${next()}`, part.mediaType),
          mediaType: part.mediaType,
          read: async () => {
            const result = await readGeneratedImage(conversationId, artifactId, part.byteSize)
            return result.ok ? result.bytes : null
          },
        })
      } else if (message.role === 'user' && part.type === 'file' && !part.hidden) {
        const artifactId = part.artifactId
        if (part.kind === 'image' && artifactId)
          copies.push({
            name: safeName(part.name, `attachment-${next()}`, part.mediaType),
            mediaType: part.mediaType,
            read: async () => {
              const result = await readAttachmentImage(conversationId, artifactId, part.byteSize)
              return result.ok ? result.bytes : null
            },
          })
        else if (part.kind === 'pdf' && artifactId)
          copies.push({
            name: safeName(part.name, `attachment-${next()}`, 'application/pdf'),
            mediaType: 'application/pdf',
            read: async () => {
              const result = await readAttachmentPdf(conversationId, artifactId, part.byteSize)
              return result.ok ? result.bytes : null
            },
          })
        else if (part.kind === 'text')
          copies.push({
            name: safeName(part.name, `attachment-${next()}`, 'text/plain'),
            mediaType: 'text/plain',
            read: async () => Buffer.from(part.data ?? '', 'utf8'),
          })
      }
    }
  }
  // The screenshots the bot showed the owner, and the files it shared.
  for (const { item } of projectMessages(messagesOf(conversationId), transcriptInputs([]), (part) =>
    images.toolRefs(part)
  )) {
    if (item.kind !== 'tool') continue
    // Generated images were copied above: only tool screenshots (`t-`) remain.
    if (item.shared)
      for (const image of item.images.filter((entry) => entry.id.startsWith('t-')))
        copies.push({
          name: safeName(image.name, `screenshot-${next()}`, image.mediaType),
          mediaType: image.mediaType,
          read: async () => (await images.read(image.id, conversationId, []))?.bytes ?? null,
        })
    for (const file of item.files ?? [])
      shared.push({
        name: file.name,
        kind: file.mediaType.startsWith('video/') ? 'video' : 'file',
        byteSize: file.byteSize,
      })
  }
  const relative = laneKeptFolder(record)
  const kept: Kept[] = []
  if (copies.length && options.folder) {
    const root = await fs.realpath(options.folder)
    const target = path.join(root, ...relative.split('/'))
    await fs.mkdir(target, { recursive: true, mode: 0o700 })
    const real = await fs.realpath(target)
    if (!real.startsWith(root + path.sep)) throw new Error('The folder for the run is outside the bot folder.')
    for (const copy of copies) {
      if (kept.length >= FLEET_ROUTINE_RUN_LIMITS.keptFilesMax) break
      const bytes = await copy.read().catch(() => null)
      if (!bytes) continue
      const written = await writeNew(real, copy.name, bytes)
      const isImage = copy.mediaType.startsWith('image/') && imageMediaType(bytes) !== null
      kept.push({ name: written, kind: isImage ? 'image' : 'file', byteSize: bytes.byteLength })
    }
  }
  const files = [...kept, ...shared].slice(0, FLEET_ROUTINE_RUN_LIMITS.keptFilesMax)
  return { folder: kept.length ? relative : '', files }
}

/** Writes a new file in `folder`, never over another: `name`, then `name-2`, `name-3`… Returns the name used. */
async function writeNew(folder: string, name: string, bytes: Uint8Array): Promise<string> {
  const extension = path.extname(name)
  const stem = name.slice(0, name.length - extension.length)
  for (let attempt = 1; attempt < 1000; attempt++) {
    const candidate = attempt === 1 ? name : `${stem}-${attempt}${extension}`
    try {
      await fs.writeFile(path.join(folder, candidate), bytes, { flag: 'wx', mode: 0o600 })
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error('Too many files with the same name.')
}

/**
 * A run's conversation as text the bot reads back (`bot_routines_runs`): the messages in order, its tool calls by
 * name and target, and what it shared; cut at `max` characters, the newest kept.
 */
export function runConversationText(conversationId: string, max = 12_000): string {
  const lines: string[] = []
  for (const { item } of projectMessages(messagesOf(conversationId), transcriptInputs([]))) {
    if (item.kind === 'user')
      lines.push(`[${item.at}] ${item.source === 'routine' ? 'Routine' : 'Owner'}: ${item.text.slice(0, 2_000)}`)
    else if (item.kind === 'assistant') lines.push(`[${item.at}] You: ${item.text.slice(0, 2_000)}`)
    else if (item.kind === 'tool') {
      const files = (item.files ?? []).map((file) => file.name).join(', ')
      lines.push(
        `[${item.at}] Tool ${item.name}${item.target ? ` (${item.target})` : ''}: ${item.state}${files ? ` · shared ${files}` : ''}`
      )
    }
  }
  const text = lines.join('\n')
  return text.length <= max ? text : '…' + text.slice(text.length - max + 1)
}
