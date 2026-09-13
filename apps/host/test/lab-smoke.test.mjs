import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { smoke } from '../../../scripts/host-lab.mjs'
const config = {
  namespace: 'lab-test',
  imageId: 'image',
  runtimeId: 'runtime',
  caps: { cpus: 4, memoryMiB: 2048, diskGiB: 40 },
}
function fake(directory, { capacity = config.caps, isolated = true } = {}) {
  const vms = new Map(),
    operations = new Map(),
    calls = []
  let boots = 0
  return {
    calls,
    vms,
    api: async (method, params) => {
      calls.push({ method, params })
      if (method === 'host.inspect')
        return {
          id: 'host-identity',
          supported: true,
          allocated: { cpus: 0, memoryMiB: 0, diskGiB: 0 },
          capacity,
          runtimes: [{ id: 'runtime', available: true }],
        }
      if (method === 'image.list') return [{ id: 'image', available: true, virtualSizeGiB: 20 }]
      if (method === 'vm.list') return [...vms.values()]
      if (method === 'vm.inspect') return { ...vms.get(params.vmId) }
      if (method === 'operation.get') {
        const files = await readdir(directory)
        assert(
          files.some((file) => file.endsWith('-accepted.json')),
          'acceptance must be persisted before polling'
        )
        return operations.get(params.operationId)
      }
      if (method === 'vm.verify') {
        const vm = vms.get(params.vmId)
        if (params.mode === 'write-marker') vm.marker = vm.identity
        return {
          ready: vm.state === 'running',
          markerMatches: vm.marker === vm.identity,
          networkIsolated: isolated,
          bootId: vm.bootId,
        }
      }
      const files = await readdir(directory)
      const intents = await Promise.all(
        files
          .filter((file) => file.endsWith('-intent.json'))
          .map(async (file) => JSON.parse(await readFile(join(directory, file), 'utf8')))
      )
      assert(
        intents.some((intent) => intent.method === method && intent.params.idempotencyKey === params.idempotencyKey),
        'intent must precede effect'
      )
      let vm
      if (method === 'vm.create') {
        vm = {
          id: `vm-${vms.size}`,
          identity: `identity-${vms.size}`,
          name: params.name,
          state: 'stopped',
          revision: 0,
        }
        vms.set(vm.id, vm)
      } else {
        vm = vms.get(params.vmId)
        assert.equal(vm.revision, params.expectedRevision)
        vm.revision++
        vm.state = method === 'vm.remove' ? 'removed' : method === 'vm.shutdown' ? 'stopped' : 'running'
        if (vm.state === 'running') vm.bootId = `boot-${boots++}`
      }
      const op = { id: `operation-${operations.size}`, vmId: vm.id, status: 'succeeded' }
      operations.set(op.id, op)
      return op
    },
  }
}
test('two guests pass markers across reconnect restart and cold boot; removal preserves data', { skip: process.platform === 'win32' && 'Requires POSIX directory fsync for mutation records' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'host-smoke-'))
  try {
    const remote = fake(directory)
    const result = await smoke(config, directory, remote.api)
    assert.equal(result.status, 'supported')
    assert.equal(remote.vms.size, 2)
    assert.equal(remote.calls.filter((call) => call.method === 'vm.verify').length, 8)
    assert(remote.calls.filter((call) => call.method === 'vm.remove').every((call) => call.params.deleteData === false))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
test('insufficient two-guest capacity blocks before any mutation', async () => {
  const remote = fake('', { capacity: { ...config.caps, diskGiB: 20 } })
  const result = await smoke(config, '', remote.api)
  assert.equal(result.status, 'blocked')
  assert.match(result.concurrency, /two image minima/)
  assert.equal(remote.calls.length, 2)
})
test('failed guest isolation retains lab guests and data for recovery', { skip: process.platform === 'win32' && 'Requires POSIX directory fsync for mutation records' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'host-smoke-'))
  try {
    const remote = fake(directory, { isolated: false })
    await assert.rejects(smoke(config, directory, remote.api), /verification failed/)
    assert(!remote.calls.some((call) => call.method === 'vm.remove'))
    assert.equal(remote.vms.size, 2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
test('data deletion is forwarded only after explicit config authorization', { skip: process.platform === 'win32' && 'Requires POSIX directory fsync for mutation records' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'host-smoke-'))
  try {
    const remote = fake(directory)
    await smoke({ ...config, authorizeDeleteData: true }, directory, remote.api)
    assert(remote.calls.filter((call) => call.method === 'vm.remove').every((call) => call.params.deleteData === true))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
