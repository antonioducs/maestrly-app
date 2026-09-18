import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { HostSession, READ_ONLY_METHODS, doctor, guardPhase5, routineSmoke, selectTarget, soon, voiceSmoke } from '../bot-routines-lab.mjs'

const bot = '11111111-1111-1111-1111-111111111111'
const other = '22222222-2222-2222-2222-222222222222'
const base = { sshAlias: 'mini', expectedIdentity: '12345678-1234-1234-1234-123456789ABC', namespace: 'lab-mini', caps: { cpus: 4, memoryMiB: 8192, diskGiB: 40 } }
const routineAuthorized = { ...base, allowRoutineSmoke: true, routineBotId: bot }
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
      guardPhase5(config, method, flags)
      this.calls.push(method)
      const handler = handlers[method]
      if (!handler) throw Object.assign(Error(`unexpected ${method}`), { code: 'HOST_ERROR' })
      return typeof handler === 'function' ? handler(params) : handler
    },
    close() {},
  }
}

test('only read-only methods run without the matching consent in both the config and the flag', () => {
  for (const method of READ_ONLY_METHODS) guardPhase5(base, method, [])
  for (const method of ['routine.preview', 'routine.activate', 'routine.pause', 'routine.runNow', 'routine.occurrence.cancel']) {
    assert.throws(() => guardPhase5(base, method, ['--authorize-routine-smoke']), /ROUTINE_LAB_NOT_AUTHORIZED/)
    assert.throws(() => guardPhase5({ ...base, allowRoutineSmoke: true }, method, []), /ROUTINE_LAB_NOT_AUTHORIZED/)
    guardPhase5({ ...base, allowRoutineSmoke: true }, method, ['--authorize-routine-smoke'])
  }
  for (const method of ['voice.upload.begin', 'voice.upload.chunk', 'voice.transcribe', 'voice.send', 'voice.clip.read']) {
    assert.throws(() => guardPhase5({ ...base, allowRoutineSmoke: true }, method, ['--authorize-routine-smoke']), /VOICE_LAB_NOT_AUTHORIZED/)
    guardPhase5({ ...base, allowVoiceSmoke: true }, method, ['--authorize-voice-smoke'])
  }
  // Consent for one gate never unlocks the other: audio is a separate decision from scheduling.
  assert.throws(() => guardPhase5({ ...base, allowVoiceSmoke: true }, 'routine.activate', ['--authorize-voice-smoke']), /ROUTINE_LAB_NOT_AUTHORIZED/)
  // Nothing that changes a Host, a VM, a bot, a routine or audio is read-only by accident.
  assert.ok(!READ_ONLY_METHODS.some((method) => /create|send|activate|pause|archive|runNow|cancel|remove|upload|transcribe|dismiss|start|stop/.test(method)))
  // A method this laboratory has no business using is refused outright.
  assert.throws(() => guardPhase5({ ...base, allowRoutineSmoke: true }, 'vm.shutdown', ['--authorize-routine-smoke']), /PHASE5_METHOD_NOT_ALLOWED/)
  assert.throws(() => guardPhase5({ ...base, allowRoutineSmoke: true }, 'bot.archive', ['--authorize-routine-smoke']), /PHASE5_METHOD_NOT_ALLOWED/)
})

test('the real session applies only this phase\'s policy, so reading routines and voice needs no team consent', async () => {
  // This is the path the doctor actually takes against a Host. The fixture sessions above skip the
  // transport, which is exactly where a second, older guard once refused routine.list on a real Host.
  let child
  const session = new HostSession(base, [], (command, args) => {
    assert.equal(command, '/usr/bin/ssh')
    assert.equal(args.at(-1), '/Library/MaestrlyHost/bin/maestrly-host rpc-stdio')
    child = fakeChild()
    return child
  })
  try {
    for (const method of ['routine.list', 'voice.status', 'team.list']) {
      const pending = session.request(method, {})
      const sent = JSON.parse(await new Promise((r) => child.stdin.once('data', (chunk) => r(chunk.toString()))))
      assert.equal(sent.method, method)
      child.stdout.write(`${JSON.stringify({ version: 1, id: sent.id, result: [] })}\n`)
      assert.deepEqual(await pending, [])
    }
    // Work still needs its own consent, and team work is simply not this laboratory's business.
    await assert.rejects(session.request('routine.activate', {}), /ROUTINE_LAB_NOT_AUTHORIZED/)
    await assert.rejects(session.request('voice.send', {}), /VOICE_LAB_NOT_AUTHORIZED/)
    await assert.rejects(session.request('team.create', {}), /PHASE5_METHOD_NOT_ALLOWED/)
  } finally {
    session.close()
  }
})

