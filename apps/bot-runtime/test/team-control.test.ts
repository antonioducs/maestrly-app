import { createServer, connect, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { GUEST_PROTOCOL, TEAM_CAPABILITY, TEAM_LIMITS } from '@maestrly/host-protocol'
import { encodeFrame, FrameDecoder } from '../src/control/framing.js'
import { Journal } from '../src/control/journal.js'
import { ControlSession, type HandlerMap } from '../src/control/session.js'
import { temporary } from './helpers.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})
/** A connected control channel with the Host side under the test's control. */
async function channel() {
  const journal = new Journal(await temporary())
  const path = join(await temporary(), 'control.sock')
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(path, resolve))
  const accepted = new Promise<Socket>((resolve) => server.once('connection', resolve))
  const host = connect(path)
  const guest = await accepted
  const frames: Record<string, any>[] = []
  const decoder = new FrameDecoder()
  host.on('data', (chunk) => frames.push(...(decoder.push(chunk) as Record<string, any>[])))
  host.on('error', () => {})
  const handlers = { 'runtime.inspect': () => ({ state: 'ready' }), 'turn.lease': () => ({ renewed: true }) } as unknown as HandlerMap
  const session = new ControlSession(guest, journal, handlers)
  cleanups.push(() => {
    session.close()
    host.destroy()
    server.close()
  })
  await session.start({ version: '0.2.0', capabilities: [TEAM_CAPABILITY], bootId: randomUUID() })
  await vi.waitFor(() => expect(frames[0]?.type).toBe('hello'))
  host.write(encodeFrame({ type: 'welcome', protocol: GUEST_PROTOCOL, sessionId: randomUUID(), nonce: frames[0].nonce, hostGeneration: 1 }))
  // A round trip proves the handshake completed before the test acts on the session.
  host.write(encodeFrame({ type: 'request', id: 'ready', method: 'runtime.inspect', params: {} }))
  await vi.waitFor(() => expect(frames.find((frame) => frame.id === 'ready')?.result).toEqual({ state: 'ready' }))
  return { host, frames, session, journal }
}
const collaborationFrames = (frames: Record<string, any>[]) => frames.filter((frame) => frame.type === 'collaboration.request')

it('announces the team capability and carries collaboration on the existing private channel', async () => {
  const c = await channel()
  expect(c.frames[0].capabilities).toContain(TEAM_CAPABILITY)
  const pending = c.session.requestCollaboration({ turnId: 'turn-1', generation: 1, method: 'team_members', params: {} })
  await vi.waitFor(() => expect(collaborationFrames(c.frames)).toHaveLength(1))
  const request = collaborationFrames(c.frames)[0]
  // The frame carries the turn it belongs to, never a bot, team or role of its own.
  expect(request).toMatchObject({ type: 'collaboration.request', turnId: 'turn-1', generation: 1, method: 'team_members' })
  expect(request.sourceBotId).toBeUndefined()
  expect(request.teamId).toBeUndefined()
  expect(request.role).toBeUndefined()
  c.host.write(encodeFrame({ type: 'collaboration.response', id: request.id, result: { runId: 'run-1', members: [] } }))
  await expect(pending).resolves.toMatchObject({ runId: 'run-1' })
})

it('propagates the Host refusal with its stable code', async () => {
  const c = await channel()
  const pending = c.session.requestCollaboration({ turnId: 'turn-1', generation: 1, method: 'team_delegate', params: { tasks: [] } })
  await vi.waitFor(() => expect(collaborationFrames(c.frames)).toHaveLength(1))
  const request = collaborationFrames(c.frames)[0]
  c.host.write(encodeFrame({ type: 'collaboration.response', id: request.id, error: { code: 'TEAM_COORDINATOR_REQUIRED', message: 'Apenas o coordenador' } }))
  await expect(pending).rejects.toMatchObject({ code: 'TEAM_COORDINATOR_REQUIRED' })
})

it('ignores an answer to an unknown request instead of resolving the wrong one', async () => {
  const c = await channel()
  const pending = c.session.requestCollaboration({ turnId: 'turn-1', generation: 1, method: 'team_status', params: {} })
  await vi.waitFor(() => expect(collaborationFrames(c.frames)).toHaveLength(1))
  const request = collaborationFrames(c.frames)[0]
  c.host.write(encodeFrame({ type: 'collaboration.response', id: randomUUID(), result: { runId: 'outro' } }))
  await new Promise((resolve) => setTimeout(resolve, 50))
  c.host.write(encodeFrame({ type: 'collaboration.response', id: request.id, result: { runId: 'certo' } }))
  await expect(pending).resolves.toMatchObject({ runId: 'certo' })
})

it('bounds collaboration in flight so it cannot starve leases and account renewal', async () => {
  const c = await channel()
  const pending: Promise<unknown>[] = []
  for (let index = 0; index < TEAM_LIMITS.requestsInFlightMax; index++)
    pending.push(c.session.requestCollaboration({ turnId: 'turn-1', generation: 1, method: 'team_status', params: {} }).catch(() => undefined))
  await expect(c.session.requestCollaboration({ turnId: 'turn-1', generation: 1, method: 'team_status', params: {} })).rejects.toMatchObject({
    code: 'TEAM_BUSY',
  })
  // Lease renewal on the same channel is unaffected by a saturated collaboration lane.
  c.host.write(encodeFrame({ type: 'request', id: 'lease', method: 'turn.lease', params: { turnId: 'turn-1', generation: 1, leaseMs: 5_000 } }))
  await vi.waitFor(() => expect(c.frames.find((frame) => frame.id === 'lease')?.result).toEqual({ renewed: true }))
  void pending
})

it('fails an outstanding request when the channel closes, with a consultable outcome', async () => {
  const c = await channel()
  const pending = c.session.requestCollaboration({ turnId: 'turn-1', generation: 1, method: 'team_publish_file', params: { path: 'x.md' } })
  await vi.waitFor(() => expect(collaborationFrames(c.frames)).toHaveLength(1))
  c.session.close()
  // A closed channel never silently succeeds; the caller learns it must reconcile.
  await expect(pending).rejects.toMatchObject({ code: 'TEAM_UNAVAILABLE' })
  await expect(c.session.requestCollaboration({ turnId: 'turn-1', generation: 1, method: 'team_status', params: {} })).rejects.toMatchObject({
    code: 'TEAM_UNAVAILABLE',
  })
})

it('closes the channel on a malformed collaboration answer instead of guessing', async () => {
  const c = await channel()
  const pending = c.session.requestCollaboration({ turnId: 'turn-1', generation: 1, method: 'team_members', params: {} })
  await vi.waitFor(() => expect(collaborationFrames(c.frames)).toHaveLength(1))
  const request = collaborationFrames(c.frames)[0]
  c.host.write(encodeFrame({ type: 'collaboration.response', id: request.id, result: {}, error: { code: 'X', message: 'y' }, extra: true }))
  await expect(pending).rejects.toBeTruthy()
})
