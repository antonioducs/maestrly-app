import test from 'node:test'
import assert from 'node:assert/strict'
import { ECHO_SERVER_NAME, ECHO_SERVER_SCRIPT, HostSession, READ_ONLY_METHODS, SKILL_NAME, doctor, extensionsSmoke, guardChat, selectTarget } from '../bot-chat-lab.mjs'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

const bot = '11111111-1111-1111-1111-111111111111'
const other = '22222222-2222-2222-2222-222222222222'
const base = { sshAlias: 'mini', expectedIdentity: '12345678-1234-1234-1234-123456789ABC', namespace: 'lab-mini', caps: { cpus: 4, memoryMiB: 8192, diskGiB: 40 } }
const authorized = { ...base, allowExtensionsSmoke: true, routineBotId: bot }
const ready = (id, name) => ({ id, name, status: 'ready', runtimeState: 'ready', accountState: 'connected', vmId: 'vm-1', model: { model: 'gpt-5', source: 'recommended' } })
const empty = { botId: bot, revision: 0, mcpServers: [], skills: [] }

function fakeSession(config, handlers, flags = []) {
  return {
    config,
    flags,
    calls: [],
    async request(method, params) {
      guardChat(config, method, flags)
      this.calls.push(method)
      const handler = handlers[method]
      if (!handler) throw Object.assign(Error(`unexpected ${method}`), { code: 'HOST_ERROR' })
      return typeof handler === 'function' ? handler(params) : handler
    },
    close() {},
  }
}
function fakeChild() {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => child.emit('close', null)
  return child
}

test('only read-only methods run without the consent in both the config and the flag', () => {
  for (const method of READ_ONLY_METHODS) guardChat(base, method, [])
  for (const method of ['extension.mcp.upsert', 'extension.skill.install', 'extension.skill.remove', 'bot.messages.send']) {
    assert.throws(() => guardChat(base, method, ['--authorize-extensions-smoke']), /EXTENSIONS_LAB_NOT_AUTHORIZED/)
    assert.throws(() => guardChat({ ...base, allowExtensionsSmoke: true }, method, []), /EXTENSIONS_LAB_NOT_AUTHORIZED/)
    guardChat({ ...base, allowExtensionsSmoke: true }, method, ['--authorize-extensions-smoke'])
  }
  // A consent given for another laboratory unlocks nothing here.
  assert.throws(() => guardChat({ ...base, allowRoutineSmoke: true, allowTeamSmoke: true }, 'extension.mcp.upsert', ['--authorize-routine-smoke']), /EXTENSIONS_LAB_NOT_AUTHORIZED/)
  assert.ok(!READ_ONLY_METHODS.some((method) => /create|send|upsert|install|remove|setEnabled|archive|start|stop|delete/.test(method)))
  assert.throws(() => guardChat({ ...base, allowExtensionsSmoke: true }, 'vm.shutdown', ['--authorize-extensions-smoke']), /CHAT_METHOD_NOT_ALLOWED/)
  assert.throws(() => guardChat({ ...base, allowExtensionsSmoke: true }, 'bot.archive', ['--authorize-extensions-smoke']), /CHAT_METHOD_NOT_ALLOWED/)
  assert.throws(() => guardChat({ ...base, allowExtensionsSmoke: true }, 'routine.activate', ['--authorize-extensions-smoke']), /CHAT_METHOD_NOT_ALLOWED/)
})

test('the real session applies only this laboratory\'s policy on the transport it shares', async () => {
  let child
  const session = new HostSession(base, [], (command, args) => {
    assert.equal(command, '/usr/bin/ssh')
    assert.equal(args.at(-1), '/Library/MaestrlyHost/bin/maestrly-host rpc-stdio')
    child = fakeChild()
    return child
  })
  try {
    const pending = session.request('extension.inspect', { botId: bot })
    const sent = JSON.parse(await new Promise((r) => child.stdin.once('data', (chunk) => r(chunk.toString()))))
    assert.equal(sent.method, 'extension.inspect')
    child.stdout.write(`${JSON.stringify({ version: 1, id: sent.id, result: empty })}\n`)
    assert.deepEqual(await pending, empty)
    await assert.rejects(session.request('extension.mcp.upsert', {}), /EXTENSIONS_LAB_NOT_AUTHORIZED/)
    await assert.rejects(session.request('team.create', {}), /CHAT_METHOD_NOT_ALLOWED/)
  } finally {
    session.close()
  }
})

test('the lab configuration accepts the extensions consent and rejects a vague one', async () => {
  const { validateConfig } = await import('../host-lab.mjs')
  assert.deepEqual(validateConfig(authorized), authorized)
  assert.throws(() => validateConfig({ ...base, allowExtensionsSmoke: 'yes' }), /boolean/)
})

