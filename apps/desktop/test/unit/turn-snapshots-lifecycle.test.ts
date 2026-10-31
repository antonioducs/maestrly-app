import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ gitAvailable: true, holdCapture: false }))

vi.mock('../../src/main/turn-snapshots/git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/turn-snapshots/git')>()
  return { ...actual, snapshotGitAvailable: async () => h.gitAvailable }
})
vi.mock('../../src/main/turn-snapshots/capture', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/turn-snapshots/capture')>()
  return {
    ...actual,
    captureTree: (...args: Parameters<typeof actual.captureTree>) =>
      h.holdCapture ? new Promise<never>(() => undefined) : actual.captureTree(...args),
  }
})

const { closeDb, freshDb } = await import('../helpers/db')
const { makeStandaloneConversation } = await import('../helpers/factories')
const { upsertChatMessage } = await import('../../src/main/chat/chat-store')
const {
  beginTurnSnapshot,
  configureTurnSnapshotLifecycle,
  resetTurnSnapshotLifecycleForTests,
  START_CAPTURE_BUDGET_MS,
} = await import('../../src/main/turn-snapshots/lifecycle')
const { getSnapshotRecord } = await import('../../src/main/turn-snapshots/records')
const { setTurnSnapshotsRoot } = await import('../../src/main/turn-snapshots/store')

const temps: string[] = []
function tempDir(prefix: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  temps.push(dir)
  return dir
}

function userMessage(conversationId: string): string {
  const id = randomUUID()
  upsertChatMessage({
    id,
    conversationId,
    role: 'user',
    createdAt: Date.now(),
    parts: [{ type: 'text', id: `${id}_t`, text: 'go' }],
  })
  return id
}

beforeEach(() => {
  freshDb()
  setTurnSnapshotsRoot(tempDir('turn-lifecycle-root-'))
  configureTurnSnapshotLifecycle({ notify: () => undefined })
  h.gitAvailable = true
  h.holdCapture = false
})
afterEach(() => {
  vi.useRealTimers()
  resetTurnSnapshotLifecycleForTests()
  setTurnSnapshotsRoot(null)
  closeDb()
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('turn snapshot availability', () => {
  it('runs the turn without a snapshot when Git is missing', async () => {
    h.gitAvailable = false
    const conversation = makeStandaloneConversation({ cwd: tempDir('turn-lifecycle-nogit-') })
    const handle = beginTurnSnapshot({ conversation })!
    await handle.attach(userMessage(conversation.id))
    handle.end('assistant')
    expect(getSnapshotRecord(handle.recordId)).toMatchObject({
      status: 'unavailable',
      unavailableReason: 'git-missing',
    })
  })

  it('does not hold a turn longer than the start budget', async () => {
    h.holdCapture = true
    vi.useFakeTimers()
    const conversation = makeStandaloneConversation({ cwd: tempDir('turn-lifecycle-slow-') })
    const handle = beginTurnSnapshot({ conversation })!
    let attached = false
    const attaching = handle.attach(userMessage(conversation.id)).then(() => {
      attached = true
    })
    await vi.advanceTimersByTimeAsync(START_CAPTURE_BUDGET_MS - 100)
    expect(attached).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    await attaching
    expect(getSnapshotRecord(handle.recordId)).toMatchObject({ status: 'unavailable', unavailableReason: 'slow' })
  })
})
