import { createServer, connect, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONTROL_FRAME_MAX, GUEST_PROTOCOL } from '@maestrly/host-protocol'
import { encodeFrame, FrameDecoder } from '../src/control/framing.js'
import { Journal } from '../src/control/journal.js'
import { ControlSession, type HandlerMap } from '../src/control/session.js'
import { temporary } from './helpers.js'
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})
async function channel(journal: Journal) {
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
  const session = new ControlSession(guest, journal, { 'runtime.inspect': () => ({ state: 'ready' }) } as HandlerMap)
  cleanups.push(() => {
    session.close()
    host.destroy()
    server.close()
  })
  await session.start({ version: '0.1.0', capabilities: [], bootId: randomUUID() })
  await vi.waitFor(() => expect(frames[0]?.type).toBe('hello'))
  const welcome = (nonce = frames[0].nonce) =>
    host.write(
      encodeFrame({ type: 'welcome', protocol: GUEST_PROTOCOL, sessionId: randomUUID(), nonce, hostGeneration: 1 })
    )
  return { host, frames, session, welcome }
}
describe('control channel', () => {
  it('bounds individual frames and rejects invalid UTF-8', () => {
    expect(() => encodeFrame({ x: 'x'.repeat(CONTROL_FRAME_MAX) })).toThrow()
    expect(() => new FrameDecoder().push(Buffer.alloc(CONTROL_FRAME_MAX))).toThrow()
    expect(() => new FrameDecoder().push(Buffer.from([34, 255, 34, 10]))).toThrow()
    const decoder = new FrameDecoder()
    expect(decoder.push(Buffer.from('{"x":'))).toEqual([])
    expect(decoder.push(Buffer.from('1}\n{}\n'))).toEqual([{ x: 1 }, {}])
  })
  it('sends hello first, validates welcome echo, dispatches requests and rejects invalid methods', async () => {
    const journal = new Journal(await temporary())
    journal.event({ kind: 'diagnostic', summary: 'queued' })
    const c = await channel(journal)
    expect(c.frames).toHaveLength(1)
    c.welcome()
    c.host.write(encodeFrame({ type: 'request', id: 'inspect', method: 'runtime.inspect', params: {} }))
    c.host.write(encodeFrame({ type: 'request', id: 'bad', method: 'unknown', params: {} }))
    await vi.waitFor(() => expect(c.frames.find((f) => f.id === 'inspect')?.result).toEqual({ state: 'ready' }))
    expect(c.frames.find((f) => f.id === 'bad')?.error.code).toBe('INVALID_REQUEST')
  })
  it('closes on bad nonce, pre-welcome requests and invalid JSON', async () => {
    for (const mode of ['nonce', 'early', 'json']) {
      const c = await channel(new Journal(await temporary()))
      if (mode === 'nonce') c.welcome('a'.repeat(32))
      if (mode === 'early')
        c.host.write(encodeFrame({ type: 'request', id: 'early', method: 'runtime.inspect', params: {} }))
      if (mode === 'json') c.host.write('invalid\n')
      await c.session.done
    }
  })
  it('redelivers only unacked events in order after reconnect', async () => {
    const journal = new Journal(await temporary())
    const first = journal.event({ kind: 'diagnostic', summary: 'first' })
    const second = journal.event({ kind: 'diagnostic', summary: 'second' })
    const c = await channel(journal)
    c.welcome()
    await vi.waitFor(() => expect(c.frames.filter((f) => f.type === 'event')).toHaveLength(2))
    c.host.write(encodeFrame({ type: 'ack', runtimeEventId: first.runtimeEventId }))
    await vi.waitFor(() => expect(journal.pendingEvents()).toEqual([second]))
    c.session.close()
    const reconnected = await channel(journal)
    reconnected.welcome()
    await vi.waitFor(() => expect(reconnected.frames.filter((f) => f.type === 'event')).toHaveLength(1))
    expect(reconnected.frames[1].runtimeEventId).toBe(second.runtimeEventId)
    expect(reconnected.frames[0].generation).toBe(2)
  })
})

it('holds excess events until ACK and ignores unknown ACK ids', async () => {
  const journal = new Journal(await temporary())
  for (let i = 0; i < 65; i++) journal.event({ kind: 'diagnostic', summary: String(i) })
  const c = await channel(journal)
  c.welcome()
  await vi.waitFor(() => expect(c.frames.filter((frame) => frame.type === 'event')).toHaveLength(64))
  c.host.write(encodeFrame({ type: 'ack', runtimeEventId: 'unknown' }))
  c.host.write(encodeFrame({ type: 'ack', runtimeEventId: journal.pendingEvents()[0].runtimeEventId }))
  await vi.waitFor(() => expect(c.frames.filter((frame) => frame.type === 'event')).toHaveLength(65))
  expect(journal.pendingEvents()).toHaveLength(64)
})

it('coalesces private account refresh requests without writing credentials to the event journal', async () => {
  const journal = new Journal(await temporary())
  const c = await channel(journal)
  c.welcome()
  c.host.write(encodeFrame({ type: 'request', id: 'ready-check', method: 'runtime.inspect', params: {} }))
  await vi.waitFor(() => expect(c.frames.some(frame => frame.id === 'ready-check')).toBe(true))
  const first = c.session.requestAccount(true), second = c.session.requestAccount(true)
  expect(first).toBe(second)
  await vi.waitFor(() => expect(c.frames.filter(frame => frame.type === 'account.request')).toHaveLength(1))
  const request = c.frames.find(frame => frame.type === 'account.request')!
  c.host.write(encodeFrame({ type: 'account.response', id: request.id, credential: { type: 'chatgptAuthTokens', accessToken: 'private-ephemeral-token', chatgptAccountId: 'account' } }))
  expect(await first).toMatchObject({ accessToken: 'private-ephemeral-token' })
  expect(journal.pendingEvents()).toEqual([])
  const pending = c.session.requestAccount(true)
  c.session.close()
  await expect(pending).rejects.toThrow('Account channel closed')
})
