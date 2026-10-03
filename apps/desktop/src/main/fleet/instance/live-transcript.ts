import {
  compareFleetTranscriptItems,
  fleetTranscriptItemReadable,
  type FleetTranscriptItem,
  type FleetTranscriptPage,
} from '@maestrly/bot-fleet-protocol'
import type { ChatMessage, MessagePart } from '../../../shared/chat'
import {
  findLatestChatMessage,
  getChatMessagesWithSeq,
  latestPortableCompactionMessage,
  listChatMessagesAfter,
  listChatMessagesByTime,
  listChatMessagesSince,
  newestChatSeq,
  type SequencedChatMessage,
  type StoredChatMessage,
} from '../../chat/chat-store'
import { imageId, type FleetImageStore } from './images'
import type { InstanceInputQueue } from './queue'
import {
  projectMessages,
  transcriptPage,
  type InstanceTranscriptExtras,
  type ProjectedItem,
  type TranscriptInputs,
} from './transcript'

const PAGE_ROWS = 100
/** Messages whose emitted items are remembered; an older message that changes again is simply sent in full. */
const REMEMBERED_MESSAGES = 256
/**
 * The most messages read again on each refresh outside a bot's turns (messages that came without one): older ones are
 * read again when an event names them. Below the messages remembered, so that those read again are not sent again.
 */
const FLOOR_ROWS = 128
const REMEMBERED_IMAGES = 4_096
/** How far back a permission request's tool call is looked for: it belongs to the turn that is running. */
const TOOL_CALL_ROWS = 500

/**
 * A bot's transcript as the Mac sees it, read from its conversation a bounded amount at a time however long the
 * conversation grows: during a turn only the messages that change are projected again, and a page reads the newest
 * messages it needs.
 */
export class LiveTranscript {
  /** Messages above this seq are read again on each refresh: those of the current turn. */
  private floor = Number.MIN_SAFE_INTEGER
  /** Where the floor moves once a refresh has read the previous turn one last time. */
  private nextFloor: number | null = null
  /** Messages that events named since the last refresh. */
  private readonly dirty = new Set<string>()
  /** The newest message holding a portable compaction, as last seen: a prepared marker leaves no other trace. */
  private marker: { id: string; size: number } | null = null
  /** The serialized items last sent, by message and item id, for the most recently changed messages. */
  private readonly emitted = new Map<string, Map<string, string>>()
  /** The message of each attachment or generated image id recently projected, for reading its bytes. */
  private readonly imageOwners = new Map<string, string>()
  private refreshing: Promise<void> = Promise.resolve()

  constructor(
    private readonly options: {
      conversationId: () => string | null
      queue: InstanceInputQueue
      extras: InstanceTranscriptExtras
      images: FleetImageStore
      publish: (item: FleetTranscriptItem) => void
    }
  ) {}

