import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', async (importOriginal) => {
  const original = await importOriginal<typeof import('electron')>()
  return { ...original, app: { ...original.app, getPath: () => h.userData } }
})

const { closeDb, freshDb } = await import('../helpers/db')
const { upsertChatMessage } = await import('../../src/main/chat/chat-store')
const { createStandaloneConversation } = await import('../../src/main/standalone-conversation-service')
const { findFileOrigins } = await import('../../src/main/fleet/instance/file-origins')

beforeEach(async () => {
  h.userData = await realpath(await mkdtemp(path.join(os.tmpdir(), 'fleet-origins-')))
  freshDb()
})
afterEach(async () => {
  closeDb()
  await rm(h.userData, { recursive: true, force: true })
})

describe('findFileOrigins', () => {
  it('finds where and when completed bot_share_file calls shared each file', async () => {
    const c1 = await createStandaloneConversation({ name: 'Primary' })
    const c2 = await createStandaloneConversation({ name: 'Run' })
    const refA = { id: 'f-a', name: 'a.pdf', mediaType: 'application/pdf', byteSize: 10 }
    const refB = { id: 'f-b', name: 'b.pdf', mediaType: 'application/pdf', byteSize: 20 }
    const refC = { id: 'f-c', name: 'c.pdf', mediaType: 'application/pdf', byteSize: 30 }
    const t1 = Date.parse('2026-10-10T10:00:00.000Z')
    const t2 = Date.parse('2026-10-11T12:00:00.000Z')
    upsertChatMessage({
      id: randomUUID(),
      conversationId: c1.id,
      role: 'assistant',
      createdAt: t1,
      parts: [
        {
          type: 'tool',
          id: randomUUID(),
          toolCallId: randomUUID(),
          toolName: 'mcp__maestrly__bot_share_file',
          input: {},
          state: { status: 'completed', output: { text: JSON.stringify({ file: refA }) } },
        },
        {
          type: 'tool',
          id: randomUUID(),
          toolCallId: randomUUID(),
          toolName: 'mcp__maestrly__bot_share_file',
          input: {},
          state: { status: 'error', error: JSON.stringify({ file: refC }) },
        },
      ],
      finishReason: 'stop',
    })
    upsertChatMessage({
      id: randomUUID(),
      conversationId: c2.id,
      role: 'assistant',
      createdAt: t2,
      parts: [
        {
          type: 'tool',
          id: randomUUID(),
          toolCallId: randomUUID(),
          toolName: 'mcp__maestrly__bot_share_file',
          input: {},
          state: { status: 'completed', output: { text: JSON.stringify({ file: refB }) } },
        },
      ],
      finishReason: 'stop',
    })

    const origins = findFileOrigins([
      { conversationId: c1.id, origin: { kind: 'primary' } },
      { conversationId: c2.id, origin: { kind: 'routine', runId: 'r', title: 'T' } },
    ])
    expect(origins.get('f-a')).toEqual({
      origin: { kind: 'primary' },
      sharedAt: new Date(t1).toISOString(),
    })
    expect(origins.get('f-b')).toEqual({
      origin: { kind: 'routine', runId: 'r', title: 'T' },
      sharedAt: new Date(t2).toISOString(),
    })
    expect(origins.has('f-c')).toBe(false)
  })
})
