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
  constructor(private readonly file: string) {}

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

  private async save(): Promise<void> {
    const contents = JSON.stringify({ items: this.items })
    const write = this.writeTail.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
      const temp = this.file + '.' + randomUUID() + '.tmp'
      try {
        await fs.writeFile(temp, contents, { mode: 0o600 })
        await fs.rename(temp, this.file)
      } finally {
        await fs.rm(temp, { force: true }).catch(() => undefined)
      }
    })
    this.writeTail = write.catch(() => undefined)
    await write
  }

  async enqueue(raw: FleetInstanceInput): Promise<FleetInputReceipt> {
    const input = fleetInstanceInputSchema.parse(raw)
    if (input.source === 'routine' && !input.routine) throw new Error('Routine source requires routine metadata.')
    if (input.source === 'peer' && !input.peer) throw new Error('Peer source requires peer metadata.')
    const now = Date.now()
    const existing = [...this.items]
      .reverse()
      .find(
        (item) => item.input.idempotencyKey === input.idempotencyKey && now - Date.parse(item.at) < 24 * 60 * 60 * 1_000
      )
    if (existing) return { inputId: existing.id, itemId: existing.itemId, queued: !existing.started }
    const id = randomUUID()
    const item: QueuedInput = { id, at: new Date().toISOString(), input, itemId: 'input:' + id, started: false }
    if (input.source === 'continuation') this.items.unshift(item)
    else this.items.push(item)
    await this.save()
    return { inputId: id, itemId: item.itemId, queued: true }
  }

  async delete(id: string): Promise<'deleted' | 'started' | 'missing'> {
    const index = this.items.findIndex((item) => item.id === id)
    if (index < 0) return 'missing'
    if (this.items[index].started) return 'started'
    this.items.splice(index, 1)
    await this.save()
    return 'deleted'
  }

  async markStarted(id: string): Promise<void> {
    const item = this.items.find((candidate) => candidate.id === id)
    if (!item) throw new Error('Input not found')
    item.started = true
    await this.save()
  }

  async mapNativeMessage(id: string, messageId: string): Promise<void> {
    const item = this.items.find((candidate) => candidate.id === id)
    if (!item?.started) throw new Error('Started input not found')
    item.nativeMessageId = messageId
    await this.save()
  }

  async reconcile(nativeUsers: Array<{ id: string; at: number; text: string }>): Promise<void> {
    const claimed = new Set(this.items.map((item) => item.nativeMessageId).filter((id): id is string => !!id))
    let changed = false
    for (const item of this.items) {
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
    if (changed) await this.save()
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
