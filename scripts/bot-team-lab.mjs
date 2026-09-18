#!/usr/bin/env node
// Phase 4 laboratory: teams of bots on the selected Mac mini.
//
// Without arguments it only queries (sanitized doctor). `smoke --authorize-team-smoke` also
// requires allowTeamSmoke and an explicit teamBotIds list in the private
// .maestrly-host-lab.json: the lab never picks "the first free bot", never creates a bot, an
// account or a VM, never prepares or restarts a guest and never deletes anything. Keys,
// tokens, private content and the administrator password are never printed.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { record, sshArguments, validateConfig } from './host-lab.mjs'

export const HOST_COMMAND = '/Library/MaestrlyHost/bin/maestrly-host'
export const CONFIG_FILE = '.maestrly-host-lab.json'
/** Methods usable without team consent: none of them changes Host, VM, bot or team state. */
export const READ_ONLY_METHODS = [
  'host.inspect',
  'vm.list',
  'bot.list',
  'bot.inspect',
  'bot.auth.status',
  'bot.session.inspect',
  'bot.turn.get',
  'bot.files.list',
  'team.list',
  'team.inspect',
  'team.messages.list',
  'team.run.get',
  'team.tasks.list',
  'team.events.list',
  'team.memory.list',
  'team.memory.proposals',
  'team.artifacts.list',
  'team.operation.get',
  'team.operation.lookup',
]
/** A synthetic CSV whose expected result is known without trusting the model's claim. */
export const SAMPLE_CSV = 'produto,valor\ncaneta,120\ncaderno,340\nmochila,774\n'
export const SAMPLE_TOTAL = 1234
/**
 * Checks the arithmetic the way a person reads it: a model may write 1.234, 1 234 or 1,234 and be
 * exactly right. Comparing raw substrings would report a correct answer as wrong, which is a worse
 * failure than no check at all — it would make the report lie in the safe-looking direction.
 */
export const statesTotal = (text, total = SAMPLE_TOTAL) =>
  new RegExp(`(^|[^0-9])${String(total).split('').join('[.,\\u00a0\\u202f ]?')}([^0-9]|$)`).test(String(text))
export const TASK = `Some a coluna "valor" do arquivo compartilhado e escreva uma recomendação curta. Responda com o total exato.`
/**
 * A request the coordinator is expected to split, because the person asked for the work to be
 * distributed. The small task above is legitimately answered alone; this one exercises the
 * delegation path end to end instead of hoping the model decides to use it.
 */
export const DELEGATION_TASK =
  'Distribua este trabalho entre a equipe: peça a outro membro que confira a soma da coluna "valor" do arquivo compartilhado e escreva a recomendação. Depois consolide a resposta dele, informando o total exato.'

export function guardTeamLab(config, method, flags) {
  if (READ_ONLY_METHODS.includes(method)) return
  if (config.allowTeamSmoke !== true || !flags.includes('--authorize-team-smoke'))
    throw Error('TEAM_LAB_NOT_AUTHORIZED: set allowTeamSmoke and pass --authorize-team-smoke')
}
/** The team is exactly the bots the operator named; nothing else is eligible. */
export function selectTeam(config, bots) {
  if (!Array.isArray(config.teamBotIds) || config.teamBotIds.length < 2)
    throw Error('TEAM_TARGET_REQUIRED: list at least two explicit teamBotIds in the lab configuration')
  const chosen = config.teamBotIds.map((id) => {
    const bot = bots.find((candidate) => candidate.id === id)
    if (!bot) throw Error('TEAM_TARGET_MISSING: a configured bot does not exist on this Host')
    if (bot.status !== 'ready') throw Error('TEAM_TARGET_NOT_READY: a configured bot is not ready')
    return bot
  })
  return { coordinator: chosen[0], members: chosen }
}
const stableCode = (value) => (typeof value === 'string' && /^[A-Z_]{1,64}$/.test(value) ? value : 'HOST_ERROR')
const remote = (config, command) => {
  const args = sshArguments(config)
  args[args.length - 1] = `${HOST_COMMAND} ${command}`
  return args
}