test('the lab configuration accepts the phase 5 consents and rejects vague ones', async () => {
  // Without these keys being accepted, the two hardware gates could never be authorized at all.
  const { validateConfig } = await import('../host-lab.mjs')
  const full = { ...base, allowRoutineSmoke: true, routineBotId: bot, allowVoiceSmoke: true, voiceSampleFile: '/tmp/fala.wav', timeZone: 'America/Sao_Paulo' }
  assert.deepEqual(validateConfig(full), full)
  assert.throws(() => validateConfig({ ...base, allowRoutineSmoke: 'yes' }), /boolean/)
  assert.throws(() => validateConfig({ ...base, routineBotId: 'first-free' }), /exact identifier/)
  assert.throws(() => validateConfig({ ...base, voiceSampleFile: 'fala.wav' }), /absolute path/)
  assert.throws(() => validateConfig({ ...base, timeZone: 'Mars/Olympus' }), /IANA/)
})

test('the target is the bot the operator named, never the first one on the list', () => {
  const bots = [ready(other, 'Outro'), ready(bot, 'Alvo')]
  assert.equal(selectTarget(routineAuthorized, bots).bot.name, 'Alvo')
  assert.throws(() => selectTarget(base, bots), /ROUTINE_TARGET_REQUIRED/)
  assert.throws(() => selectTarget({ ...base, routineBotId: 'unknown' }, bots), /ROUTINE_TARGET_MISSING/)
  assert.throws(() => selectTarget({ ...base, routineBotId: bot }, [{ ...ready(bot, 'Alvo'), status: 'setup' }]), /ROUTINE_TARGET_NOT_READY/)
  // A team may be named as well, and a missing one is reported rather than ignored.
  assert.throws(() => selectTarget({ ...base, routineBotId: bot, routineTeamId: 'nope' }, bots, []), /ROUTINE_TEAM_MISSING/)
})

test('the doctor changes nothing and never prints what a routine actually asks for', async () => {
  const session = fakeSession(routineAuthorized, {
    'host.inspect': { id: 'host-1', serviceVersion: '0.3.0', capabilities: ['routines.v1', 'voice.messages.v1', 'teams.v1'] },
    'bot.list': [ready(bot, 'Alvo')],
    'team.list': [],
    'routine.list': [
      {
        spec: { name: 'Resumo', target: { kind: 'bot', id: bot }, request: 'Um pedido bastante privado sobre a empresa' },
        status: 'active',
        nextDueUtc: '2026-09-21T12:00:00.000Z',
      },
    ],
    'voice.status': { state: 'ready', modelId: 'fixture/whisper-base', queueDepth: 0, usedBytes: 0, quotaBytes: 1024, available: true },
    'vm.list': [{ id: 'vm-1', state: 'running', health: 'ready' }],
    'bot.inspect': ready(bot, 'Alvo'),
  })
  const report = await doctor(session)
  assert.equal(report.ready, true)
  assert.equal(report.host.routines, true)
  assert.equal(report.transcription.modelId, 'fixture/whisper-base')
  // Only names and schedules travel: the recurring request itself may be confidential.
  assert.equal(report.routines[0].name, 'Resumo')
  assert.ok(!JSON.stringify(report).includes('privado'))
  // Nothing in the inventory mutates anything.
  assert.ok(session.calls.every((method) => READ_ONLY_METHODS.includes(method)))
})

test('the doctor reports an older Host instead of failing', async () => {
  const session = fakeSession(routineAuthorized, {
    'host.inspect': { id: 'host-1', serviceVersion: '0.2.0', capabilities: [] },
    'bot.list': [ready(bot, 'Alvo')],
    'vm.list': [],
    'bot.inspect': ready(bot, 'Alvo'),
  })
  const report = await doctor(session)
  assert.equal(report.host.routines, false)
  assert.equal(report.host.voice, false)
  assert.equal(report.ready, false)
  assert.deepEqual(report.routines, [])
  assert.equal(report.transcription, undefined)
})