  /** Starts from the conversation as it is: nothing already there is sent again unless it changes. */
  anchor(): void {
    const id = this.options.conversationId()
    if (!id) return
    this.floor = newestChatSeq(id) ?? Number.MIN_SAFE_INTEGER
    this.nextFloor = null
    const marker = latestPortableCompactionMessage(id)
    this.marker = marker ? { id: marker.id, size: marker.size } : null
  }
  /** A turn starts: its messages come after the newest one now. */
  turnStarted(): void {
    const id = this.options.conversationId()
    if (!id) return
    this.nextFloor = newestChatSeq(id) ?? Number.MIN_SAFE_INTEGER
  }
  /** An event changed this message. */
  touched(messageId: string): void {
    this.dirty.add(messageId)
  }
  /** Sends the items that changed since the last refresh. Refreshes run one at a time. */
  refresh(): Promise<void> {
    const run = this.refreshing.then(() => this.refreshNow())
    this.refreshing = run.catch(() => undefined)
    return run
  }
  private async refreshNow(): Promise<void> {
    const id = this.options.conversationId()
    if (!id) return
    const dirty = [...this.dirty]
    this.dirty.clear()
    const previousMarker = this.marker
    // Where the floor may move once this refresh has read what is above it now: a turn that starts meanwhile moves it
    // only once a later refresh read the one before it, final save included.
    const advance = this.nextFloor
    try {
      const rows = new Map<string, SequencedChatMessage>()
      const above = listChatMessagesAfter(id, this.floor)
      for (const row of above) rows.set(row.message.id, row)
      const wanted = dirty.filter((messageId) => !rows.has(messageId))
      const marker = latestPortableCompactionMessage(id)
      if (marker && (marker.id !== previousMarker?.id || marker.size !== previousMarker.size) && !rows.has(marker.id))
        wanted.push(marker.id)
      for (const row of getChatMessagesWithSeq(id, wanted)) rows.set(row.message.id, row)
      const messages = [...rows.values()].sort((a, b) => a.seq - b.seq).map((row) => row.message)
      if (messages.length) {
        await this.options.images.captureMessages(messages)
        const superseded = this.options.extras.questionToolCallIds()
        for (const { messageId, item } of this.project(messages, this.options.queue.transcriptInputs(), superseded)) {
          const serialized = JSON.stringify(item)
          const seen = this.emittedFor(messageId)
          if (seen.get(item.id) === serialized) continue
          seen.set(item.id, serialized)
          this.options.publish(item)
        }
      }
      this.marker = marker ? { id: marker.id, size: marker.size } : null
      if (advance !== null) {
        this.floor = advance
        if (this.nextFloor === advance) this.nextFloor = null
      } else if (above.length > FLOOR_ROWS) this.floor = above[above.length - FLOOR_ROWS - 1].seq
    } catch (error) {
      for (const messageId of dirty) this.dirty.add(messageId)
      this.marker = previousMarker
      throw error
    }
  }
  private emittedFor(messageId: string): Map<string, string> {
    const seen = this.emitted.get(messageId) ?? new Map<string, string>()
    this.emitted.delete(messageId)
    this.emitted.set(messageId, seen)
    for (const oldest of this.emitted.keys()) {
      if (this.emitted.size <= REMEMBERED_MESSAGES) break
      this.emitted.delete(oldest)
    }
    return seen
  }
  /** Projects messages without the native questions an interaction item stands for, noting their image owners. */
  private project(messages: ChatMessage[], inputs: TranscriptInputs, superseded: ReadonlySet<string>): ProjectedItem[] {
    const projected = projectMessages(messages, inputs, (part) => this.options.images.toolRefs(part)).filter(
      ({ item }) => item.kind !== 'question' || !superseded.has(item.toolCallId)
    )
    for (const { messageId, item } of projected) {
      const images = item.kind === 'user' || item.kind === 'tool' ? [...item.images, ...(item.files ?? [])] : []
      for (const image of images) {
        if (!image.id.startsWith('a-') && !image.id.startsWith('g-')) continue
        this.imageOwners.delete(image.id)
        this.imageOwners.set(image.id, messageId)
      }
    }
    for (const oldest of this.imageOwners.keys()) {
      if (this.imageOwners.size <= REMEMBERED_IMAGES) break
      this.imageOwners.delete(oldest)
    }
    return projected
  }
  private queuedItems(): FleetTranscriptItem[] {
    const queue = this.options.queue
    return queue.list().map((entry) => ({
      kind: 'user',
      id: entry.itemId,
      at: entry.at,
      text: entry.input.text,
      source: entry.input.source,
      routine: entry.input.routine,
      peer: entry.input.peer,
      queued: true,
      ...(entry.attachmentError ? { attachmentError: entry.attachmentError } : {}),
      memories: [],
      images: queue.refs(entry),
      ...(queue.fileRefs(entry).length ? { files: queue.fileRefs(entry) } : {}),
    }))
  }

