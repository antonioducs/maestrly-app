import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach } from 'vitest'
import type { TurnSnapshot } from '@maestrly/host-protocol'
const directories: string[] = []
export async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), 'bot-runtime-'))
  directories.push(directory)
  return directory
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
export function snapshot(overrides: Partial<TurnSnapshot> = {}): TurnSnapshot {
  return {
    botId: 'bot',
    conversationId: 'conversation',
    turnId: randomUUID(),
    generation: 1,
    permissionMode: 'ask',
    policyRevision: 0,
    network: { mode: 'offline', domains: [], revision: 0 },
    instructions: '',
    memory: [],
    recentMessages: [],
    message: 'hello',
    attachments: [],
    leaseMs: 5000,
    limits: { activeMs: 10_000, maxTools: 10, maxLogBytes: 100_000 },
    ...overrides,
  }
}
