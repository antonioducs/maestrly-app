import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateConfig } from '../../../scripts/host-lab.mjs'
import { COMMANDS, READ_ONLY_METHODS, guardMutation, sanitizePreflight, prepare, smoke } from '../../../scripts/bot-lab.mjs'
const base = {
  sshAlias: 'lab-mac',
  expectedIdentity: '12345678-1234-1234-1234-123456789ABC',
  namespace: 'lab-test',
  caps: { cpus: 4, memoryMiB: 8192, diskGiB: 40 },
}
test('bot lab keys are opt-in, typed and refuse loose VM selection', () => {
  assert.deepEqual(validateConfig(base), base)
  assert.equal(validateConfig({ ...base, botVmId: '11111111-1111-4111-8111-111111111111', allowGuestPreparation: true }).allowGuestPreparation, true)
  for (const bad of [{ botVmId: 'first-available' }, { botVmId: '*' }, { allowGuestPreparation: 'yes' }, { authorizeBotSmoke: 1 }, { botBundlePath: 'relative/bundle.tar' }, { botBundleSha256: 'xyz' }])
    assert.throws(() => validateConfig({ ...base, ...bad }))
})
test('diagnostics never mutate; preparation and smoke need config consent plus the explicit flag', () => {
  assert.deepEqual(COMMANDS, ['doctor', 'prepare', 'smoke', 'sessions'])
  for (const method of READ_ONLY_METHODS) assert.doesNotThrow(() => guardMutation(base, method, []))
  assert.throws(() => guardMutation(base, 'bot.setup.start', []), /GUEST_PREPARATION_NOT_AUTHORIZED/)
  assert.throws(() => guardMutation({ ...base, botVmId: '11111111-1111-4111-8111-111111111111', allowGuestPreparation: true }, 'bot.setup.start', []), /GUEST_PREPARATION_NOT_AUTHORIZED/)
  assert.doesNotThrow(() => guardMutation({ ...base, botVmId: '11111111-1111-4111-8111-111111111111', allowGuestPreparation: true }, 'bot.setup.start', ['--allow-guest-preparation']))
  assert.throws(() => guardMutation(base, 'bot.messages.send', ['--authorize-bot-smoke']), /BOT_SMOKE_NOT_AUTHORIZED/)
  assert.throws(() => guardMutation(base, 'vm.remove', ['--allow-guest-preparation']), /BOT_SMOKE_NOT_AUTHORIZED/)
})
test('preflight report is sanitized and marks only the explicitly selected VM', () => {
  const doctor = { facts: { identity: 'ID', macOS: '26.6.2', physicalArch: 'arm64', freeDiskGiB: 100 } }
  const host = { id: 'h', serviceVersion: '0.2.0', protocolVersion: 1, capabilities: ['bot.runtime.v1', 'bot.setup'], capacity: { cpus: 4, memoryMiB: 8192, diskGiB: 40 }, allocated: { cpus: 4, memoryMiB: 4096, diskGiB: 24 } }
  const vms = [
    { id: 'a', name: 'one', state: 'running', health: 'ready', cpus: 2, memoryMiB: 2048, diskGiB: 12, bootId: 'b1', identity: 'secret-uuid' },
    { id: 'b', name: 'two', state: 'stopped', health: 'unknown', cpus: 2, memoryMiB: 2048, diskGiB: 12 },
  ]
  const report = sanitizePreflight(doctor, host, vms, [{ id: 'img', available: true, reason: '/private/path' }], { feasible: false, destination: { kind: 'new-vm' }, blockers: [{ code: 'CAPACITY_APPROVAL_REQUIRED' }], profile: { resources: { cpus: 2, memoryMiB: 4096, diskGiB: 24 } } }, 'b')
  assert.equal(report.botSupport, true)
  assert.deepEqual(report.reservedByVms, { cpus: 4, memoryMiB: 4096, diskGiB: 24 })
  assert.deepEqual(report.vms.map((vm) => vm.selectedForPreparation), [false, true])
  assert.deepEqual(report.preview.blockers, ['CAPACITY_APPROVAL_REQUIRED'])
  const text = JSON.stringify(report)
  assert.doesNotMatch(text, /secret-uuid|\/private\/path|reason/)
})
test('prepare refuses to run without consent and never chooses a VM on its own', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bot-lab-'))
  try {
    const calls = []
    const api = async (method, params) => {
      calls.push(method)
      if (method === 'bot.setup.preview') assert.deepEqual(params.destination, { kind: 'existing-vm', vmId: '11111111-1111-4111-8111-111111111111' })
      throw new Error('stop before contact')
    }
    await assert.rejects(prepare(base, dir, [], api), /GUEST_PREPARATION_NOT_AUTHORIZED/)
    assert.deepEqual(calls, [])
    await assert.rejects(smoke(base, dir, [], api), /BOT_SMOKE_NOT_AUTHORIZED/)
    assert.deepEqual(calls, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
