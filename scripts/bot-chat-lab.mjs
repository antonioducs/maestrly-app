#!/usr/bin/env node
// Chat experience laboratory: per-bot MCP servers and skills on the selected Mac mini.
//
// Without arguments it only queries (sanitized doctor). Installing an extension and sending the
// one message that exercises it additionally requires the private .maestrly-host-lab.json to say
// so — allowExtensionsSmoke — plus the matching flag on the command line, and an explicitly named
// routineBotId (the same exact target the phase 5 laboratory uses). The lab never picks "the
// first free bot", never creates a bot, an account or a VM, never prepares or restarts a guest,
// and removes exactly what it installed. Secrets, transcripts and answers are never printed.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HostSession as BaseSession, CONFIG_FILE } from './bot-team-lab.mjs'
import { validateConfig } from './host-lab.mjs'

/** Methods usable without consent: none of them changes Host, VM, bot or extension state. */
export const READ_ONLY_METHODS = [
  'host.inspect',
  'vm.list',
  'bot.list',
  'bot.inspect',
  'bot.turn.get',
  'bot.events.list',
  'bot.transcript.list',
  'bot.sessions.list',
  'extension.inspect',
  'prompt.list',
  'usage.summary',
]
/** Methods that only the extensions consent unlocks: they change what the bot's guest runs, and send one message. */
const EXTENSIONS_METHODS = [
  'extension.mcp.upsert',
  'extension.mcp.remove',
  'extension.skill.install',
  'extension.skill.remove',
  'extension.skill.setEnabled',
  'bot.messages.send',
]

export function guardChat(config, method, flags) {
  if (READ_ONLY_METHODS.includes(method)) return
  if (EXTENSIONS_METHODS.includes(method)) {
    if (config.allowExtensionsSmoke !== true || !flags.includes('--authorize-extensions-smoke'))
      throw Error('EXTENSIONS_LAB_NOT_AUTHORIZED: set allowExtensionsSmoke and pass --authorize-extensions-smoke')
    return
  }
  throw Error('CHAT_METHOD_NOT_ALLOWED: this laboratory does not use that method')
}

/** The target is exactly the bot the operator named; nothing is inferred from a list. */
export function selectTarget(config, bots) {
  if (typeof config.routineBotId !== 'string' || !config.routineBotId)
    throw Error('EXTENSIONS_TARGET_REQUIRED: name an explicit routineBotId in the lab configuration')
  const bot = bots.find((candidate) => candidate.id === config.routineBotId)
  if (!bot) throw Error('EXTENSIONS_TARGET_MISSING: the configured bot does not exist on this Host')
  if (bot.status !== 'ready') throw Error('EXTENSIONS_TARGET_NOT_READY: the configured bot is not ready')
  return bot
}

/** Same transport as the team laboratory, with this laboratory's own complete consent policy. */
export class HostSession extends BaseSession {
  guard(method) {
    guardChat(this.config, method, this.flags)
  }
}

export async function loadChatConfig(directory = process.cwd()) {
  const raw = await readFile(resolve(directory, CONFIG_FILE), 'utf8').catch(() => {
    throw Error(`Explicit ${CONFIG_FILE} required for the chat laboratory`)
  })
  return validateConfig(JSON.parse(raw))
}

/**
 * The one MCP server the smoke installs: a stdio server that answers `initialize`, lists a single
 * `echo` tool and echoes its argument back. It runs with the guest's own Node; it opens no
 * socket, reads no file and needs no network. Kept under the 512-character argument limit.
 */
export const ECHO_SERVER_NAME = 'echo'
export const ECHO_SERVER_SCRIPT =
  "require('readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l),k=m.method;if(m.id==null)return;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:k=='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'echo',version:'1'}}:k=='tools/list'?{tools:[{name:'echo',description:'Eco',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]}:k=='tools/call'?{content:[{type:'text',text:'ECO: '+m.params.arguments.text}]}:{}})+'\\n')})"
