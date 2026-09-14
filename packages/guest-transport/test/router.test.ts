import { Duplex } from 'node:stream'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { JsonWire, SessionRouter, type RoutedStream } from '../src/index.js'

const wires: JsonWire[] = []
afterEach(() => { for (const wire of wires.splice(0)) wire.close() })
function pair() {
  const a = new Duplex({ read() {}, write(b, _e, cb) { queueMicrotask(() => { if (!z.destroyed) z.push(Buffer.from(b)); cb() }) } })
  const z = new Duplex({ read() {}, write(b, _e, cb) { queueMicrotask(() => { if (!a.destroyed) a.push(Buffer.from(b)); cb() }) } })
  const host = new JsonWire(a), guest = new JsonWire(z)
  wires.push(host, guest)
  return { host, guest }
}
it('separates concurrent routes, chunks large payloads and supports half-close', async () => {
  const { host, guest } = pair()
  const ids = [randomUUID(), randomUUID()]
  new SessionRouter(guest, i => ids.includes(i.sessionId) && i.generation === 1, stream => {
    stream.on('data', bytes => stream.write(bytes))
    stream.on('end', () => stream.end())
  })
  const router = new SessionRouter(host)
  const streams = await Promise.all(ids.map(id => router.open(id, 1)))
  await Promise.all(streams.map(async (stream, index) => {
    const expected = Buffer.alloc(700 * 1024, index + 65), received: Buffer[] = []
    stream.on('data', data => received.push(data))
    const end = once(stream, 'end')
    stream.end(expected)
    await end
    expect(Buffer.concat(received)).toEqual(expected)
  }))
})
it('a stalled consumer does not block another session or allow unbounded receive buffering', async () => {
  const { host, guest } = pair()
  const accepted: RoutedStream[] = []
  new SessionRouter(guest, () => true, stream => { accepted.push(stream) })
  const router = new SessionRouter(host)
  const a = await router.open(randomUUID(), 1), b = await router.open(randomUUID(), 1)
  let finished = false
  a.write(Buffer.alloc(700 * 1024), () => { finished = true })
  accepted[1].on('data', bytes => accepted[1].write(bytes))
  const reply = once(b, 'data')
  b.write('B remains usable')
  expect(String((await reply)[0])).toBe('B remains usable')
  expect(finished).toBe(false)
  expect(accepted[0].readableLength).toBeLessThanOrEqual(48 * 1024)
  a.destroy()
  const second = once(b, 'data'); b.write('B again')
  expect(String((await second)[0])).toBe('B again')
})
it('refuses foreign identities and closes a route on forged generation without affecting its sibling', async () => {
  const { host, guest } = pair()
  const allowed = randomUUID()
  new SessionRouter(guest, i => i.sessionId === allowed && i.generation === 2, stream => stream.on('data', bytes => stream.write(bytes)))
  const router = new SessionRouter(host)
  await expect(router.open(randomUUID(), 2)).rejects.toThrow('closed')
  const stream = await router.open(allowed, 2)
  const closed = once(stream, 'close')
  guest.send({ type: 'route.data', ...stream.identity, generation: 1, sequence: 0, data: Buffer.from('forged').toString('base64') })
  await closed.catch(() => {})
  expect(stream.destroyed).toBe(true)
  expect(host.stream.destroyed).toBe(false)
})