/** One persistent rpc-stdio session, exactly like the application's transport. */
export class HostSession {
  #child
  #pending = new Map()
  #buffer = ''
  #closed = false
  constructor(config, flags, launch = spawn) {
    this.config = config
    this.flags = flags
    this.#child = launch('/usr/bin/ssh', remote(config, 'rpc-stdio'), { stdio: ['pipe', 'pipe', 'pipe'] })
    // SSH and Host diagnostics may carry local paths; only stable codes are kept.
    this.#child.stderr.resume()
    this.#child.stdout.setEncoding('utf8')
    this.#child.stdout.on('data', (chunk) => this.#data(chunk))
    this.#child.stdin.on('error', () => this.close())
    this.#child.once('close', () => this.#fail())
  }
  #data(chunk) {
    this.#buffer += chunk
    if (this.#buffer.length > 1024 * 1024) return this.close()
    for (let end = this.#buffer.indexOf('\n'); end >= 0; end = this.#buffer.indexOf('\n')) {
      const line = this.#buffer.slice(0, end)
      this.#buffer = this.#buffer.slice(end + 1)
      let reply
      try {
        reply = JSON.parse(line)
      } catch {
        return this.close()
      }
      const pending = this.#pending.get(reply?.id)
      if (!pending || reply.version !== 1) continue
      this.#pending.delete(reply.id)
      clearTimeout(pending.timer)
      if (reply.error) pending.reject(Object.assign(Error(`Host API ${pending.method} failed`), { code: stableCode(reply.error.code) }))
      else if (!Object.hasOwn(reply, 'result')) pending.reject(Object.assign(Error('Invalid Host reply'), { code: 'HOST_ERROR' }))
      else pending.resolve(reply.result)
    }
  }
  /**
   * The consent policy of this laboratory. A laboratory for another phase replaces it with its own
   * complete policy instead of stacking a second one on top: two guards that each know only their
   * own methods would refuse everything the other one owns.
   */
  guard(method) {
    guardTeamLab(this.config, method, this.flags)
  }
  request(method, params, timeoutMs = 60_000) {
    // A refusal is a rejected promise, never a synchronous throw: callers await uniformly.
    try {
      this.guard(method)
    } catch (error) {
      return Promise.reject(error)
    }
    if (this.#closed) return Promise.reject(Object.assign(Error('Host session closed'), { code: 'DISCONNECTED' }))
    const id = randomUUID()
    return new Promise((resolveReply, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(Object.assign(Error(`Host API ${method} timed out; inspect before retrying`), { code: 'TIMEOUT' }))
      }, timeoutMs)
      this.#pending.set(id, { method, resolve: resolveReply, reject, timer })
      this.#child.stdin.write(`${JSON.stringify({ version: 1, id, method, params })}\n`)
    })
  }
  #fail() {
    this.#closed = true
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(Object.assign(Error('Host session closed'), { code: 'DISCONNECTED' }))
    }
    this.#pending.clear()
  }
  close() {
    if (!this.#closed) this.#child.kill()
    this.#fail()
  }
}

export async function loadConfig(directory = process.cwd()) {
  const raw = await readFile(resolve(directory, CONFIG_FILE), 'utf8').catch(() => {
    throw Error(`Explicit ${CONFIG_FILE} required for the team laboratory`)
  })
  return validateConfig(JSON.parse(raw))
}

/**
 * Read-only inventory: which bots exist, whether the Host and the environments know about
 * teams, and whether the configured team can run at all. It changes nothing.
 */
