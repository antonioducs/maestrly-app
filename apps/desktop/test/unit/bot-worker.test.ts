import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BotClaim } from '@maestrly/protocol'
import { freshDb, closeDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { BotConversationWorker, type BotWorkerOptions } from '../../src/main/bot/worker'
import { BotCommandJournal } from '../../src/main/bot/command-journal'

beforeEach(freshDb)
afterEach(closeDb)

function fixture() {
  const connectionId = randomUUID(),
    desktopId = randomUUID(),
    remoteId = randomUUID(),
    commandId = randomUUID()
  const local = makeConversation(makeWorkspace().id)
  const claim: BotClaim = {
    owner: { userId: 'owner' },
    connection: {
      id: connectionId,
      ownerUserId: 'owner',
      desktopId,
      clientId: 'client',
      name: 'Grok Bot',
      version: 1,
      revokedAt: null,
      grants: [
        { workspaceId: local.workspaceId, actions: ['chats:read', 'chats:write', 'chats:control', 'chats:answer'] },
      ],
    },
    conversation: {
      id: remoteId,
      connectionId,
      desktopId,
      workspaceId: local.workspaceId,
      name: 'Work',
      baseBranch: 'main',
      selection: { selectionId: 'model' },
      managementState: 'active',
      version: 1,
    },
    command: {
      id: commandId,
      conversationId: remoteId,
      kind: 'create',
      payload: { message: 'Hello' },
      status: 'leased',
      leaseToken: randomUUID(),
      version: 1,
    },
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    fence: 1,
  }
  const queue: BotClaim[] = [claim]
  let state: 'active' | 'paused' | 'revoked' = 'active'
  const options: BotWorkerOptions = {
    instanceId: 'instance',
    desktopId,
    connectionId,
    ownerUserId: 'owner',
    workspaceIds: [local.workspaceId],
    client: {
      claim: vi.fn(async () => queue.shift() ?? null),
      lease: vi.fn(async () => ({
        cancellationRequested: false,
        managementState: state,
        leaseExpiresAt: claim.leaseExpiresAt,
      })),
      controls: vi.fn(async () => ({
        cancellationRequested: false,
        managementState: state,
        leaseExpiresAt: claim.leaseExpiresAt,
      })),
      upload: vi.fn(async () => {}),
      complete: vi.fn(async () => {}),
      inventory: vi.fn(async () => {}),
    },
    native: {
      configure: vi.fn(async () => {}),
      start: vi.fn(async () => ({ done: Promise.resolve({ status: 'success' }), cancel: vi.fn() })),
      observe: vi.fn(() => () => {}),
      answer: vi.fn(),
      stop: vi.fn(async () => {}),
    },
    conversations: {
      create: vi.fn(async () => local),
      find: vi.fn(() => local.id),
      resume: vi.fn(async () => local),
      management: () => state,
      setManagement: (_id, next) => {
        state = next
      },
      rename: vi.fn(),
    },
  }
  return {
    options,
    claim,
    queue,
    local,
    pause: () => {
      state = 'paused'
    },
  }
}

it('executes a native conversation once and reports a saved receipt on a repeated claim', async () => {
  const f = fixture()
  const worker = new BotConversationWorker(f.options)
  expect(await worker.pollOnce()).toBe(true)
  await worker.idle()
  f.queue.push({ ...f.claim, fence: 2, command: { ...f.claim.command, leaseToken: randomUUID() } })
  await worker.pollOnce()
  await worker.idle()
  expect(f.options.conversations.create).toHaveBeenCalledTimes(1)
  expect(f.options.native.start).toHaveBeenCalledTimes(1)
  expect(f.options.client.complete).toHaveBeenLastCalledWith(
    expect.objectContaining({ fence: 2 }),
    expect.objectContaining({ status: 'succeeded', fence: 2 })
  )
  await worker.stop()
})

it('does not replay a native prompt after a crash at the admission boundary', async () => {
  const f = fixture()
  const journal = new BotCommandJournal('instance')
  journal.admit(f.claim.command.id, f.claim.conversation.id, 'create', f.claim.command.payload)
  journal.markNativeStart(f.claim.command.id)
  const worker = new BotConversationWorker(f.options)
  await worker.pollOnce()
  await worker.idle()
  expect(f.options.native.start).not.toHaveBeenCalled()
  expect(f.options.client.complete).toHaveBeenCalledWith(
    f.claim,
    expect.objectContaining({ status: 'failed', error: expect.stringContaining('not replayed') })
  )
  await worker.stop()
})

it.each(['owner', 'connection', 'desktop', 'workspace'] as const)(
  'rejects a claim crossing the %s boundary before admission',
  async (boundary) => {
    const f = fixture()
    if (boundary === 'owner') f.claim.owner.userId = 'other-owner'
    if (boundary === 'connection') f.claim.connection.id = randomUUID()
    if (boundary === 'desktop') f.claim.conversation.desktopId = randomUUID()
    if (boundary === 'workspace') f.options.workspaceIds = []
    const worker = new BotConversationWorker(f.options)
    await expect(worker.pollOnce()).rejects.toThrow(/authorized desktop/)
    expect(f.options.native.start).not.toHaveBeenCalled()
    await worker.stop()
  }
)

it('resumes the existing local conversation without creating another worktree', async () => {
  const f = fixture()
  f.claim.command.kind = 'send'
  f.claim.command.payload = { text: 'Continue' }
  const worker = new BotConversationWorker(f.options)
  await worker.pollOnce()
  await worker.idle()
  expect(f.options.conversations.create).not.toHaveBeenCalled()
  expect(f.options.conversations.resume).toHaveBeenCalledWith(
    expect.objectContaining({ connectionId: f.claim.connection.id }),
    f.local.id
  )
  expect(f.options.native.start).toHaveBeenCalledWith(
    expect.objectContaining({ conversationId: f.local.id, prompt: 'Continue' })
  )
  await worker.stop()
})

it('does not run a prompt if the owner paused during model preflight', async () => {
  const f = fixture()
  f.options.native.configure = vi.fn(async () => f.pause())
  const worker = new BotConversationWorker(f.options)
  await worker.pollOnce()
  await worker.idle()
  expect(f.options.native.start).not.toHaveBeenCalled()
  expect(f.options.client.complete).toHaveBeenCalledWith(
    f.claim,
    expect.objectContaining({ status: 'failed', error: expect.stringContaining('paused') })
  )
  await worker.stop()
})

it('stops the native turn when its lease cannot be renewed', async () => {
  const f = fixture()
  let finish!: (result: { status: string }) => void
  const cancel = vi.fn(() => finish({ status: 'cancelled' }))
  f.options.native.start = vi.fn(async () => ({
    done: new Promise<{ status: string }>((resolve) => {
      finish = resolve
    }),
    cancel,
  }))
  f.options.client.lease = vi.fn(async () => {
    throw new Error('Revoked')
  })
  const worker = new BotConversationWorker(f.options)
  await worker.pollOnce()
  await worker.idle()
  expect(cancel).toHaveBeenCalledOnce()
  expect(f.options.client.complete).toHaveBeenCalledWith(
    f.claim,
    expect.objectContaining({ status: 'cancelled', error: 'Revoked' })
  )
  await worker.stop()
})

it('holds the chat while it configures and runs its turn, and lets it go when the turn ends', async () => {
  const f = fixture()
  const order: string[] = []
  let releaseTurn!: () => void
  f.options.native.acquire = vi.fn(async () => {
    order.push('acquire')
    return () => order.push('release')
  })
  f.options.native.configure = vi.fn(async () => void order.push('configure'))
  f.options.native.start = vi.fn(async () => {
    order.push('start')
    return {
      done: new Promise<{ status: string }>((resolve) => {
        releaseTurn = () => resolve({ status: 'success' })
      }),
      cancel: vi.fn(),
    }
  })
  const worker = new BotConversationWorker(f.options)
  await worker.pollOnce()
  await vi.waitFor(() => expect(order).toEqual(['acquire', 'configure', 'start']))
  releaseTurn()
  await worker.idle()
  // Account, model and permission mode are chosen inside the slot, never on a turn already running.
  expect(order).toEqual(['acquire', 'configure', 'start', 'release'])
  await worker.stop()
})

it('does not configure the chat when waiting for the person’s turn is interrupted', async () => {
  const f = fixture()
  f.options.native.acquire = vi.fn(async () => {
    throw new Error('The bot command was interrupted while the chat was busy.')
  })
  const worker = new BotConversationWorker(f.options)
  await worker.pollOnce()
  await worker.idle()
  expect(f.options.native.configure).not.toHaveBeenCalled()
  expect(f.options.native.start).not.toHaveBeenCalled()
  expect(f.options.client.complete).toHaveBeenCalledWith(
    f.claim,
    expect.objectContaining({ status: 'failed', error: expect.stringContaining('interrupted') })
  )
  await worker.stop()
})