test('a schedule a few minutes out lands on a whole minute in the future', () => {
  const now = Date.parse('2026-09-16T12:34:56.789Z')
  const at = soon(3, now)
  assert.equal(at, '2026-09-16T12:37:00.000Z')
  assert.ok(Date.parse(at) > now)
})

test('the routine gate proves one firing and leaves nothing scheduled behind', async () => {
  const occurrence = {
    id: 'occ-1',
    status: 'succeeded',
    startedAt: '2026-09-16T12:37:01.000Z',
    finishedAt: '2026-09-16T12:37:40.000Z',
    usedActiveMs: 39_000,
    summary: 'Execução programada confirmada.',
    execution: { kind: 'bot', turnId: 't-1', conversationId: 'routine:occ-1' },
  }
  let paused = false
  const session = fakeSession(routineAuthorized, {
    'bot.list': [ready(bot, 'Alvo')],
    'routine.preview': { previewId: 'p-1', fingerprint: 'a'.repeat(64), feasible: true, occurrences: [{ scheduledForUtc: '2026-09-16T12:37:00.000Z', scheduledForLocal: '2026-09-16 09:37' }] },
    'routine.activate': { routine: { id: 'r-1', status: 'active', revision: 0 }, active: null, recent: [] },
    'routine.inspect': () => ({ routine: { id: 'r-1', status: paused ? 'paused' : 'active', revision: 0 }, active: null, recent: [occurrence] }),
    'routine.occurrences.list': { occurrences: [occurrence], hasMore: false },
    'routine.pause': () => {
      paused = true
      return { routine: { id: 'r-1', status: 'paused', revision: 1 }, active: null, recent: [] }
    },
  }, ['--authorize-routine-smoke'])
  const result = await routineSmoke(session, { timeoutMs: 5_000 })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.occurrences, 1)
  assert.equal(result.executions, 1)
  assert.equal(result.scheduledForLocal, '2026-09-16 09:37')
  // The report carries the length of the answer, not the answer itself.
  assert.equal(result.summaryLength, occurrence.summary.length)
  assert.ok(!JSON.stringify(result).includes('confirmada'))
  // And the routine this lab created is no longer active afterwards.
  assert.equal(paused, true)
})

test('the routine gate refuses a schedule the Host itself called impossible', async () => {
  const session = fakeSession(routineAuthorized, {
    'bot.list': [ready(bot, 'Alvo')],
    'routine.preview': { previewId: 'p-1', fingerprint: 'a'.repeat(64), feasible: false, occurrences: [], warnings: [{ code: 'PAST_INSTANT', message: 'já passou' }] },
  }, ['--authorize-routine-smoke'])
  await assert.rejects(routineSmoke(session), /refused this schedule/)
  // Nothing was activated.
  assert.ok(!session.calls.includes('routine.activate'))
})

test('the voice gate needs a consented recording and reports no transcript text', async () => {
  const voiceAuthorized = { ...base, allowVoiceSmoke: true, routineBotId: bot }
  const session = fakeSession(voiceAuthorized, {
    'bot.list': [ready(bot, 'Alvo')],
    'voice.status': { available: true, state: 'ready', modelId: 'fixture/whisper-base' },
  }, ['--authorize-voice-smoke'])
  // Without an explicit file, nothing is recorded and nothing is uploaded.
  await assert.rejects(voiceSmoke(session), /VOICE_SAMPLE_REQUIRED/)
  assert.ok(!session.calls.includes('voice.upload.begin'))
})

test('the voice gate stops when this Host cannot transcribe at all', async () => {
  const voiceAuthorized = { ...base, allowVoiceSmoke: true, routineBotId: bot, voiceSampleFile: 'package.json' }
  const session = fakeSession(voiceAuthorized, {
    'bot.list': [ready(bot, 'Alvo')],
    'voice.status': { available: false, state: 'missing' },
  }, ['--authorize-voice-smoke'])
  await assert.rejects(voiceSmoke(session), /cannot transcribe/)
  assert.ok(!session.calls.includes('voice.upload.begin'))
})