export async function doctor(session) {
  const host = await session.request('host.inspect', {})
  const bots = await session.request('bot.list', { includeArchived: false })
  const supported = host.capabilities.includes('teams.v1')
  // An older Host has no team namespace at all: report that instead of failing.
  const teams = supported ? await session.request('team.list', { includeArchived: false }) : []
  let target
  let blocker
  try {
    target = selectTeam(session.config, bots)
  } catch (error) {
    blocker = error.message.split(':')[0]
  }
  const runtimes = []
  for (const bot of target?.members ?? []) {
    const info = await session.request('bot.inspect', { botId: bot.id })
    runtimes.push({ name: info.name, status: info.status, runtimeState: info.runtimeState, accountState: info.accountState, busy: !!info.activeTurnId })
  }
  return {
    host: { id: host.id, serviceVersion: host.serviceVersion, teams: supported },
    bots: bots.length,
    teams: teams.length,
    // The inventory of computers must be identical before and after a team exists.
    computers: (await session.request('vm.list', { includeRetained: false })).map((vm) => ({ id: vm.id, state: vm.state, health: vm.health })),
    target: target ? { coordinator: target.coordinator.name, members: runtimes } : undefined,
    ...(blocker ? { blocker } : {}),
    ready: supported && !!target && runtimes.every((entry) => entry.status === 'ready' && entry.accountState === 'connected' && !entry.busy),
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, predicate, timeoutMs = 300_000, each) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (predicate(value)) return value
    if (Date.now() > deadline) throw Object.assign(Error('Timed out waiting for the team'), { code: 'TIMEOUT' })
    await each?.()
    await sleep(2_000)
  }
}
/**
 * Answers, as the person, every permission a member asked for, and records exactly what was
 * allowed. A member working under `ask` will request permission, and a laboratory that ignored it
 * would simply time out and report nothing — while a laboratory that approved silently would hide
 * what it consented to on the operator's machine.
 */
async function answerApprovals(session, members, granted) {
  for (const bot of members) {
    const pending = await session.request('bot.interactions.list', { botId: bot.id, pendingOnly: true }).catch(() => [])
    for (const interaction of pending) {
      if (interaction.kind !== 'approval') continue
      await session.request('bot.interactions.resolve', {
        interactionId: interaction.id,
        expectedGeneration: interaction.generation,
        decision: 'approve',
      })
      granted.push({ member: bot.name, title: interaction.title, command: String(interaction.parameters?.command ?? '').slice(0, 200) })
    }
  }
}

/**
 * Authorized end-to-end proof. It creates a team from the configured bots, shares a
 * synthetic CSV, asks for a report, and checks the arithmetic and the file digests instead
 * of trusting what the model wrote. It never turns a VM off and never deletes anything it
 * did not create.
 */
