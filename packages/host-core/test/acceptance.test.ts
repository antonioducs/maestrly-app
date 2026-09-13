import { it, expect } from 'vitest'
import { requestSchema, vmSchema } from '@maestrly/host-protocol'
it('accepts bounded verify and defaults removal to retention', () => {
  expect(
    requestSchema.safeParse({
      version: 1,
      id: 'r',
      method: 'vm.verify',
      params: { vmId: 'v', mode: 'read-marker' },
    }).success
  ).toBe(true)
  const request = requestSchema.parse({
    version: 1,
    id: 'r',
    method: 'vm.remove',
    params: { vmId: 'v', expectedRevision: 1, idempotencyKey: 'k' },
  })
  expect(request.params).toHaveProperty('deleteData', false)
})
it('rejects nonpositive VM resources', () => {
  expect(
    vmSchema.safeParse({
      id: 'v',
      identity: '11111111-1111-4111-8111-111111111111',
      name: 'v',
      imageId: 'i',
      runtimeId: 'r',
      cpus: 0,
      memoryMiB: 0,
      diskGiB: 0,
      revision: 0,
      state: 'stopped',
      createdAt: 'now',
      updatedAt: 'now',
    }).success
  ).toBe(false)
})
