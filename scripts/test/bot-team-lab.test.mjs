import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { HostSession, READ_ONLY_METHODS, SAMPLE_CSV, SAMPLE_TOTAL, doctor, guardTeamLab, main, selectTeam, smoke } from '../bot-team-lab.mjs'
import { validateConfig } from '../host-lab.mjs'

const a = '11111111-1111-1111-1111-111111111111'
const b = '22222222-2222-2222-2222-222222222222'
const c = '33333333-3333-3333-3333-333333333333'
const base = { sshAlias: 'mini', expectedIdentity: '12345678-1234-1234-1234-123456789ABC', namespace: 'lab-mini', caps: { cpus: 4, memoryMiB: 8192, diskGiB: 40 } }
const authorized = { ...base, allowTeamSmoke: true, teamBotIds: [a, b] }
const ready = (id, name) => ({ id, name, status: 'ready', runtimeState: 'ready', accountState: 'connected', vmId: 'vm-1' })

function fakeChild() {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => child.emit('close', null)
  return child
}
/** A Host whose replies the test controls, without any SSH or hardware. */
function fakeSession(config, handlers, flags = []) {
  return {
    config,
    flags,
    calls: [],
    async request(method, params) {
      guardTeamLab(config, method, flags)
      this.calls.push(method)
      const handler = handlers[method]
      if (!handler) throw Object.assign(Error(`unexpected ${method}`), { code: 'HOST_ERROR' })
      return typeof handler === 'function' ? handler(params) : handler
    },
    close() {},
  }
}

test('only read-only methods run without team consent in both the config and the flag', () => {
  for (const method of READ_ONLY_METHODS) guardTeamLab(base, method, [])
  for (const method of ['team.create', 'team.messages.send', 'team.members.set', 'team.archive', 'team.artifacts.share', 'team.run.cancel', 'bot.messages.send', 'vm.shutdown']) {
    assert.throws(() => guardTeamLab(base, method, ['--authorize-team-smoke']), /TEAM_LAB_NOT_AUTHORIZED/)
    assert.throws(() => guardTeamLab({ ...base, allowTeamSmoke: true }, method, []), /TEAM_LAB_NOT_AUTHORIZED/)
    guardTeamLab({ ...base, allowTeamSmoke: true }, method, ['--authorize-team-smoke'])
  }
  // Nothing that mutates a Host, a VM, a bot or a team is read-only by accident.
  assert.ok(!READ_ONLY_METHODS.some((method) => /create|send|set|archive|share|revoke|cancel|remove|start|stop|upsert|decide|transfer/.test(method)))
})

test('the lab configuration accepts the team consent and the explicit bot list only', () => {
  assert.equal(validateConfig(authorized).allowTeamSmoke, true)
  assert.deepEqual(validateConfig(authorized).teamBotIds, [a, b])
  assert.throws(() => validateConfig({ ...base, allowTeamSmoke: 'yes' }), /boolean/)
  assert.throws(() => validateConfig({ ...base, teamBotIds: [a] }), /between two and eight/)
  assert.throws(() => validateConfig({ ...base, teamBotIds: [a, a] }), /must not repeat/)
  assert.throws(() => validateConfig({ ...base, teamBotIds: [a, 'first-free'] }), /exact bot identifiers/)
  assert.throws(() => validateConfig({ ...base, teamBotIds: 'all' }), /between two and eight/)
})

test('the team is exactly the configured bots and never the first free one', () => {
  const bots = [ready(a, 'Ana'), ready(b, 'Bruno'), ready(c, 'Carla')]
  const chosen = selectTeam(authorized, bots)
  assert.equal(chosen.coordinator.id, a)
  assert.deepEqual(chosen.members.map((bot) => bot.id), [a, b])
  // Without an explicit list the lab refuses instead of choosing for the operator.
  assert.throws(() => selectTeam(base, bots), /TEAM_TARGET_REQUIRED/)
  assert.throws(() => selectTeam({ ...authorized, teamBotIds: [a, c] }, [ready(a, 'Ana')]), /TEAM_TARGET_MISSING/)
  assert.throws(() => selectTeam(authorized, [ready(a, 'Ana'), { ...ready(b, 'Bruno'), status: 'setup' }]), /TEAM_TARGET_NOT_READY/)
})

