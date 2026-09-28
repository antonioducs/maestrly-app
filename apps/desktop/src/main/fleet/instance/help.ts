import { randomUUID } from 'node:crypto'
import type { FleetPendingInteraction, FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import type { InstanceTranscriptExtras } from './transcript'

export class InstanceHelpStore {
  constructor(
    private readonly extras: InstanceTranscriptExtras,
    private readonly changed: () => void
  ) {}
  pending(): FleetPendingInteraction[] {
    return this.extras
      .list()
      .filter(
        (item): item is Extract<FleetTranscriptItem, { kind: 'help' }> =>
          item.kind === 'help' && item.state === 'pending'
      )
      .map((item) => ({ kind: 'help', id: item.helpId, at: item.at, reason: item.reason, itemId: item.id }))
  }
  async requestHelp(reason: string): Promise<string> {
    if (!reason.trim() || reason.length > 500) throw new Error('Help reason must contain 1–500 characters.')
    const id = randomUUID()
    await this.extras.upsert({
      kind: 'help',
      id: 'help:' + id,
      helpId: id,
      at: new Date().toISOString(),
      reason,
      state: 'pending',
      resolvedAt: null,
      note: null,
    })
    this.changed()
    return id
  }
  async resolve(id: string, note: string | null): Promise<boolean> {
    const item = this.extras.list().find((entry) => entry.kind === 'help' && entry.helpId === id)
    if (item?.kind !== 'help' || item.state !== 'pending') return false
    await this.extras.upsert({ ...item, state: 'resolved', resolvedAt: new Date().toISOString(), note })
    this.changed()
    return true
  }
  async resolveAll(note: string | null): Promise<void> {
    for (const item of this.pending()) await this.resolve(item.id, note)
  }
}
