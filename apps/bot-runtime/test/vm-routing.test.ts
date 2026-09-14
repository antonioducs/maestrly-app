import { expect, it } from 'vitest'
import { routeFrameSchema, vmRequestSchema } from '@maestrly/host-protocol'
import { randomUUID } from 'node:crypto'
it('does not accept worker-supplied management commands, paths or extra routing authority', () => {
  const identity = { sessionId: randomUUID(), generation: 1, connectionId: randomUUID() }
  expect(routeFrameSchema.safeParse({ type: 'route.data', ...identity, sequence: 0, data: 'dGVzdA==', vmId: 'other-vm' }).success).toBe(false)
  expect(vmRequestSchema.safeParse({ type: 'vm.request', id: 'x', method: 'system.exec', params: { command: 'anything' } }).success).toBe(false)
  expect(vmRequestSchema.safeParse({ type: 'vm.request', id: 'x', method: 'session.start', params: { sessionId: identity.sessionId, generation: 1, idempotencyKey: 'k', path: '/etc/passwd' } }).success).toBe(false)
})