test('usage errors are raised before any configuration is read or Host contacted', async () => {
  await assert.rejects(main(['smoke']), /Usage/)
  await assert.rejects(main(['doctor', '--authorize-team-smoke']), /Usage/)
  await assert.rejects(main(['run']), /Usage/)
})

test('doctor only reads, reports the blocker and never mutates anything', async () => {
  const session = fakeSession(base, {
    'host.inspect': { id: 'host-1', serviceVersion: '0.3.0', capabilities: ['teams.v1', 'bot.runtime.v1'] },
    'bot.list': [ready(a, 'Ana'), ready(b, 'Bruno')],
    'team.list': [],
    'vm.list': [{ id: 'vm-1', state: 'running', health: 'ready' }],
  })
  const report = await doctor(session)
  assert.equal(report.host.teams, true)
  // Without a configured team the doctor says so instead of choosing bots.
  assert.equal(report.blocker, 'TEAM_TARGET_REQUIRED')
  assert.equal(report.ready, false)
  assert.ok(session.calls.every((method) => READ_ONLY_METHODS.includes(method)))
})

test('doctor degrades honestly on a Host that predates teams', async () => {
  const session = fakeSession(authorized, {
    // No teams.v1: the team namespace does not exist on this Host at all.
    'host.inspect': { id: 'host-1', serviceVersion: '0.2.0', capabilities: ['bot.runtime.v1', 'desktop.live.v1'] },
    'bot.list': [ready(a, 'Ana'), ready(b, 'Bruno')],
    'vm.list': [{ id: 'vm-1', state: 'running', health: 'ready' }],
    'bot.inspect': ({ botId }) => ready(botId, 'X'),
  })
  const report = await doctor(session)
  assert.equal(report.host.teams, false)
  assert.equal(report.ready, false)
  // It reports instead of failing, and never asks an older Host for a team method.
  assert.ok(!session.calls.includes('team.list'))
  assert.equal(report.computers.length, 1)
})

test('doctor reports readiness once the configured bots are ready and idle', async () => {
  const session = fakeSession(authorized, {
    'host.inspect': { id: 'host-1', serviceVersion: '0.3.0', capabilities: ['teams.v1'] },
    'bot.list': [ready(a, 'Ana'), ready(b, 'Bruno')],
    'team.list': [],
    'vm.list': [{ id: 'vm-1', state: 'running', health: 'ready' }],
    'bot.inspect': ({ botId }) => ready(botId, botId === a ? 'Ana' : 'Bruno'),
  })
  const report = await doctor(session)
  assert.equal(report.ready, true)
  assert.equal(report.target.coordinator, 'Ana')
  assert.equal(report.target.members.length, 2)
  // A busy bot blocks the smoke instead of interrupting its work.
  const busy = fakeSession(authorized, {
    'host.inspect': { id: 'host-1', serviceVersion: '0.3.0', capabilities: ['teams.v1'] },
    'bot.list': [ready(a, 'Ana'), ready(b, 'Bruno')],
    'team.list': [],
    'vm.list': [{ id: 'vm-1', state: 'running', health: 'ready' }],
    'bot.inspect': ({ botId }) => ({ ...ready(botId, 'X'), ...(botId === b ? { activeTurnId: 'turn-1' } : {}) }),
  })
  assert.equal((await doctor(busy)).ready, false)
})