test('the target is the bot the operator named, never the first one on the list', () => {
  const bots = [ready(other, 'Outro'), ready(bot, 'Alvo')]
  assert.equal(selectTarget(authorized, bots).name, 'Alvo')
  assert.throws(() => selectTarget(base, bots), /EXTENSIONS_TARGET_REQUIRED/)
  assert.throws(() => selectTarget({ ...base, routineBotId: 'unknown' }, bots), /EXTENSIONS_TARGET_MISSING/)
  assert.throws(() => selectTarget({ ...base, routineBotId: bot }, [{ ...ready(bot, 'Alvo'), status: 'setup' }]), /EXTENSIONS_TARGET_NOT_READY/)
})

test('the echo server fits one argument, serves one tool and echoes; the skill declares its description', () => {
  assert.ok(ECHO_SERVER_SCRIPT.length <= 512, `script is ${ECHO_SERVER_SCRIPT.length} chars`)
  assert.match(ECHO_SERVER_SCRIPT, /tools\/list/)
  assert.match(ECHO_SERVER_SCRIPT, /tools\/call/)
  assert.doesNotMatch(ECHO_SERVER_SCRIPT, /require\('(net|http|https|fs|child_process)'\)/)
  assert.equal(ECHO_SERVER_NAME, 'echo')
  assert.equal(SKILL_NAME, 'verificacao')
})

test('the doctor changes nothing and reports names and counts only', async () => {
  const session = fakeSession(authorized, {
    'host.inspect': { id: 'host-1', serviceVersion: '0.4.0', capabilities: ['chat.experience.v1'] },
    'bot.list': [ready(bot, 'Alvo')],
    'bot.inspect': ready(bot, 'Alvo'),
    'bot.sessions.list': { vmId: 'vm-1', supported: true, capabilities: ['bot.extensions.v1', 'bot.transcript.v1'], sessions: [], available: 1 },
    'extension.inspect': { ...empty, revision: 3, mcpServers: [{ id: 's', name: 'privado', transport: 'stdio', command: '/usr/local/bin/segredo --token abc', args: [], envKeys: ['TOKEN'], enabled: true }], skills: [{ name: 'revisar', description: 'texto confidencial', digest: 'a'.repeat(64), bytes: 10, files: 2, enabled: true, revision: 0 }] },
    'prompt.list': { prompts: [{ name: 'resumo' }] },
    'usage.summary': { turns: 4, input: 1000, output: 100, byModel: [{ model: 'gpt-5' }] },
    'vm.list': [{ id: 'vm-1', state: 'running', health: 'ready' }],
  })
  const report = await doctor(session)
  assert.equal(report.ready, true)
  assert.equal(report.host.chat, true)
  assert.deepEqual(report.guest, { extensions: true, transcript: true })
  assert.deepEqual(report.extensions.mcpServers, [{ name: 'privado', transport: 'stdio', enabled: true, envKeys: 1 }])
  assert.equal(report.prompts, 1)
  assert.equal(report.usage7d.turns, 4)
  const printed = JSON.stringify(report)
  assert.ok(!printed.includes('segredo') && !printed.includes('confidencial') && !printed.includes('TOKEN'))
  assert.ok(session.calls.every((method) => READ_ONLY_METHODS.includes(method)))
})

test('the doctor reports an older Host instead of failing', async () => {
  const session = fakeSession(authorized, {
    'host.inspect': { id: 'host-1', serviceVersion: '0.3.2', capabilities: ['routines.v1'] },
    'bot.list': [ready(bot, 'Alvo')],
    'bot.inspect': ready(bot, 'Alvo'),
    'bot.sessions.list': { vmId: 'vm-1', supported: true, capabilities: [], sessions: [], available: 1 },
    'vm.list': [],
  })
  const report = await doctor(session)
  assert.equal(report.host.chat, false)
  assert.equal(report.ready, false)
  assert.equal(report.extensions, undefined)
  assert.deepEqual(report.guest, { extensions: false, transcript: false })
})

