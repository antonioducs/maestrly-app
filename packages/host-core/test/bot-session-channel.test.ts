import { createServer, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { afterEach, expect, it } from 'vitest'
import { JsonWire, SessionRouter } from '@maestrly/guest-transport'
import { GUEST_PROTOCOL, VM_RUNTIME_PROTOCOL } from '@maestrly/host-protocol'
import { VmSession } from '../src/guest/vm-session.js'
import { SocketGuestSession } from '../src/guest/session.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })
it.skipIf(process.platform === 'win32')('routes runtime RPCs to the bound session and preserves a sibling when one route closes', async () => {
  const dir = await mkdtemp('/tmp/vms-test-'), path = `${dir}/vm.sock`
  const sockets: Socket[] = []
  const ids = [randomUUID(), randomUUID()]
  const server = createServer(socket => {
    sockets.push(socket)
    const wire = new JsonWire(socket)
    new SessionRouter(wire, identity => ids.includes(identity.sessionId), route => {
      const local = new JsonWire(route)
      local.on('frame', frame => {
        if (frame.type === 'request') local.send({ type: 'response', id: frame.id, result: { sessionId: route.identity.sessionId, method: frame.method } })
      })
      local.send({ type: 'hello', protocol: GUEST_PROTOCOL, runtimeVersion: 'test', bootId: randomUUID(), generation: 1, nonce: randomUUID(), capabilities: ['provider.codex'] })
    })
    wire.send({ type: 'vm.hello', protocol: VM_RUNTIME_PROTOCOL, version: 'test', bootId: randomUUID(), generation: 1, nonce: randomUUID() })
  })
  await new Promise<void>(resolve => server.listen(path, resolve))
  cleanups.push(async () => { sockets.forEach(s => s.destroy()); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }) })
  const vm = await VmSession.open(path, randomUUID(), 1)
  const [a, b] = await Promise.all(ids.map(async id => SocketGuestSession.fromStream('vm', await vm.openRoute(id, 1), 1)))
  cleanups.push(async () => { a.close(); b.close(); vm.close() })
  const results = await Promise.all([a.request('runtime.inspect', {}), b.request('runtime.inspect', {})])
  expect(results).toEqual(ids.map(sessionId => ({ sessionId, method: 'runtime.inspect' })))
  a.close()
  expect(await b.request('auth.status', {})).toEqual({ sessionId: ids[1], method: 'auth.status' })
})
