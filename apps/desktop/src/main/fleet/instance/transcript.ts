import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  FLEET_TOOL_OUTPUT_MAX,
  FLEET_COMPACTION_SUMMARY_MAX,
  compareFleetTranscriptItems,
  fleetTranscriptItemSchema,
  type FleetTranscriptItem,
  type FleetTranscriptPage,
  type FleetQuestion,
  type FleetImageRef,
} from '@maestrly/bot-fleet-protocol'
import type { ChatMessage, ChatQuestion, MessagePart } from '../../../shared/chat'
import type { PermissionRequest } from '../../chat/permission'
import { promptForInput, type QueuedInput } from './queue'
import { imageId } from './images'
import { fleetImageMediaTypeSchema } from '@maestrly/bot-fleet-protocol'

const at = (time: number): string => new Date(time).toISOString()
const textOf = (value: unknown): string => (typeof value === 'string' ? value : (JSON.stringify(value) ?? ''))
const TOOL_OUTPUT_KEYS = new Set(['text', 'images', 'structuredContent', 'isError'])
/** A chat tool output envelope sends its text only: its images travel as refs, and their ids are internal. */
const toolOutputTextOf = (value: unknown): string =>
  value !== null &&
  typeof value === 'object' &&
  typeof (value as { text?: unknown }).text === 'string' &&
  Object.keys(value).every((key) => TOOL_OUTPUT_KEYS.has(key))
    ? (value as { text: string }).text
    : textOf(value)
