#!/usr/bin/env node
// Phase 2 laboratory: sanitized preflight, explicitly consented guest preparation and a
// real chat smoke on the selected Mac mini. Nothing contacts a Host without the private
// .maestrly-host-lab.json; nothing prepares a guest without botVmId + allowGuestPreparation.
import { readFile, mkdir, lstat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { validateConfig, remoteDoctor, rpc, record } from './host-lab.mjs'
import { sharedSessionLab } from './bot-session-lab.mjs'

export const COMMANDS = ['doctor', 'prepare', 'smoke', 'sessions']
/** Preflight keeps identity, versions, inventory markers and quotas; never paths, sockets or diagnostics text. */
export function sanitizePreflight(doctor, host, vms, images, preview, selectedVmId) {
  const reserved = vms.filter((vm) => vm.state !== 'removed').reduce(
    (sum, vm) => ({ cpus: sum.cpus + vm.cpus, memoryMiB: sum.memoryMiB + vm.memoryMiB, diskGiB: sum.diskGiB + vm.diskGiB }),
    { cpus: 0, memoryMiB: 0, diskGiB: 0 }
  )
  return {
    version: 1,
    identity: doctor.facts?.identity ?? null,
    macOS: doctor.facts?.macOS ?? null,
    physicalArch: doctor.facts?.physicalArch ?? null,
    freeDiskGiB: doctor.facts?.freeDiskGiB ?? null,
    hostId: host.id,
    serviceVersion: host.serviceVersion,
    protocolVersion: host.protocolVersion,
    botSupport: host.capabilities.includes('bot.runtime.v1'),
    botSetup: host.capabilities.includes('bot.setup'),
    capacity: host.capacity,
    allocated: host.allocated,
    reservedByVms: reserved,
    images: images.map((image) => ({ id: image.id, available: image.available })),
    vms: vms.map((vm) => ({ id: vm.id, name: vm.name, state: vm.state, health: vm.health, cpus: vm.cpus, memoryMiB: vm.memoryMiB, diskGiB: vm.diskGiB, bootId: vm.bootId ?? null, selectedForPreparation: vm.id === selectedVmId })),
    preview: preview ? { feasible: preview.feasible, destination: preview.destination.kind, blockers: preview.blockers.map((b) => b.code), resources: preview.profile.resources } : null,
  }
}
/** The doctor is read-only by construction: only these methods may be used without preparation consent. */
export const READ_ONLY_METHODS = ['host.inspect', 'vm.list', 'image.list', 'bot.setup.preview', 'bot.list', 'bot.inspect', 'bot.setup.inspect', 'bot.turn.get', 'bot.messages.list', 'bot.events.list', 'bot.files.list', 'bot.auth.status', 'bot.session.inspect', 'bot.sessions.list']
export function guardMutation(config, method, flags) {
  if (READ_ONLY_METHODS.includes(method)) return
  if (method === 'bot.setup.start' || method === 'bot.runtime.prepare') {
    if (!config.botVmId || config.allowGuestPreparation !== true || !flags.includes('--allow-guest-preparation'))
      throw Error('GUEST_PREPARATION_NOT_AUTHORIZED: set botVmId and allowGuestPreparation, and pass --allow-guest-preparation')
    return
  }
  if (config.authorizeBotSmoke !== true || !flags.includes('--authorize-bot-smoke'))
    throw Error('BOT_SMOKE_NOT_AUTHORIZED: set authorizeBotSmoke and pass --authorize-bot-smoke')
}
export async function preflight(config, api) {
  const doctor = await remoteDoctor(config)
  const host = await api('host.inspect', {})
  const vms = await api('vm.list', { includeRetained: true })
  const images = await api('image.list', {})
  let preview = null
  if (host.capabilities.includes('bot.setup'))
    preview = await api('bot.setup.preview', config.botVmId ? { destination: { kind: 'existing-vm', vmId: config.botVmId } } : {}).catch(() => null)
  if (config.botVmId && !vms.some((vm) => vm.id === config.botVmId && vm.state !== 'removed'))
    throw Error('SELECTED_VM_MISSING: botVmId does not match an existing VM on this Host')
  return sanitizePreflight(doctor, host, vms, images, preview, config.botVmId)
}
async function waitOperation(api, method, params, runDirectory, timeoutMs = 20 * 60_000) {
  const accepted = await api(method, params)
  await record(runDirectory, `accepted-${method.replaceAll('.', '-')}`, accepted)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const current = await api('bot.setup.inspect', { operationId: accepted.id })
    if (['succeeded', 'waiting_user', 'failed', 'cancelled'].includes(current.status)) return current
    if (Date.now() > deadline) throw Error('OPERATION_TIMEOUT: inspect the operation before retrying')
    await new Promise((r) => setTimeout(r, 2000))
  }
}
export async function prepare(config, runDirectory, flags, api = (m, p) => rpc(config, m, p)) {
  guardMutation(config, 'bot.setup.start', flags)
  const before = await preflight(config, api)
  await record(runDirectory, 'preflight', before)
  const preview = await api('bot.setup.preview', { destination: { kind: 'existing-vm', vmId: config.botVmId } })
  if (!preview.feasible) return { status: 'blocked', blockers: preview.blockers }
  const idempotencyKey = randomUUID()
  await record(runDirectory, 'intent', { method: 'bot.setup.start', idempotencyKey, vmId: config.botVmId, previewId: preview.previewId })
  const operation = await waitOperation(api, 'bot.setup.start', {
    idempotencyKey,
    previewId: preview.previewId,
    inventoryRevision: preview.inventoryRevision,
    name: `${config.namespace}-bot`,
    purpose: 'Laboratório da fase 2',
    confirmations: { destination: true, permissions: true, prepareExisting: true, restartExisting: true },
  }, runDirectory)
  await record(runDirectory, 'operation', operation)
  return { status: operation.status === 'waiting_user' ? 'needs_account' : operation.status, operationId: operation.id, botId: operation.botId, steps: operation.steps.map((s) => [s.id, s.status]) }
}
export async function smoke(config, runDirectory, flags, api = (m, p) => rpc(config, m, p)) {
  guardMutation(config, 'bot.messages.send', flags)
  const bots = await api('bot.list', {})
  const bot = bots.find((b) => b.name === `${config.namespace}-bot` && b.status === 'ready')
  if (!bot) return { status: 'blocked', reason: 'No ready bot for this namespace; run prepare and connect the account in the app first' }
  const clientMessageId = randomUUID()
  await record(runDirectory, 'intent', { method: 'bot.messages.send', botId: bot.id, clientMessageId })
  const receipt = await api('bot.messages.send', { botId: bot.id, clientMessageId, content: 'Crie um arquivo chamado lab-smoke.md contendo exatamente a linha "maestrly bot lab ok" e responda quando terminar.' })
  await record(runDirectory, 'receipt', receipt)
  const deadline = Date.now() + 10 * 60_000
  for (;;) {
    const turn = await api('bot.turn.get', { turnId: receipt.turn.id })
    if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(turn.status)) {
      await record(runDirectory, 'turn', turn)
      const files = await api('bot.files.list', { botId: bot.id, path: '' })
      const produced = files.find((f) => f.path === 'lab-smoke.md')
      return { status: turn.status === 'succeeded' && produced ? 'supported' : 'blocked', turn: turn.status, fileProduced: !!produced, digest: produced?.digest ?? null }
    }
    if (Date.now() > deadline) throw Error('SMOKE_TIMEOUT: turn still active; cancel it in the app before retrying')
    await new Promise((r) => setTimeout(r, 3000))
  }
}
export async function main(args = process.argv.slice(2)) {
  const [command, ...flags] = args
  if (command === 'sessions' && flags.length === 1 && flags[0] === '--local-vm') {
    const { verifyBotSessions } = await import('./verify-bot-sessions.mjs')
    return verifyBotSessions({ bundlePath: process.env.MAESTRLY_BOT_SESSION_BUNDLE })
  }
  if (!COMMANDS.includes(command) || flags.some((f) => !['--allow-guest-preparation', '--authorize-bot-smoke'].includes(f)))
    throw Error('Usage: bot-lab.mjs doctor|prepare|smoke|sessions [--allow-guest-preparation|--authorize-bot-smoke]; sessions --local-vm validates a disposable Linux VM')
  const configPath = resolve('.maestrly-host-lab.json')
  const info = await lstat(configPath)
  if (!info.isFile() || info.uid !== process.getuid?.() || info.size > 16384 || (info.mode & 0o077) !== 0)
    throw Error('Lab config must be a private regular file (chmod 600)')
  const config = validateConfig(JSON.parse(await readFile(configPath, 'utf8')))
  await mkdir('.host-lab', { recursive: true, mode: 0o700 })
  const runDirectory = resolve('.host-lab', `bot-${Date.now()}-${randomUUID()}`)
  await mkdir(runDirectory, { mode: 0o700 })
  const api = (method, params) => rpc(config, method, params)
  let result
  if (command === 'doctor') result = await preflight(config, api)
  else if (command === 'prepare') result = await prepare(config, runDirectory, flags)
  else if (command === 'sessions') {
    await preflight(config, api)
    result = await sharedSessionLab(config, runDirectory, flags, api)
  }
  else result = await smoke(config, runDirectory, flags)
  await writeFile(resolve(runDirectory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  process.exitCode = ['supported', 'captured', 'needs_account'].includes(result.status) || (command === 'doctor' && result.botSupport) ? 0 : 2
  return result
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    if (error?.code === 'ENOENT' && error.path === resolve('.maestrly-host-lab.json')) {
      process.stderr.write('LAB_CONFIG_MISSING: create private .maestrly-host-lab.json; see docs/maestrly-bot-lab.md. No host was contacted.\n')
      process.exitCode = 1
      return
    }
    process.stderr.write(`bot-lab: blocked; ${String(error?.message ?? error).split('\n')[0].slice(0, 200)}\n`)
    process.exitCode = 1
  })
