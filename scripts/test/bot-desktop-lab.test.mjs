import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { HostSession, READ_ONLY_METHODS, doctor, guardDesktopLab, main, readAttachReply } from '../bot-desktop-lab.mjs'
import { validateConfig } from '../host-lab.mjs'

const base = { sshAlias: 'mini', expectedIdentity: '12345678-1234-1234-1234-123456789ABC', namespace: 'lab-mini', caps: { cpus: 4, memoryMiB: 8192, diskGiB: 40 } }
function fakeChild() {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.args = undefined
  child.kill = () => child.emit('close', null)
  return child
}

test('only read-only methods run without desktop lab consent in config and flag', () => {
  for (const method of READ_ONLY_METHODS) guardDesktopLab(base, method, [])
  for (const method of ['bot.desktop.open', 'bot.desktop.acquire', 'bot.desktop.input', 'bot.desktop.return', 'bot.messages.send', 'bot.setup.start', 'vm.stop']) {
    assert.throws(() => guardDesktopLab(base, method, ['--authorize-desktop-lab']), /DESKTOP_LAB_NOT_AUTHORIZED/)
    assert.throws(() => guardDesktopLab({ ...base, authorizeDesktopLab: true }, method, []), /DESKTOP_LAB_NOT_AUTHORIZED/)
    guardDesktopLab({ ...base, authorizeDesktopLab: true }, method, ['--authorize-desktop-lab'])
  }
  assert.ok(!READ_ONLY_METHODS.some((method) => /open|acquire|input|return|send|start|stop|archive|delete|remove/.test(method)))
})

test('the lab configuration accepts the desktop consent only as a boolean', () => {
  assert.equal(validateConfig({ ...base, authorizeDesktopLab: true }).authorizeDesktopLab, true)
  assert.throws(() => validateConfig({ ...base, authorizeDesktopLab: 'yes' }), /boolean/)
})

test('usage errors are raised before any configuration is read or Host contacted', async () => {
  await assert.rejects(main(['run', '--yes']), /Usage/)
  await assert.rejects(main(['doctor', '--authorize-desktop-lab']), /Usage/)
  await assert.rejects(main(['smoke']), /Usage/)
})

test('the persistent Host session keeps only stable error codes and refuses mutations without consent', async () => {
  let child
  const session = new HostSession(base, [], (command, args) => {
    assert.equal(command, '/usr/bin/ssh')
    assert.equal(args.at(-1), '/Library/MaestrlyHost/bin/maestrly-host rpc-stdio')
    assert.ok(args.includes('StrictHostKeyChecking=yes'))
    child = fakeChild()
    return child
  })
  const lines = []
  child.stdin.on('data', (chunk) => lines.push(...chunk.toString().trim().split('\n')))
  const ok = session.request('host.inspect', {})
  const failed = session.request('bot.desktop.inspect', { botId: 'b' })
  await new Promise((r) => setImmediate(r))
  const [first, second] = lines.map((line) => JSON.parse(line))
  child.stdout.write(`${JSON.stringify({ version: 1, id: second.id, error: { code: 'DESKTOP_UPDATE_REQUIRED', message: '/private/path secret' } })}\n`)
  child.stdout.write(`${JSON.stringify({ version: 1, id: first.id, result: { id: 'host' } })}\n`)
  assert.deepEqual(await ok, { id: 'host' })
  await assert.rejects(failed, (error) => error.code === 'DESKTOP_UPDATE_REQUIRED' && !error.message.includes('/private'))
  assert.throws(() => session.request('bot.desktop.open', { botId: 'b', clientInstanceId: 'c' }), /DESKTOP_LAB_NOT_AUTHORIZED/)
  assert.equal(lines.length, 2)
  session.close()
  await assert.rejects(session.request('host.inspect', {}), (error) => error.code === 'DISCONNECTED')
})

test('the desktop-stdio accept line is bounded and keeps the RFB bytes that follow it', async () => {
  const accepted = new PassThrough()
  const reply = readAttachReply(accepted)
  accepted.write(Buffer.concat([Buffer.from('{"accepted":true,"width":1280,"height":800}\n'), Buffer.from('RFB 003.008\n')]))
  const value = await reply
  assert.equal(value.width, 1280)
  assert.equal(value.leftover.toString(), 'RFB 003.008\n')
  const refused = new PassThrough()
  const no = readAttachReply(refused)
  refused.write('{"accepted":false,"code":"TICKET_INVALID"}\n')
  await assert.rejects(no, (error) => error.code === 'TICKET_INVALID')
  const huge = new PassThrough()
  const tooLong = readAttachReply(huge)
  huge.write('x'.repeat(600))
  await assert.rejects(tooLong, (error) => error.code === 'DESKTOP_UNAVAILABLE')
})

test('the doctor reports readiness without tickets, paths or free-form Host text', async () => {
  const calls = []
  const session = {
    request: async (method, params) => {
      calls.push(method)
      if (method === 'host.inspect') return { id: 'h', serviceVersion: '0.3.0', capabilities: ['desktop.live.v1', 'desktop.handoff.v1'] }
      if (method === 'vm.list') return [{ id: '00000000-0000-4000-8000-000000000001', name: 'vm', state: 'running' }, { id: '00000000-0000-4000-8000-000000000002', name: 'other', state: 'stopped' }]
      if (method === 'bot.list') return [{ id: 'a', name: 'A', status: 'ready', vmId: '00000000-0000-4000-8000-000000000001' }, { id: 'z', name: 'Z', status: 'ready', vmId: '00000000-0000-4000-8000-000000000002' }]
      if (method === 'bot.desktop.inspect') return { mode: 'bot', available: true, capabilities: ['desktop.live.v1', 'desktop.handoff.v1'], viewers: 0, controlled: false, mediaTicket: 'f'.repeat(64) }
      throw Error(`unexpected ${method} ${JSON.stringify(params)}`)
    },
  }
  const result = await doctor({ ...base, botVmId: '00000000-0000-4000-8000-000000000001' }, session)
  assert.equal(result.nextStep.startsWith('READY'), true)
  assert.deepEqual(result.bots.map((bot) => bot.id), ['a'])
  assert.doesNotMatch(JSON.stringify(result), /f{64}|mediaTicket/)
  assert.ok(calls.every((method) => READ_ONLY_METHODS.includes(method)))
  const noVm = await doctor(base, session)
  assert.match(noVm.nextStep, /SELECT_VM/)
})

test('against an older Host the doctor never calls bot.desktop methods and asks for the Host update', async () => {
  const calls = []
  const session = {
    request: async (method) => {
      calls.push(method)
      if (method === 'host.inspect') return { id: 'h', serviceVersion: '0.2.0', capabilities: ['bot.runtime.v1', 'bot.sessions.v1'] }
      if (method === 'vm.list') return [{ id: '00000000-0000-4000-8000-000000000001', name: 'vm', state: 'running' }]
      if (method === 'bot.list') return [{ id: 'a', name: 'A', status: 'ready', vmId: '00000000-0000-4000-8000-000000000001' }]
      throw Error(`older Host would drop the session on ${method}`)
    },
  }
  const result = await doctor({ ...base, botVmId: '00000000-0000-4000-8000-000000000001' }, session)
  assert.equal(result.live, false)
  assert.match(result.nextStep, /UPDATE_HOST/)
  assert.deepEqual(result.bots[0].desktop, { error: 'HOST_UPDATE_REQUIRED' })
  assert.ok(!calls.some((method) => method.startsWith('bot.desktop.')))
})