export async function smoke(session, options = {}) {
  const before = await doctor(session)
  if (!before.host.teams) throw Object.assign(Error('This Host does not support teams yet'), { code: 'TEAM_UPDATE_REQUIRED' })
  const { coordinator, members } = selectTeam(session.config, await session.request('bot.list', { includeArchived: false }))
  const steps = []
  const created = await session.request('team.create', {
    idempotencyKey: randomUUID(),
    name: options.name ?? `Lab ${new Date().toISOString().slice(0, 10)}`,
    objective: 'Prova de colaboração do laboratório',
    confirmSharing: true,
    members: members.map((bot, index) => ({ botId: bot.id, role: index === 0 ? 'coordenação' : 'execução', coordinator: bot.id === coordinator.id })),
  })
  const teamId = created.team.id
  steps.push({ step: 'team.created', members: created.members.length })
  // Creating a team must not change the computers at all.
  const after = await session.request('vm.list', { includeRetained: false })
  steps.push({ step: 'inventory.unchanged', ok: JSON.stringify(after.map((vm) => vm.id)) === JSON.stringify(before.computers.map((vm) => vm.id)) })

  const upload = await session.request('team.artifacts.transferBegin', {
    teamId,
    direction: 'upload',
    name: 'dados.csv',
    size: Buffer.byteLength(SAMPLE_CSV),
  })
  await session.request('team.artifacts.transferChunk', { transferId: upload.transferId, offset: 0, dataBase64: Buffer.from(SAMPLE_CSV).toString('base64') })
  const shared = await session.request('team.artifacts.transferFinish', { transferId: upload.transferId })
  steps.push({ step: 'artifact.shared', digest: shared.artifact?.digest?.slice(0, 12) })

  const artifactId = shared.artifact ? (shared.artifact.artifactId ?? shared.artifact.id) : undefined
  /** Sends one request and waits for its durable outcome, then reports what actually happened. */
  const workOn = async (content, label) => {
    const answersBefore = (await session.request('team.messages.list', { teamId, limit: 50 })).messages.filter((message) => message.kind === 'answer').length
    const receipt = await session.request('team.messages.send', {
      teamId,
      clientMessageId: randomUUID(),
      content,
      artifactIds: artifactId ? [artifactId] : [],
    })
    const granted = []
    const run = await until(
      () => session.request('team.run.get', { runId: receipt.run.id }),
      (value) => ['succeeded', 'partial', 'failed', 'cancelled'].includes(value.status),
      options.timeoutMs ?? 900_000,
      () => answerApprovals(session, members, granted)
    )
    const work = await session.request('team.tasks.list', { runId: run.id })
    const page = await session.request('team.messages.list', { teamId, limit: 50 })
    const answers = page.messages.filter((message) => message.kind === 'answer')
    const workers = work.tasks.filter((task) => task.kind === 'work')
    steps.push({
      step: label,
      status: run.status,
      delegatedTasks: workers.length,
      // Members that actually received a turn, which is what proves work left the coordinator.
      membersWorked: [...new Set(workers.map((task) => task.assigneeBotId))].length,
      physicalTurns: run.budget.turns,
      // Arithmetic is checked against the known sample, not against the model's claim.
      arithmetic: answers.slice(answersBefore).some((message) => statesTotal(message.content)),
      // Exactly one consolidated answer per request, never one per member.
      singleAnswer: answers.length === answersBefore + 1,
      // Everything the lab allowed on the operator's machine, in full.
      approvals: granted,
      // Unknown token usage stays unknown; the lab never reports it as zero.
      tokens: run.budget.tokensObserved ? { input: run.budget.inputTokens, output: run.budget.outputTokens } : 'unknown',
    })
    return { run, workers, granted }
  }
  // A small request the coordinator may legitimately answer alone.
  const direct = await workOn(TASK, 'run.direct')
  // A request the person explicitly asked to be split: this exercises real delegation.
  const delegated = await workOn(DELEGATION_TASK, 'run.delegated')
  steps.push({
    step: 'delegation.exercised',
    ok: delegated.workers.length > 0,
    // With two bots this proves delegation, never two workers running at the same time.
    concurrencyProven: false,
  })
  const run = delegated.run.status === 'succeeded' ? delegated.run : direct.run
  const finalInventory = await session.request('vm.list', { includeRetained: false })
  steps.push({ step: 'computers.intact', ok: finalInventory.length === before.computers.length })
  return { teamId, runId: run.id, status: run.status, steps }
}

export async function main(argv, deps = {}) {
  const command = argv[0] ?? 'doctor'
  const flags = argv.slice(1)
  if (!['doctor', 'smoke'].includes(command)) throw Error('Usage: bot-team-lab.mjs <doctor|smoke> [--authorize-team-smoke]')
  if (command === 'doctor' && flags.length) throw Error('Usage: bot-team-lab.mjs doctor')
  if (command === 'smoke' && !flags.includes('--authorize-team-smoke'))
    throw Error('Usage: bot-team-lab.mjs smoke --authorize-team-smoke')
  const config = await (deps.loadConfig ?? loadConfig)()
  const session = new (deps.HostSession ?? HostSession)(config, flags, deps.launch)
  try {
    const result = command === 'doctor' ? await doctor(session) : await smoke(session, deps.options)
    const report = { command, at: new Date().toISOString(), ...result }
    // Evidence is written only when the operator provided a directory for it.
    if (deps.evidenceDirectory) await record(deps.evidenceDirectory, `bot-team-${command}`, report)
    return report
  } finally {
    session.close()
  }
}

// Compare real paths: a repository path with spaces is percent-encoded in import.meta.url.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => {
      console.error(`${error.code ?? 'LAB_ERROR'}: ${error.message}`)
      process.exitCode = 1
    })
}