export const SKILL_NAME = 'verificacao'
export const SKILL_MD = '---\ndescription: Antes de responder, confirme com a ferramenta echo que o texto "laboratório" volta como ECO.\n---\n# Verificação\n\n1. Chame a ferramenta `echo` do servidor `echo` com o texto exato "laboratório".\n2. Só então responda, em uma frase, dizendo o que a ferramenta devolveu.\n'
export const TASK = 'Siga a skill "verificacao" e me diga o que a ferramenta echo devolveu.'

/**
 * Read-only inventory: does this Host know the chat experience, does the target's guest accept
 * extensions, what is installed, how much was used lately. Names and counts only.
 */
export async function doctor(session) {
  const host = await session.request('host.inspect', {})
  const bots = await session.request('bot.list', { includeArchived: false })
  const chat = host.capabilities.includes('chat.experience.v1')
  let target
  let blocker
  try {
    target = selectTarget(session.config, bots)
  } catch (error) {
    blocker = error.message.split(':')[0]
  }
  const inspected = target ? await session.request('bot.inspect', { botId: target.id }) : undefined
  const extensions = chat && target ? await session.request('extension.inspect', { botId: target.id }) : undefined
  const prompts = chat ? await session.request('prompt.list', {}) : undefined
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const usage = chat ? await session.request('usage.summary', { since }) : undefined
  // What the environment inventory recorded for the VM's guest. On the Mac mini this inventory
  // was not refreshed by the environment update, so it can lag behind the live session: the smoke
  // report (`guestOutdated`, from the Host's own diagnostic) is the evidence, not this field.
  let guestInventory
  if (inspected?.vmId) {
    const inventory = await session.request('bot.sessions.list', { vmId: inspected.vmId }).catch(() => undefined)
    if (inventory) guestInventory = { extensions: inventory.capabilities.includes('bot.extensions.v1'), transcript: inventory.capabilities.includes('bot.transcript.v1') }
  }
  return {
    host: { id: host.id, serviceVersion: host.serviceVersion, chat },
    bots: bots.length,
    computers: (await session.request('vm.list', { includeRetained: false })).map((vm) => ({ id: vm.id, state: vm.state, health: vm.health })),
    target: inspected
      ? {
          name: inspected.name,
          status: inspected.status,
          runtimeState: inspected.runtimeState,
          accountState: inspected.accountState,
          busy: !!inspected.activeTurnId,
          model: inspected.model?.model,
        }
      : undefined,
    guestInventory,
    // Names only: a server's command line and a skill's text may be private.
    extensions: extensions
      ? {
          revision: extensions.revision,
          mcpServers: extensions.mcpServers.map((server) => ({ name: server.name, transport: server.transport, enabled: server.enabled, envKeys: server.envKeys.length })),
          skills: extensions.skills.map((skill) => ({ name: skill.name, enabled: skill.enabled, files: skill.files })),
        }
      : undefined,
    prompts: prompts ? prompts.prompts.length : undefined,
    usage7d: usage ? { turns: usage.turns, input: usage.input, output: usage.output, models: usage.byModel.map((row) => row.model) } : undefined,
    ...(blocker ? { blocker } : {}),
    ready: chat && !!inspected && inspected.status === 'ready' && inspected.accountState === 'connected' && !inspected.activeTurnId,
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(fn, predicate, timeoutMs = 600_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (predicate(value)) return value
    if (Date.now() > deadline) throw Object.assign(Error('Timed out waiting for the Host'), { code: 'TIMEOUT' })
    await sleep(5_000)
  }
}
const TERMINAL = ['succeeded', 'failed', 'cancelled', 'interrupted']

/**
 * The extensions gate: install one MCP server and one skill on the named bot, send one message
 * that can only be answered by using them, and read the transcript the Host folded. Then remove
 * exactly what was installed. The report carries counts and lengths, never the answer.
 */
export async function extensionsSmoke(session, options = {}) {
  const bot = selectTarget(session.config, await session.request('bot.list', { includeArchived: false }))
  const host = await session.request('host.inspect', {})
  if (!host.capabilities.includes('chat.experience.v1')) throw Object.assign(Error('This Host has no chat experience yet'), { code: 'CHAT_HOST_OUTDATED' })
  let state = await session.request('extension.inspect', { botId: bot.id })
  if (state.mcpServers.some((server) => server.name === ECHO_SERVER_NAME) || state.skills.some((skill) => skill.name === SKILL_NAME))
    throw Object.assign(Error('The laboratory extension already exists on this bot; remove it first'), { code: 'EXTENSIONS_LAB_LEFTOVER' })
  const startedAt = Date.now()
  state = await session.request('extension.mcp.upsert', {
    botId: bot.id,
    expectedRevision: state.revision,
    server: { name: ECHO_SERVER_NAME, transport: 'stdio', command: 'node', args: ['-e', ECHO_SERVER_SCRIPT], env: { LAB_MARKER: randomUUID() }, enabled: true },
  })
  const serverId = state.mcpServers.find((server) => server.name === ECHO_SERVER_NAME).id
  state = await session.request('extension.skill.install', {
    botId: bot.id,
    expectedRevision: state.revision,
    name: SKILL_NAME,
    files: [{ path: 'SKILL.md', dataBase64: Buffer.from(SKILL_MD).toString('base64') }],
  })
  const installedRevision = state.revision
  try {
    const eventsBefore = await session.request('bot.events.list', { botId: bot.id, after: 0, limit: 1 })
    const receipt = await session.request('bot.messages.send', { botId: bot.id, clientMessageId: randomUUID(), content: TASK, attachments: [] })
    const turn = await until(
      () => session.request('bot.turn.get', { turnId: receipt.turn.id }),
      (value) => TERMINAL.includes(value.status),
      options.timeoutMs ?? 600_000
    )
    const page = await session.request('bot.transcript.list', { botId: bot.id, limit: 20 })
    const card = page.messages.find((message) => message.turnId === turn.id && message.role === 'assistant')
    const tools = card ? card.parts.filter((part) => part.type === 'tool') : []
    const echoCalls = tools.filter((part) => /echo/i.test(part.toolName) || /echo/i.test(part.summary)).length
    const text = card ? card.parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n') : ''
    // A guest that predates extensions leaves this diagnostic; the turn itself still runs.
    const events = await session.request('bot.events.list', { botId: bot.id, after: eventsBefore.events.at(-1)?.seq ?? 0, limit: 500 })
    const guestOutdated = events.events.some((event) => event.kind === 'diagnostic' && event.detail?.code === 'EXTENSIONS_UPDATE_REQUIRED')
    return {
      turnId: turn.id,
      status: turn.status,
      errorCode: turn.error?.code,
      installedRevision,
      durationMs: Date.now() - startedAt,
      toolCalls: tools.length,
      echoCalls,
      // The property this gate proves: the model used a tool nobody but the person configured.
      usedConfiguredServer: echoCalls > 0,
      echoedBack: /ECO/.test(text),
      answerLength: text.length,
      guestOutdated,
      usage: turn.usage ? { inputTokens: turn.usage.inputTokens, outputTokens: turn.usage.outputTokens } : undefined,
    }
  } finally {
    // Whatever happened, the bot keeps none of what this laboratory installed.
    let current = await session.request('extension.inspect', { botId: bot.id }).catch(() => undefined)
    if (current?.skills.some((skill) => skill.name === SKILL_NAME))
      current = await session.request('extension.skill.remove', { botId: bot.id, expectedRevision: current.revision, name: SKILL_NAME }).catch(() => current)
    if (current?.mcpServers.some((server) => server.id === serverId))
      await session.request('extension.mcp.remove', { botId: bot.id, expectedRevision: current.revision, serverId }).catch(() => {})
  }
}

async function main() {
  const [command = 'doctor', ...flags] = process.argv.slice(2)
  const config = await loadChatConfig()
  const session = new HostSession(config, flags)
  try {
    const report = { command, at: new Date().toISOString(), doctor: await doctor(session) }
    if (flags.includes('--authorize-extensions-smoke')) report.extensions = await extensionsSmoke(session)
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } finally {
    session.close()
  }
}
// Compare real paths: a repository path with spaces is percent-encoded in import.meta.url, and
// `npm run` invokes this script by a relative path.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    process.stderr.write(`${error.code ?? 'LAB_ERROR'}: ${error.message}\n`)
    process.exitCode = 1
  })
