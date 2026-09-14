import { expect, it } from 'vitest'
import { FixtureHost } from '../src/main/fixture'
import { installLocalHost } from '../src/main/host-installation'
import { localArgs } from '../src/main/local-transport'
it('walks the guided setup without any technical choice and finishes only after the account connects', async () => {
  const fixture = new FixtureHost({ autoLoginMs: 30 })
  fixture.connected = true
  try {
    const preview = (await fixture.request('bot.setup.preview', {})) as any
    expect(preview.feasible).toBe(true)
    expect(preview.profile.source).toBe('recommended')
    const op = (await fixture.request('bot.setup.start', { idempotencyKey: 'k', previewId: preview.previewId, inventoryRevision: preview.inventoryRevision, name: 'Ana', purpose: 'x', confirmations: { destination: true, permissions: true } })) as any
    expect(await fixture.request('bot.setup.start', { idempotencyKey: 'k', previewId: preview.previewId, inventoryRevision: preview.inventoryRevision, name: 'Ana', purpose: 'x', confirmations: { destination: true, permissions: true } })).toMatchObject({ id: op.id })
    let current: any
    for (let i = 0; i < 100 && current?.status !== 'waiting_user'; i++) {
      await new Promise((r) => setTimeout(r, 20))
      current = await fixture.request('bot.setup.inspect', { operationId: op.id })
    }
    expect(current.steps.map((s: any) => s.status)).toEqual(['succeeded', 'succeeded', 'succeeded', 'waiting_user', 'pending'])
    expect((await fixture.request('vm.list', { includeRetained: false }) as any[]).length).toBe(2)
    const auth = (await fixture.request('bot.auth.start', { botId: op.botId, method: 'device' })) as any
    expect(auth.pending.verificationUrl).toMatch(/^https:\/\/auth\.openai\.com\//)
    let bot: any
    for (let i = 0; i < 100 && bot?.status !== 'ready'; i++) {
      await new Promise((r) => setTimeout(r, 20))
      bot = await fixture.request('bot.inspect', { botId: op.botId })
    }
    expect(bot.status).toBe('ready')
    expect(bot.model).toMatchObject({ model: 'fixture-small', source: 'recommended' })
    expect(((await fixture.request('bot.setup.inspect', { operationId: op.id })) as any).status).toBe('succeeded')
  } finally {
    fixture.bots.dispose()
  }
})
it('local Host uses the fixed rpc-stdio command and installation fails closed without a verified staged package', async () => {
  expect(localArgs()).toEqual(['rpc-stdio'])
  const input = { namespace: 'lab-x', identity: '11111111-1111-4111-8111-111111111111', caps: { cpus: 2, memoryMiB: 2048, diskGiB: 20 }, operator: null }
  expect(await installLocalHost(input, { platform: 'linux' })).toMatchObject({ status: 'blocked' })
  expect(await installLocalHost(input, { platform: 'darwin', arch: 'arm64', inspect: async () => ({ state: 'missing' }), stagedManifest: async () => null })).toMatchObject({ status: 'blocked', message: expect.stringContaining('pacote verificado') })
  expect(await installLocalHost(input, { platform: 'darwin', arch: 'arm64', inspect: async () => ({ state: 'missing' }), stagedManifest: async () => ({ sha256: 'a'.repeat(64), architecture: 'x64' }) })).toMatchObject({ status: 'blocked' })
  const scripts: string[] = []
  const outcome = await installLocalHost(input, {
    platform: 'darwin',
    arch: 'arm64',
    inspect: async () => ({ state: 'missing' }),
    stagedManifest: async () => ({ sha256: 'a'.repeat(64), architecture: 'arm64' }),
    authorize: async (script) => {
      scripts.push(script)
      return { code: 0, stderr: '' }
    },
  })
  expect(outcome.status).toBe('installed')
  expect(scripts[0]).toBe(`/bin/sh /private/var/tmp/maestrly-host-package/install/install.sh --authorize-install lab-x 11111111-1111-4111-8111-111111111111 2 2048 20 ${'a'.repeat(64)} --no-operator`)
  expect(await installLocalHost({ ...input, namespace: 'prod; rm -rf /' }, { platform: 'darwin', arch: 'arm64', inspect: async () => ({ state: 'missing' }), stagedManifest: async () => ({ sha256: 'a'.repeat(64), architecture: 'arm64' }) })).toMatchObject({ status: 'blocked' })
  expect(await installLocalHost(input, { platform: 'darwin', arch: 'arm64', inspect: async () => ({ state: 'missing' }), stagedManifest: async () => ({ sha256: 'a'.repeat(64), architecture: 'arm64' }), authorize: async () => ({ code: 1, stderr: 'User canceled. (-128)' }) })).toMatchObject({ status: 'cancelled' })
})