test('an authorized smoke proves the arithmetic and leaves the computers untouched', async () => {
  const digest = 'a'.repeat(64)
  // A Host that answers each request once, so the smoke can tell the two runs apart.
  const answers = [{ kind: 'request', content: 'pedido' }]
  let runs = 0
  const session = fakeSession(
    authorized,
    {
      'host.inspect': { id: 'host-1', serviceVersion: '0.3.0', capabilities: ['teams.v1'] },
      'bot.list': [ready(a, 'Ana'), ready(b, 'Bruno')],
      'team.list': [],
      'vm.list': [{ id: 'vm-1', state: 'running', health: 'ready' }],
      'bot.inspect': ({ botId }) => ready(botId, 'X'),
      'team.create': { team: { id: 'team-1' }, members: [{}, {}] },
      'team.artifacts.transferBegin': { transferId: 't-1' },
      'team.artifacts.transferChunk': { offset: SAMPLE_CSV.length, done: true },
      'team.artifacts.transferFinish': { artifact: { id: 'art-1', artifactId: 'art-1', digest } },
      'team.messages.send': () => {
        answers.push({ kind: 'answer', content: `O total é ${SAMPLE_TOTAL}.` })
        return { run: { id: `run-${++runs}` } }
      },
      'team.run.get': { id: 'run-1', status: 'succeeded', budget: { turns: 4, tokensObserved: false } },
      // The first request is answered by the coordinator alone; the second is delegated.
      'team.tasks.list': () => (runs > 1 ? { tasks: [{ kind: 'planning', assigneeBotId: a }, { kind: 'work', assigneeBotId: b }] } : { tasks: [{ kind: 'planning', assigneeBotId: a }] }),
      'team.messages.list': () => ({ messages: answers }),
    },
    ['--authorize-team-smoke']
  )
  const report = await smoke(session)
  const step = (name) => report.steps.find((entry) => entry.step === name)
  assert.equal(report.status, 'succeeded')
  assert.equal(step('inventory.unchanged').ok, true)
  assert.equal(step('computers.intact').ok, true)
  // One consolidated answer per request, never one per member.
  assert.equal(step('run.direct').singleAnswer, true)
  assert.equal(step('run.delegated').singleAnswer, true)
  // Answering alone is valid for a small task; the delegated request really left the coordinator.
  assert.equal(step('run.direct').delegatedTasks, 0)
  assert.equal(step('run.delegated').delegatedTasks, 1)
  assert.equal(step('run.delegated').membersWorked, 1)
  assert.equal(step('delegation.exercised').ok, true)
  // Two bots prove delegation, never two workers running at the same time.
  assert.equal(step('delegation.exercised').concurrencyProven, false)
  // The arithmetic is checked against the known sample, not against the model's claim.
  assert.equal(step('run.direct').arithmetic, true)
  // Unknown token usage stays unknown instead of being reported as zero.
  assert.equal(step('run.direct').tokens, 'unknown')
  // The lab never turns a computer off, removes it or archives a bot.
  for (const forbidden of ['vm.shutdown', 'vm.remove', 'vm.restart', 'bot.archive', 'environment.prepare'])
    assert.ok(!session.calls.includes(forbidden), forbidden)
})

test('a smoke on a Host without teams is refused with a stable code', async () => {
  const session = fakeSession(
    authorized,
    {
      'host.inspect': { id: 'host-1', serviceVersion: '0.2.0', capabilities: ['bot.runtime.v1'] },
      'bot.list': [ready(a, 'Ana'), ready(b, 'Bruno')],
      'team.list': [],
      'vm.list': [],
      'bot.inspect': ({ botId }) => ready(botId, 'X'),
    },
    ['--authorize-team-smoke']
  )
  await assert.rejects(smoke(session), (error) => error.code === 'TEAM_UPDATE_REQUIRED')
  assert.ok(!session.calls.includes('team.create'))
})

test('the persistent Host session keeps only stable error codes and refuses mutations without consent', async () => {
  let child
  const session = new HostSession(base, [], (command, args) => {
    assert.equal(command, '/usr/bin/ssh')
    assert.equal(args.at(-1), '/Library/MaestrlyHost/bin/maestrly-host rpc-stdio')
    child = fakeChild()
    return child
  })
  try {
    await assert.rejects(session.request('team.create', {}), /TEAM_LAB_NOT_AUTHORIZED/)
    const pending = session.request('team.list', {})
    const sent = JSON.parse(await new Promise((r) => child.stdin.once('data', (chunk) => r(chunk.toString()))))
    assert.equal(sent.method, 'team.list')
    child.stdout.write(`${JSON.stringify({ version: 1, id: sent.id, error: { code: 'rm -rf /Users/secret', message: '/Users/secret/path' } })}\n`)
    // A diagnostic that carries a local path never reaches the report.
    await assert.rejects(pending, (error) => error.code === 'HOST_ERROR' && !/secret/.test(error.message))
  } finally {
    session.close()
  }
})