/** A Host that answers the smoke: extensions are installed, one turn runs, the transcript shows the tool. */
function smokeHost({ echo = true, guestOutdated = false } = {}) {
  let state = { ...empty }
  const turnId = 't-1'
  const events = [{ seq: 1, kind: 'turn.status' }]
  return {
    state: () => state,
    handlers: {
      'bot.list': [ready(bot, 'Alvo')],
      'host.inspect': { id: 'host-1', serviceVersion: '0.4.0', capabilities: ['chat.experience.v1'] },
      'extension.inspect': () => state,
      'extension.mcp.upsert': (p) => {
        assert.equal(p.expectedRevision, state.revision)
        assert.ok(!JSON.stringify(state).includes('LAB_MARKER'))
        state = { ...state, revision: state.revision + 1, mcpServers: [...state.mcpServers, { id: 'srv-1', name: p.server.name, transport: 'stdio', command: p.server.command, args: p.server.args, envKeys: Object.keys(p.server.env), enabled: true }] }
        return state
      },
      'extension.skill.install': (p) => {
        assert.equal(p.expectedRevision, state.revision)
        state = { ...state, revision: state.revision + 1, skills: [...state.skills, { name: p.name, description: 'x', digest: 'a'.repeat(64), bytes: 1, files: 1, enabled: true, revision: 0 }] }
        return state
      },
      'extension.skill.remove': (p) => {
        assert.equal(p.expectedRevision, state.revision)
        state = { ...state, revision: state.revision + 1, skills: state.skills.filter((skill) => skill.name !== p.name) }
        return state
      },
      'extension.mcp.remove': (p) => {
        assert.equal(p.expectedRevision, state.revision)
        state = { ...state, revision: state.revision + 1, mcpServers: state.mcpServers.filter((server) => server.id !== p.serverId) }
        return state
      },
      'bot.events.list': (p) => ({ events: events.filter((event) => event.seq > p.after), hasMore: false }),
      'bot.messages.send': () => {
        if (guestOutdated) events.push({ seq: 2, kind: 'diagnostic', detail: { code: 'EXTENSIONS_UPDATE_REQUIRED' } })
        return { message: { id: 'm-1' }, turn: { id: turnId, status: 'queued' } }
      },
      'bot.turn.get': { id: turnId, status: 'succeeded', usage: { inputTokens: 1200, outputTokens: 40 } },
      'bot.transcript.list': {
        messages: [
          { id: 'u', role: 'user', parts: [{ type: 'text', text: 'pedido' }] },
          {
            id: `turn:${turnId}`,
            role: 'assistant',
            turnId,
            parts: echo
              ? [{ type: 'tool', toolName: 'echo', summary: 'Executando uma ferramenta', state: 'done' }, { type: 'text', text: 'A ferramenta devolveu ECO: laboratório, uma resposta bastante privada.' }]
              : [{ type: 'text', text: 'Não encontrei nenhuma ferramenta echo.' }],
          },
        ],
        turns: [],
        hasMore: false,
        cursor: 3,
      },
    },
  }
}

test('the extensions gate installs, exercises, reads the transcript and removes exactly what it installed', async () => {
  const host = smokeHost()
  const session = fakeSession(authorized, host.handlers, ['--authorize-extensions-smoke'])
  const result = await extensionsSmoke(session, { timeoutMs: 5_000 })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.usedConfiguredServer, true)
  assert.equal(result.echoCalls, 1)
  assert.equal(result.echoedBack, true)
  assert.equal(result.guestOutdated, false)
  // The answer travels as a length, never as text.
  assert.ok(!JSON.stringify(result).includes('privada'))
  assert.equal(result.answerLength, 'A ferramenta devolveu ECO: laboratório, uma resposta bastante privada.'.length)
  // Nothing of the laboratory remains on the bot.
  assert.deepEqual(host.state().mcpServers, [])
  assert.deepEqual(host.state().skills, [])
  assert.ok(session.calls.includes('extension.skill.remove') && session.calls.includes('extension.mcp.remove'))
})

test('the extensions gate says plainly when the guest is too old to receive extensions', async () => {
  const host = smokeHost({ echo: false, guestOutdated: true })
  const session = fakeSession(authorized, host.handlers, ['--authorize-extensions-smoke'])
  const result = await extensionsSmoke(session, { timeoutMs: 5_000 })
  assert.equal(result.usedConfiguredServer, false)
  assert.equal(result.guestOutdated, true)
  assert.deepEqual(host.state().mcpServers, [])
})

test('the extensions gate refuses to run on a leftover and on a Host without the chat experience', async () => {
  const leftover = smokeHost()
  leftover.handlers['extension.inspect'] = () => ({ ...empty, mcpServers: [{ id: 'old', name: ECHO_SERVER_NAME, transport: 'stdio', command: 'node', args: [], envKeys: [], enabled: true }] })
  await assert.rejects(extensionsSmoke(fakeSession(authorized, leftover.handlers, ['--authorize-extensions-smoke'])), /already exists/)
  const old = smokeHost()
  old.handlers['host.inspect'] = { id: 'host-1', serviceVersion: '0.3.2', capabilities: [] }
  const session = fakeSession(authorized, old.handlers, ['--authorize-extensions-smoke'])
  await assert.rejects(extensionsSmoke(session), /no chat experience/)
  assert.ok(!session.calls.includes('extension.mcp.upsert'))
})
