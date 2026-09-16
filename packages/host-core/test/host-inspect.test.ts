import { afterEach, expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import { setup } from './bot-helpers.js'

const contexts: Awaited<ReturnType<typeof setup>>[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const ctx of contexts.splice(0)) {
    await ctx.service.close()
    await rm(ctx.dir, { recursive: true, force: true })
  }
})
it('reuses a successful runtime check for a minute so identity checks stay fast; failures are rechecked', async () => {
  const ctx = await setup()
  contexts.push(ctx)
  const inspect = vi.spyOn(ctx.provider, 'inspectRuntime')
  expect((await ctx.call('host.inspect')).health).toBe('ready')
  expect((await ctx.call('host.inspect')).health).toBe('ready')
  expect(inspect).toHaveBeenCalledTimes(1)
  // Concurrent identity checks share one runtime check.
  await Promise.all([ctx.call('host.inspect'), ctx.call('host.inspect')])
  expect(inspect).toHaveBeenCalledTimes(1)
  // After a minute the runtime is verified again and a failure shows at once.
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now + 61_000)
  inspect.mockResolvedValue({ available: false, reason: 'QEMU does not advertise HVF' })
  expect((await ctx.call('host.inspect')).health).toBe('unavailable')
  expect((await ctx.call('host.inspect')).health).toBe('unavailable')
  expect(inspect).toHaveBeenCalledTimes(3)
  inspect.mockResolvedValue({ available: true })
  expect((await ctx.call('host.inspect')).health).toBe('ready')
})