  /**
   * The `limit` items (1 to 500) just before the item `before`, or the newest ones, and the cursor to the items before
   * them: the page `transcriptPage` would cut from the whole transcript. Every item of a message carries its creation
   * time, so messages are read newest first by that time until the page cannot change: once it starts after the last
   * message read, whatever order the stamps took against seq. `reasoning` items are left out unless asked for.
   */
  async page(before: string | null, requested: number, reasoning = false): Promise<FleetTranscriptPage> {
    const limit = Math.max(1, Math.min(500, requested))
    const superseded = this.options.extras.questionToolCallIds()
    const outside = [...this.queuedItems(), ...this.options.extras.list()]
    const id = this.options.conversationId()
    if (!id) return transcriptPage(outside, before, limit)
    const inputs = this.options.queue.transcriptInputs()
    // An unknown cursor (an item gone since, or one this reader never gets) gives the newest page.
    const found = before ? this.cursorItem(id, before, outside, inputs, superseded) : null
    const cursor = found && fleetTranscriptItemReadable(found, reasoning) ? found : null
    const accept = (item: FleetTranscriptItem) =>
      fleetTranscriptItemReadable(item, reasoning) && (!cursor || compareFleetTranscriptItems(item, cursor) < 0)
    const collected = outside.filter(accept)
    // Messages created after the cursor hold only items after it.
    const atOrBefore = cursor ? Date.parse(cursor.at) : Number.MAX_SAFE_INTEGER
    let after: { createdAt: number; seq: number } | null = null
    let exhausted = false
    const read = async (): Promise<ProjectedItem[]> => {
      const rows = listChatMessagesByTime(id, atOrBefore, after, PAGE_ROWS)
      if (!rows.length) {
        exhausted = true
        return []
      }
      const last = rows[rows.length - 1]
      after = { createdAt: last.message.createdAt, seq: last.seq }
      // Projected in seq order, as the whole conversation is.
      const messages = [...rows].sort((a, b) => a.seq - b.seq).map((row) => row.message)
      await this.options.images.captureMessages(messages)
      return this.project(messages, inputs, superseded)
    }
    // Messages not read yet were created at or before the last one read: they sort before a page that starts later.
    const settled = () => {
      if (collected.length < limit || !after) return false
      collected.sort(compareFleetTranscriptItems)
      return Date.parse(collected[collected.length - limit].at) > after.createdAt
    }
    while (!exhausted && !settled()) for (const { item } of await read()) if (accept(item)) collected.push(item)
    collected.sort(compareFleetTranscriptItems)
    const start = Math.max(0, collected.length - limit)
    const items = collected.slice(start)
    // The cursor to older items exists when anything sorts before the page: read or still unread.
    let older = start > 0
    while (!older && !exhausted && items.length) older = (await read()).some(({ item }) => accept(item))
    return { items, before: older ? items[0].id : null }
  }
  /** The item a page cursor names, as it is now, or null when it is gone. */
  private cursorItem(
    id: string,
    before: string,
    outside: FleetTranscriptItem[],
    inputs: TranscriptInputs,
    superseded: ReadonlySet<string>
  ): FleetTranscriptItem | null {
    const known = outside.find((item) => item.id === before)
    if (known) return known
    const find = (messages: StoredChatMessage[]) =>
      this.project(messages, inputs, superseded).find(({ item }) => item.id === before)?.item ?? null
    if (before.startsWith('input:')) {
      const record = this.options.queue.byItemId(before)
      if (!record?.started) return null
      if (record.nativeMessageId)
        return find(getChatMessagesWithSeq(id, [record.nativeMessageId]).map((row) => row.message))
      // Linked by its text until it is mapped: its message came since the input.
      return find(listChatMessagesSince(id, Date.parse(record.at) - 1_000))
    }
    const part = /^(.*):(\d+)$/.exec(before)
    return part ? find(getChatMessagesWithSeq(id, [part[1]]).map((row) => row.message)) : null
  }
  /** The user messages the queue may still map its started inputs to: every one created at or after `time`. */
  userMessagesSince(time: number): Array<{ id: string; at: number; text: string }> {
    const id = this.options.conversationId()
    if (!id) return []
    return listChatMessagesSince(id, time)
      .filter((message) => message.role === 'user')
      .map((message) => ({
        id: message.id,
        at: message.createdAt,
        text: message.parts
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join(''),
      }))
  }
  /** The messages of the current turn: those after the newest message when it started. */
  turnMessages(): StoredChatMessage[] {
    const id = this.options.conversationId()
    if (!id) return []
    return listChatMessagesAfter(id, this.nextFloor ?? this.floor).map((row) => row.message)
  }
  /** The item with this id among the current turn's messages. */
  turnItem(itemId: string): FleetTranscriptItem | null {
    const superseded = this.options.extras.questionToolCallIds()
    return (
      this.project(this.turnMessages(), this.options.queue.transcriptInputs(), superseded).find(
        ({ item }) => item.id === itemId
      )?.item ?? null
    )
  }
  /** The text of the last assistant item of a message: what a turn's summary quotes. */
  lastAssistantText(messageId: string | null): string | null {
    const id = this.options.conversationId()
    if (!id || !messageId) return null
    const messages = getChatMessagesWithSeq(id, [messageId]).map((row) => row.message)
    const last = projectMessages(messages, this.options.queue.transcriptInputs())
      .map(({ item }) => item)
      .filter((item) => item.kind === 'assistant')
      .at(-1)
    return last?.kind === 'assistant' ? last.text : null
  }
  /** The message holding a tool call: the running turn's, else one of the newest. */
  messageWithToolCall(toolCallId: string): ChatMessage | null {
    const id = this.options.conversationId()
    if (!id) return null
    const holds = (message: ChatMessage) =>
      message.parts.some((part) => part.type === 'tool' && part.toolCallId === toolCallId)
    return (
      this.turnMessages().find(holds) ??
      findLatestChatMessage(id, holds, {
        partsContaining: `"toolCallId":${JSON.stringify(toolCallId)}`,
        withinNewest: TOOL_CALL_ROWS,
      })?.message ??
      null
    )
  }
  /** The messages that may hold an attachment or generated image: its owner when known, else a search. */
  imageMessages(imageIdValue: string): ChatMessage[] {
    const id = this.options.conversationId()
    if (!id || (!imageIdValue.startsWith('a-') && !imageIdValue.startsWith('g-'))) return []
    const owner = this.imageOwners.get(imageIdValue)
    if (owner) {
      const messages = getChatMessagesWithSeq(id, [owner]).map((row) => row.message)
      if (messages.length) return messages
    }
    const holds = (message: ChatMessage) =>
      message.parts.some(
        (part: MessagePart) =>
          (part.type === 'file' && part.kind === 'image' && imageId('a', message.id, part.id) === imageIdValue) ||
          (part.type === 'generated-image' && imageId('g', message.id, part.id) === imageIdValue)
      )
    const found = findLatestChatMessage(id, holds, { partsContaining: '"artifactId"' })
    return found ? [found.message] : []
  }

  fileMessages(fileId: string): ChatMessage[] {
    const id = this.options.conversationId()
    if (!id || !fileId.startsWith('a-')) return []
    const owner = this.imageOwners.get(fileId)
    if (owner) {
      const messages = getChatMessagesWithSeq(id, [owner]).map((row) => row.message)
      if (messages.length) return messages
    }
    const found = findLatestChatMessage(
      id,
      (message) =>
        message.role === 'user' &&
        message.parts.some(
          (part) =>
            part.type === 'file' &&
            (part.kind === 'pdf' || part.kind === 'text') &&
            imageId('a', message.id, part.id) === fileId
        ),
      { partsContaining: '"type":"file"' }
    )
    return found ? [found.message] : []
  }
}
