import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { sshArgs, SshTransport } from '../src/main/ssh-transport'
import { validateCall, validSender } from '../src/main/validation'
import { FixtureHost } from '../src/main/fixture'
function setup(timeout = 100) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  })
  const sent: string[] = []
  child.stdin.on('data', (b) => sent.push(String(b)))
  const transport = new SshTransport(() => child as never, timeout)
  transport.connect('lab')
  const reply = (result: unknown) =>
    child.stdout.write(JSON.stringify({ version: 1, id: JSON.parse(sent.at(-1)!).id, result }) + '\n')
  return { child, sent, transport, reply }
}
describe('SSH boundary', () => {
  it('rejects aliases that could introduce options or commands', () => {
    for (const alias of ['-oProxyCommand=evil', 'host;touch /tmp/no', 'user@host', 'host name', '', 'a/b'])
      expect(() => sshArgs(alias)).toThrow()
    expect(sshArgs('lab-mac')).toContain('StrictHostKeyChecking=yes')
    expect(sshArgs('lab-mac')).toContain('ForwardAgent=no')
  })
  it('rejects unrestricted payloads and child frames', () => {
    expect(() => validateCall({ method: 'qmp.execute', params: {} })).toThrow()
    expect(() => validateCall({ method: 'vm.remove', params: { vmId: 'x' } })).toThrow()
    expect(validSender(1, 1, 'file:///app', 'file:///app', false)).toBe(false)
    expect(validSender(1, 1, 'file:///evil', 'file:///app', true)).toBe(false)
  })
  it('preserves retention and purge on the actual wire', async () => {
    for (const deleteData of [false, true]) {
      const { transport, sent, reply } = setup()
      const call = validateCall({
        method: 'vm.remove',
        params: { vmId: 'vm', expectedRevision: 1, idempotencyKey: 'key', deleteData },
      })
      const pending = transport.request(call.method, call.params)
      expect(JSON.parse(sent[0]).params.deleteData).toBe(deleteData)
      reply({ id: 'op', vmId: 'vm', method: 'vm.remove', status: 'queued', createdAt: 'now', updatedAt: 'now' })
      await pending
      transport.disconnect()
    }
    expect(
      validateCall({ method: 'vm.remove', params: { vmId: 'vm', expectedRevision: 1, idempotencyKey: 'key' } }).params
        .deleteData
    ).toBe(false)
    expect(() =>
      validateCall({
        method: 'vm.remove',
        params: { vmId: 'vm', expectedRevision: 1, idempotencyKey: 'key', deleteData: 'true' },
      })
    ).toThrow()
  })
  it('decodes fragmented unicode frames', async () => {
    const { transport, child, sent } = setup()
    const pending = transport.request('events.list', {})
    const frame = Buffer.from(
      JSON.stringify({
        version: 1,
        id: JSON.parse(sent[0]).id,
        result: [{ seq: 1, kind: 'log', createdAt: 'now', value: 'ready 🚀' }],
      }) + '\n'
    )
    const split = frame.indexOf(Buffer.from('🚀')) + 2
    child.stdout.write(frame.subarray(0, split))
    child.stdout.write(frame.subarray(split))
    expect(await pending).toEqual([{ seq: 1, kind: 'log', createdAt: 'now', value: 'ready 🚀' }])
    transport.disconnect()
  })
  it.each([
    'Permission denied (publickey)',
    'REMOTE HOST IDENTIFICATION HAS CHANGED!',
    'Connection timed out',
  ])('reports SSH failure: %s', async (message) => {
    const { transport, child, sent } = setup()
    const pending = transport.request('host.inspect', {})
    const rejected = expect(pending).rejects.toThrow(message)
    child.stderr.write(message)
    child.emit('close', 255)
    await rejected
    expect(sent).toHaveLength(1)
  })
  it('times out without replay and rejects truncated frames', async () => {
    const { transport, child } = setup(5)
    const pending = transport.request('host.inspect', {})
    child.stdout.write('{"version":1')
    await expect(pending).rejects.toThrow(/timed out/)
    expect(transport.status().connected).toBe(false)
  })
  it.each([2, 0])('rejects protocol version %s', async (version) => {
    const { transport, child, sent } = setup()
    const pending = transport.request('host.inspect', {})
    const rejected = expect(pending).rejects.toThrow(/protocol/)
    child.stdout.write(JSON.stringify({ version, id: JSON.parse(sent[0]).id, result: {} }) + '\n')
    await rejected
  })
  it('rejects extra or missing result fields with shared schemas', async () => {
    const fixture = new FixtureHost()
    fixture.connected = true
    const host = (await fixture.request('host.inspect', {})) as Record<string, unknown>
    for (const value of [{ ...host, socketPath: '/tmp/private.sock' }, { ...host, protocolVersion: 2 }, {}]) {
      const { transport, reply } = setup()
      const pending = transport.request('host.inspect', {})
      const rejected = expect(pending).rejects.toThrow(/Invalid host result/)
      reply(value)
      await rejected
    }
  })
  it('rejects malformed outcomes and oversized frames', async () => {
    for (const frame of ['{"version":1,"id":"r","error":null}\n', 'x'.repeat(1024 * 1024 + 1)]) {
      const { transport, child } = setup()
      const pending = transport.request('host.inspect', {})
      const rejected = expect(pending).rejects.toThrow(/protocol|limit/)
      child.stdout.write(frame)
      await rejected
    }
  })
})
