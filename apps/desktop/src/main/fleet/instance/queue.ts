import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fleetInstanceInputSchema, type FleetInstanceInput, type FleetInputReceipt } from '@maestrly/bot-fleet-protocol'
import { z } from 'zod'

export interface QueuedInput {
  id: string
  at: string
  input: FleetInstanceInput
  itemId: string
  started: boolean
  nativeMessageId?: string
}
const recordSchema = z.object({
  id: z.string().uuid(),
  at: z.iso.datetime(),
  input: fleetInstanceInputSchema,
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

  async enqueue(raw: FleetInstanceInput): Promise<FleetInputReceipt> {
    const input = fleetInstanceInputSchema.parse(raw)
    if (input.source === 'routine' && !input.routine) throw new Error('Routine source requires routine metadata.')
    if (input.source === 'peer' && !input.peer) throw new Error('Peer source requires peer metadata.')
    return this.update((items) => {
      const now = Date.now()
      const existing = [...items]
        .reverse()
        .find(
          (item) =>
            item.input.idempotencyKey === input.idempotencyKey && now - Date.parse(item.at) < 24 * 60 * 60 * 1_000
        )
      if (existing)
        return { result: { inputId: existing.id, itemId: existing.itemId, queued: !existing.started }, changed: false }
      const id = randomUUID()
      const item: QueuedInput = { id, at: new Date().toISOString(), input, itemId: 'input:' + id, started: false }
      if (input.source === 'continuation') items.unshift(item)
      else items.push(item)
      return { result: { inputId: id, itemId: item.itemId, queued: true }, changed: true }
    })
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

export function promptForInput(input: FleetInstanceInput): string {
  switch (input.source) {
    case 'owner':
      return input.text
    case 'routine':
      return `Scheduled routine "${input.routine?.title ?? ''}". Do this now:\n\n${input.text}`
    case 'peer':
      return `Message from bot "${input.peer?.name ?? ''}" (id ${input.peer?.botId ?? ''}), delivered by the Maestrly gateway:\n\n${input.text}\n\nIf a reply is useful, send it with bot_peers_send.`
    case 'continuation':
      return input.text
  }
}
