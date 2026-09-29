import { expect, it, vi } from 'vitest'

// The test setup (test/setup.ts) gives `vi.waitFor` a longer default on CI; these pin what it may change.
it.runIf(process.env.CI)('waits longer than one second by default on CI', async () => {
  const started = Date.now()
  await vi.waitFor(() => expect(Date.now() - started).toBeGreaterThan(1_500))
})

it('keeps an explicit timeout, as an object or a number', async () => {
  const started = Date.now()
  const late = () => expect(Date.now() - started).toBeGreaterThan(5_000)
  await expect(vi.waitFor(late, { timeout: 200 })).rejects.toThrow()
  await expect(vi.waitFor(late, 200)).rejects.toThrow()
  expect(Date.now() - started).toBeLessThan(2_000)
})
