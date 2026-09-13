import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { HostConnections } from '../src/main/host-connections'
import { FixtureHost } from '../src/main/fixture'
import type { Host, Operation } from '@maestrly/host-protocol'
const call = {
  method: 'vm.start' as const,
  params: { vmId: 'fixture-vm', expectedRevision: 1, idempotencyKey: 'durable-key' },
}
it('recovers accepted operations across reopening without duplicating a mutation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bot-recovery-'))
  try {
    const file = join(dir, 'journal.json')
    const fixture = new FixtureHost()
    fixture.connected = true
    const host = (await fixture.request('host.inspect', {})) as Host
    const sent: string[] = []
    const request = async (method: string, params: Record<string, unknown>) => {
      sent.push(method)
      if (method === 'vm.start')
        expect(JSON.parse(await readFile(file, 'utf8'))[0].call.params.idempotencyKey).toBe('durable-key')
      return fixture.request(method, params)
    }
    const first = new HostConnections(file, request)
    await first.connect('lab', host)
    const accepted = (await first.call(call)) as Operation
    first.disconnect()
    const reopened = new HostConnections(file, request)
    await reopened.connect('lab', host)
    expect(sent).toEqual(['vm.start', 'operation.get'])
    expect(reopened.status().lastOperation?.id).toBe(accepted.id)
    expect(reopened.status().lastOperation?.status).toBe('failed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
it('keeps a lost-response request durable and blocks fresh sends after reopening', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bot-uncertain-'))
  try {
    const file = join(dir, 'journal.json')
    const fixture = new FixtureHost()
    fixture.connected = true
    const host = (await fixture.request('host.inspect', {})) as Host
    let sends = 0
    const request = async () => {
      sends++
      throw new Error('SSH disconnected')
    }
    const first = new HostConnections(file, request)
    await first.connect('lab', host)
    await expect(first.call(call)).rejects.toThrow(/outcome unknown/)
    const reopened = new HostConnections(file, request)
    await reopened.connect('lab', host)
    expect(reopened.status().recoveryIssue).toContain('durable-key')
    await expect(reopened.call(call)).rejects.toThrow(/outcome unknown/)
    expect(sends).toBe(2)
    await reopened.connect('lab', { ...host, id: 'a38b1124-bac9-40c1-a4bb-f2feea33c167' })
    expect(reopened.status().recoveryIssue).toContain('identity changed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
it('cannot bypass an accepted operation using a second alias for the same host', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bot-alias-'))
  try {
    const fixture = new FixtureHost()
    fixture.connected = true
    const host = (await fixture.request('host.inspect', {})) as Host
    const op: Operation = {
      id: 'pending',
      vmId: 'fixture-vm',
      method: 'vm.start',
      status: 'running',
      createdAt: 'now',
      updatedAt: 'now',
    }
    const calls: string[] = []
    const request = async (method: string) => {
      calls.push(method)
      return op
    }
    const connections = new HostConnections(join(dir, 'journal.json'), request)
    await connections.connect('first-alias', host)
    await connections.call(call)
    await connections.connect('second-alias', host)
    await expect(connections.call({ ...call, params: { ...call.params, idempotencyKey: 'new-key' } })).rejects.toThrow(
      /accepted operation/
    )
    expect(calls).toEqual(['vm.start', 'operation.get'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
it('preserves retained disk references across reopening and clears them after explicit purge', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bot-retained-'))
  try {
    const fixture = new FixtureHost()
    fixture.connected = true
    const host = (await fixture.request('host.inspect', {})) as Host
    const request = async (method: string) => ({
      id: 'removal',
      vmId: 'fixture-vm',
      method,
      status: 'succeeded',
      createdAt: 'now',
      updatedAt: 'now',
    })
    const file = join(dir, 'journal.json')
    const first = new HostConnections(file, request)
    await first.connect('lab', host)
    await first.call({ method: 'vm.remove', params: { ...call.params, deleteData: false } })
    const reopened = new HostConnections(file, request)
    await reopened.connect('lab', host)
    expect(reopened.status().retainedVmIds).toEqual(['fixture-vm'])
    await reopened.call({ method: 'vm.remove', params: { ...call.params, idempotencyKey: 'purge', deleteData: true } })
    expect(reopened.status().retainedVmIds).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

for (const accepted of [true, false]) {
  it(`recovers a lost reply (${accepted ? 'accepted' : 'unaccepted'}) by key without automatic replay`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bot-lookup-'))
    try {
      const fixture = new FixtureHost()
      fixture.connected = true
      const host = (await fixture.request('host.inspect', {})) as Host
      let lost = true
      const mutations: unknown[] = []
      const request = async (method: string, params: Record<string, unknown>) => {
        if (method === 'vm.start') {
          mutations.push(structuredClone(params))
          if (lost) {
            lost = false
            if (accepted) await fixture.request(method, params)
            throw new Error('Lost reply')
          }
        }
        return fixture.request(method, params)
      }
      const file = join(dir, 'journal.json')
      const first = new HostConnections(file, request)
      await first.connect('lab', host)
      await expect(first.call(call)).rejects.toThrow('outcome unknown')
      const reopened = new HostConnections(file, request)
      await reopened.connect('another-alias', host)
      expect(mutations).toHaveLength(1)
      if (accepted) {
        expect(reopened.status().lastOperation?.id).toBe('op-0')
        expect(reopened.status().recoveryIssue).toBeUndefined()
        expect(reopened.status().retryableKeys).toEqual([])
      } else {
        expect(reopened.status().retryableKeys).toEqual(['durable-key'])
        await expect(reopened.call({ ...call, params: { ...call.params, idempotencyKey: 'fresh' } })).rejects.toThrow(
          'outcome unknown'
        )
        const op = await reopened.retry('durable-key')
        expect(op.id).toBe('op-0')
        expect(mutations).toEqual([call.params, call.params])
        expect(reopened.status().recoveryIssue).toBeUndefined()
      }
      expect(fixture.operations.size).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}
it('blocks retry after host identity changes and resolves definitive revision rejection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bot-retry-'))
  try {
    const fixture = new FixtureHost()
    fixture.connected = true
    const host = (await fixture.request('host.inspect', {})) as Host
    let lose = true
    let identity = host
    let sends = 0
    const connections = new HostConnections(join(dir, 'journal.json'), async (method, params) => {
      if (method === 'host.inspect') return identity
      if (method === 'vm.start') {
        sends++
        if (lose) {
          lose = false
          throw new Error('Lost request')
        }
      }
      return fixture.request(method, params)
    })
    await connections.connect('lab', host)
    await expect(connections.call(call)).rejects.toThrow('outcome unknown')
    await connections.connect('second-alias', host)
    identity = { ...host, id: 'a38b1124-bac9-40c1-a4bb-f2feea33c167' }
    await expect(connections.retry('durable-key')).rejects.toThrow('identity changed')
    expect(sends).toBe(1)
    await connections.connect('second-alias', identity)
    expect(connections.status().recoveryIssue).toContain('identity changed')
    expect(connections.status().retryableKeys).toEqual([])
    identity = host
    await connections.connect('lab', host)
    fixture.vms[0].revision++
    await expect(connections.retry('durable-key')).rejects.toThrow('REVISION_CONFLICT')
    expect(connections.status().recoveryIssue).toBeUndefined()
    expect(fixture.operations.size).toBe(0)
    expect(JSON.parse(await readFile(join(dir, 'journal.json'), 'utf8'))).toEqual([])
    await expect(
      connections.call({ ...call, params: { ...call.params, expectedRevision: 2, idempotencyKey: 'resolved' } })
    ).resolves.toMatchObject({ status: 'queued' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
it('enumerates retained disks for a new client without journal history and purges explicitly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bot-new-client-'))
  try {
    const fixture = new FixtureHost()
    fixture.connected = true
    const host = (await fixture.request('host.inspect', {})) as Host
    const request = fixture.request.bind(fixture)
    const first = new HostConnections(join(dir, 'first.json'), request)
    await first.connect('lab', host)
    const removal = (await first.call({
      method: 'vm.remove',
      params: { ...call.params, deleteData: false },
    })) as Operation
    await first.call({ method: 'operation.get', params: { operationId: removal.id } })
    const second = new HostConnections(join(dir, 'second.json'), request)
    await second.connect('lab', host)
    expect(second.status().retainedVmIds).toEqual([])
    expect(await second.call({ method: 'vm.list', params: {} })).toEqual([])
    expect(await second.call({ method: 'vm.list', params: { includeRetained: true } })).toMatchObject([
      { id: 'fixture-vm', diskRetained: true },
    ])
    const purge = (await second.call({
      method: 'vm.remove',
      params: { ...call.params, expectedRevision: 2, idempotencyKey: 'purge', deleteData: true },
    })) as Operation
    await second.call({ method: 'operation.get', params: { operationId: purge.id } })
    expect(await second.call({ method: 'vm.list', params: { includeRetained: true } })).toEqual([])
    expect(fixture.vms[0].diskRetained).toBe(false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
it('does not send a retry when disconnected during its state refresh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bot-refresh-disconnect-'))
  try {
    const fixture = new FixtureHost()
    fixture.connected = true
    const host = (await fixture.request('host.inspect', {})) as Host
    let disconnectOnInspect = false
    let sends = 0
    const connections = new HostConnections(join(dir, 'journal.json'), async (method, params) => {
      if (method === 'vm.start') {
        sends++
        throw new Error('Lost request')
      }
      if (method === 'vm.inspect' && disconnectOnInspect) connections.disconnect()
      return fixture.request(method, params)
    })
    await connections.connect('lab', host)
    await expect(connections.call(call)).rejects.toThrow('outcome unknown')
    await connections.connect('lab', host)
    disconnectOnInspect = true
    await expect(connections.retry('durable-key')).rejects.toThrow('Connection changed')
    expect(sends).toBe(1)
    expect(connections.status().retryableKeys).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