const short = (value: string, max: number): string => value.slice(0, max)
export function fleetQuestions(questions: ChatQuestion[]): FleetQuestion[] {
  return questions.map((question) => ({
    question: question.question,
    header: question.header || null,
    options: question.options.map((option) => ({ label: option.label, description: option.description ?? null })),
    multiSelect: !!question.multiSelect,
  }))
}
export function toolTarget(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const value = input as Record<string, unknown>
  const url = value.url
  if (typeof url === 'string') {
    try {
      const parsed = new URL(url)
      return short(parsed.host + parsed.pathname, 80)
    } catch {
      return short(url, 80)
    }
  }
  for (const key of ['path', 'filePath', 'command', 'cmd'])
    if (typeof value[key] === 'string') return short(value[key], 80)
  if (typeof value.x === 'number' && typeof value.y === 'number') return `(${value.x}, ${value.y})`
  if (
    typeof value.fromX === 'number' &&
    typeof value.fromY === 'number' &&
    typeof value.toX === 'number' &&
    typeof value.toY === 'number'
  )
    return `(${value.fromX}, ${value.fromY}) → (${value.toX}, ${value.toY})`
  if (typeof value.keys === 'string') return short(value.keys, 80)
  // Routine tools: after the concrete targets above, so tools that also take a title keep showing those.
  if (typeof value.title === 'string') return short(value.title, 80)
  if (typeof value.text === 'string') return short(value.text, 40)
  return null
}
export function permissionTool(
  request: Pick<PermissionRequest, 'action' | 'resources' | 'toolName' | 'toolCallId'>,
  messages: ChatMessage[]
): { name: string; target: string | null } | null {
  const name = request.toolName || (request.action === 'bash' ? 'bash' : null)
  if (!name) return null
  const call = request.toolCallId
    ? messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === 'tool' && part.toolCallId === request.toolCallId)
    : undefined
  const target = call?.type === 'tool' ? toolTarget(call.input) : null
  const resource = request.resources.find((value) => value && value !== '*' && value !== name)
  return { name, target: target ?? (resource ? toolTarget({ command: resource }) : null) }
}
function peerOutput(output: unknown): { delivered?: boolean; name?: string } {
  if (typeof output === 'string') {
    try {
      return peerOutput(JSON.parse(output))
    } catch {
      return {}
    }
  }
  if (!output || typeof output !== 'object') return {}
  const value = output as Record<string, unknown>
  if (typeof value.delivered === 'boolean')
    return { delivered: value.delivered, name: typeof value.name === 'string' ? value.name : undefined }
  if (typeof value.text === 'string') return peerOutput(value.text)
  return {}
}
function toolItem(
  message: ChatMessage,
  part: Extract<MessagePart, { type: 'tool' }>,
  index: number,
  images: FleetImageRef[]
): FleetTranscriptItem {
  const status = part.state.status
  // Only a streaming message updates its tools: one still open after the message ended will never finish here
  // (an app restart, a background process whose end never arrived).
  const leftOpen =
    (!!message.finishReason || !!message.error) &&
    (status === 'running' || status === 'pending' || status === 'awaiting-permission')
  const interrupted =
    leftOpen ||
    (message.finishReason === 'aborted' && status !== 'completed') ||
    (status === 'error' && part.state.error === 'Aborted')
  const output =
    status === 'error'
      ? part.state.error
      : status === 'denied'
        ? part.state.reason
        : status === 'completed' || status === 'running'
          ? toolOutputTextOf(part.state.output ?? '')
          : ''
  let routineTitle: string | null = null
  if (part.toolName.startsWith('bot_routines_') && output) {
    try {
      const result: unknown = JSON.parse(output)
      if (result && typeof result === 'object' && 'title' in result && typeof result.title === 'string')
        routineTitle = short(result.title, 80)
    } catch {}
  }
  return {
    kind: 'tool',
    id: `${message.id}:${index}`,
    at: at(message.createdAt),
    name: part.toolName,
    target: toolTarget(part.input) ?? routineTitle,
    state: interrupted
      ? 'interrupted'
      : status === 'completed'
        ? 'done'
        : status === 'error' || status === 'denied'
          ? 'error'
          : 'running',
    output: output ? short(output, FLEET_TOOL_OUTPUT_MAX) : null,
    images,
  }
}
function ownerImageRefs(message: ChatMessage): FleetImageRef[] {
  return message.parts
    .filter(
      (entry): entry is Extract<MessagePart, { type: 'file' }> =>
        entry.type === 'file' &&
        entry.kind === 'image' &&
        !!entry.artifactId &&
        fleetImageMediaTypeSchema.safeParse(entry.mediaType).success
    )
    .slice(0, 8)
    .map((entry) => ({
      id: imageId('a', message.id, entry.id),
      mediaType: entry.mediaType as FleetImageRef['mediaType'],
      byteSize: entry.byteSize ?? null,
      name: entry.name,
    }))
}
export function projectChatMessages(
  messages: ChatMessage[],
  inputs: QueuedInput[] = [],
  toolImages: (part: Extract<MessagePart, { type: 'tool' }>) => FleetImageRef[] = () => []
): FleetTranscriptItem[] {
  const mappedInputs = inputs.filter((item) => item.started && !item.nativeMessageId)
  const byMessage = new Map(inputs.filter((item) => item.nativeMessageId).map((item) => [item.nativeMessageId, item]))
  const claimed = new Set<string>()
  const items: FleetTranscriptItem[] = []
  for (const message of messages) {
    if (message.internal) continue
    const nativeText = message.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('')
    const linked =
      message.role === 'user'
        ? (byMessage.get(message.id) ??
          mappedInputs.find(
            (item) =>
              !claimed.has(item.id) &&
              message.createdAt >= Date.parse(item.at) - 1_000 &&
              nativeText === promptForInput(item.input)
          ))
        : undefined
    if (linked) claimed.add(linked.id)
    for (const [index, part] of message.parts.entries()) {
      const id = linked && index === 0 ? linked.itemId : `${message.id}:${index}`
      const time = at(message.createdAt)
      if (part.type === 'reasoning') continue
      if (part.type === 'compaction') {
        const runtime = part.strategy?.endsWith('-native') === true
        items.push({
          kind: 'compaction',
          id: `${message.id}:${index}`,
          at: time,
          origin: runtime ? 'runtime' : (part.origin ?? 'immediate'),
          summary: runtime ? null : part.text.slice(0, FLEET_COMPACTION_SUMMARY_MAX),
          truncated: !runtime && part.text.length > FLEET_COMPACTION_SUMMARY_MAX,
        })
      } else if (part.type === 'text') {
        if (message.role === 'user') {
          if (!part.text && !linked) continue
          items.push({
            kind: 'user',
            id,
            at: time,
            text: linked?.input.text ?? part.text,
            source: linked?.input.source ?? 'owner',
            routine: linked?.input.routine,
            peer: linked?.input.peer,
            queued: false,
            memories: [],
            images: ownerImageRefs(message),
          })
        } else if (message.role === 'assistant') {
          items.push({
            kind: 'assistant',
            id,
            at: time,
            text: part.text,
            streaming: !message.finishReason && !message.error,
          })
        }
      } else if (part.type === 'tool' && message.role === 'assistant') {
        if (part.toolName === 'ask_question') {
          const input = part.input as { questions?: ChatQuestion[] }
          items.push({
            kind: 'question',
            id,
            at: time,
            toolCallId: part.toolCallId,
            questions: fleetQuestions(input?.questions ?? []),
            state:
              part.state.status === 'completed' ? 'answered' : part.state.status === 'denied' ? 'dismissed' : 'pending',
            answers: null,
          })
        } else if (part.toolName === 'request_owner_help') {
          // The help store supplies this item with its own stable id and resolution state.
        } else if (part.toolName === 'bot_peers_send') {
          const input = part.input as { to?: string; text?: string; name?: string }
          const result = peerOutput(part.state.status === 'completed' ? part.state.output : undefined)
          if (input?.to && input?.text)
            items.push({
              kind: 'peer_out',
              id,
              at: time,
              to: { botId: input.to, name: result.name ?? input.name ?? input.to },
              text: input.text,
              delivered: result.delivered === true,
            })
        } else items.push(toolItem(message, part, index, toolImages(part)))
      } else if (
        part.type === 'generated-image' &&
        message.role === 'assistant' &&
        fleetImageMediaTypeSchema.safeParse(part.mediaType).success
      ) {
        const previous = [...items]
          .reverse()
          .find((entry) => entry.kind === 'tool' && entry.id.startsWith(message.id + ':'))
        if (previous?.kind === 'tool' && previous.images.length < 8)
          previous.images.push({
            id: imageId('g', message.id, part.id),
            mediaType: part.mediaType as FleetImageRef['mediaType'],
            byteSize: part.byteSize ?? null,
            name: part.name,
          })
      }
    }
    if (message.role === 'user' && !message.parts.some((part) => part.type === 'text')) {
      const images = ownerImageRefs(message)
      if (images.length)
        items.push({
          kind: 'user',
          id: linked?.itemId ?? `${message.id}:0`,
          at: at(message.createdAt),
          text: linked?.input.text ?? '',
          source: linked?.input.source ?? 'owner',
          routine: linked?.input.routine,
          peer: linked?.input.peer,
          queued: false,
          memories: [],
          images,
        })
    }
  }
  return items.filter((item) => fleetTranscriptItemSchema.safeParse(item).success)
}
export function transcriptPage(items: FleetTranscriptItem[], before?: string | null, limit = 200): FleetTranscriptPage {
  const sorted = [...items].sort(compareFleetTranscriptItems)
  const boundary = before ? sorted.findIndex((item) => item.id === before) : sorted.length
  const end = boundary < 0 ? sorted.length : boundary
  const start = Math.max(0, end - Math.max(1, Math.min(500, limit)))
  return { items: sorted.slice(start, end), before: start ? sorted[start].id : null }
}

export class InstanceTranscriptExtras {
  private items: FleetTranscriptItem[] = []
  private writeTail: Promise<void> = Promise.resolve()
  constructor(
    private readonly file: string,
    private readonly onUpsert: (item: FleetTranscriptItem) => void
  ) {}
  async load(): Promise<void> {
    try {
      const data: unknown = JSON.parse(await fs.readFile(this.file, 'utf8'))
      if (!Array.isArray(data)) throw new Error('Invalid instance transcript extras')
      this.items = data.map((item) => fleetTranscriptItemSchema.parse(item))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  list(): FleetTranscriptItem[] {
    return [...this.items]
  }
  async upsert(item: FleetTranscriptItem): Promise<void> {
    const valid = fleetTranscriptItemSchema.parse(item)
    const index = this.items.findIndex((existing) => existing.id === item.id)
    if (index < 0) this.items.push(valid)
    else this.items[index] = valid
    const contents = JSON.stringify(this.items)
    const write = this.writeTail.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
      const temporary = this.file + '.' + randomUUID() + '.tmp'
      try {
        await fs.writeFile(temporary, contents, { mode: 0o600 })
        await fs.rename(temporary, this.file)
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined)
      }
    })
    this.writeTail = write.catch(() => undefined)
    await write
    this.onUpsert(valid)
  }
}
