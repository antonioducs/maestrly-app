#!/usr/bin/env node
// Phase 3 laboratory: live desktop and human handoff on the selected Mac mini.
// Without arguments it only queries (sanitized doctor). `run --authorize-desktop-lab` also
// requires authorizeDesktopLab in the private .maestrly-host-lab.json and a ready bot on the
// explicitly selected botVmId, on an already updated Host and environment. It never prepares,
// restarts, archives or deletes anything and never picks a VM on its own. The media ticket
// travels only over stdin of the fixed desktop-stdio command, like the app does.
import { spawn } from 'node:child_process'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { Duplex, PassThrough } from 'node:stream'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { record, sshArguments, validateConfig } from './host-lab.mjs'
import { RfbClient } from './test/rfb-client.mjs'

export const HOST_COMMAND = '/Library/MaestrlyHost/bin/maestrly-host'
export const ATTACH_LINE_MAX = 512
export const TARGETS = { firstFrameMs: 5000, inputToPixelP95Ms: 250, renewMaxMs: 1000, updatesPerSecond: 10 }
// Short and deterministic: the command tool (not the GUI) keeps the continuation within budget.
export const TASK =
  'Use a ferramenta de comandos do sistema (não a interface gráfica) para executar `sleep 30`. Quando ele terminar, crie o arquivo lab-desktop.md contendo exatamente a linha "maestrly desktop lab ok" e responda quando terminar.'
/** Methods usable without desktop lab consent: none of them changes Host, VM or bot state. */
export const READ_ONLY_METHODS = ['host.inspect', 'vm.list', 'bot.list', 'bot.inspect', 'bot.auth.status', 'bot.desktop.inspect', 'bot.desktop.operation.get', 'bot.turn.get', 'bot.files.list']
export function guardDesktopLab(config, method, flags) {
  if (READ_ONLY_METHODS.includes(method)) return
  if (config.authorizeDesktopLab !== true || !flags.includes('--authorize-desktop-lab'))
    throw Error('DESKTOP_LAB_NOT_AUTHORIZED: set authorizeDesktopLab and pass --authorize-desktop-lab')
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor((p / 100) * values.length))]
const stableCode = (value) => (typeof value === 'string' && /^[A-Z_]{1,64}$/.test(value) ? value : 'HOST_ERROR')
const remote = (config, command) => {
  const args = sshArguments(config)
  args[args.length - 1] = `${HOST_COMMAND} ${command}`
  return args
}

/** One persistent rpc-stdio session: desktop views and control are bound to their connection. */
export class HostSession {
  #child
  #pending = new Map()
  #buffer = ''
  #closed = false
  constructor(config, flags, launch = spawn) {
    this.config = config
    this.flags = flags
    this.#child = launch('/usr/bin/ssh', remote(config, 'rpc-stdio'), { stdio: ['pipe', 'pipe', 'pipe'] })
    // SSH and Host diagnostics may contain local paths; only stable codes are kept.
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
  request(method, params, timeoutMs = 45_000) {
    guardDesktopLab(this.config, method, this.flags)
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

/** Reads the bounded accept line of desktop-stdio; returns any RFB bytes that followed it. */
export function readAttachReply(stdout, timeoutMs = 20_000) {
  return new Promise((resolveReply, reject) => {
    let buffer = Buffer.alloc(0)
    const finish = (error, value) => {
      clearTimeout(timer)
      stdout.off('data', onData)
      stdout.off('end', onEnd)
      error ? reject(error) : resolveReply(value)
    }
    const onEnd = () => finish(Object.assign(Error('Desktop media closed'), { code: 'DESKTOP_UNAVAILABLE' }))
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const newline = buffer.indexOf(10)
      if (newline < 0) {
        if (buffer.length > ATTACH_LINE_MAX) finish(Object.assign(Error('Invalid attach reply'), { code: 'DESKTOP_UNAVAILABLE' }))
        return
      }
      stdout.pause()
      let reply
      try {
        reply = JSON.parse(buffer.subarray(0, newline).toString('utf8'))
      } catch {
        return finish(Object.assign(Error('Invalid attach reply'), { code: 'DESKTOP_UNAVAILABLE' }))
      }
      if (reply?.accepted === true && Number.isInteger(reply.width) && Number.isInteger(reply.height))
        return finish(undefined, { width: reply.width, height: reply.height, leftover: buffer.subarray(newline + 1) })
      finish(Object.assign(Error('Desktop attach refused'), { code: stableCode(reply?.code) }))
    }
    const timer = setTimeout(() => finish(Object.assign(Error('Desktop media did not answer'), { code: 'DESKTOP_UNAVAILABLE' })), timeoutMs)
    stdout.on('data', onData)
    stdout.once('end', onEnd)
  })
}
export async function openMedia(config, ticket, launch = spawn) {
  if (!/^[a-f0-9]{64}$/.test(ticket)) throw Error('Invalid desktop ticket')
  const child = launch('/usr/bin/ssh', remote(config, 'desktop-stdio'), { stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.resume()
  child.stdin.on('error', () => {})
  const reply = readAttachReply(child.stdout)
  child.stdin.write(`${JSON.stringify({ version: 1, ticket })}\n`)
  let attached
  try {
    attached = await reply
  } catch (error) {
    child.kill()
    throw error
  }
  const readable = new PassThrough()
  if (attached.leftover.length) readable.write(attached.leftover)
  child.stdout.pipe(readable)
  child.stdout.resume()
  const stream = Duplex.from({ readable, writable: child.stdin })
  stream.on('error', () => {})
  stream.once('close', () => child.kill())
  child.once('close', () => stream.destroy())
  return { stream, child, width: attached.width, height: attached.height }
}

/** Sanitized, read-only view of the live desktop readiness on the selected VM. */
export async function doctor(config, session) {
  const host = await session.request('host.inspect', {})
  const vms = await session.request('vm.list', { includeRetained: true })
  const selected = config.botVmId ? vms.find((vm) => vm.id === config.botVmId && vm.state !== 'removed') : undefined
  const bots = selected ? (await session.request('bot.list', {})).filter((bot) => bot.vmId === selected.id) : []
  const live = host.capabilities.includes('desktop.live.v1') && host.capabilities.includes('desktop.handoff.v1')
  const desktops = []
  // An older Host does not know bot.desktop.* and would drop the session; do not ask it.
  for (const bot of bots)
    desktops.push(
      !live
        ? { error: 'HOST_UPDATE_REQUIRED' }
        : await session.request('bot.desktop.inspect', { botId: bot.id }).then(
            (state) => ({ mode: state.mode, available: state.available, capabilities: state.capabilities, viewers: state.viewers, controlled: state.controlled, reasonCode: state.reasonCode ?? null }),
            (error) => ({ error: stableCode(error.code) })
          )
    )
  const usable = desktops.filter((desktop) => desktop.available && desktop.capabilities?.length === 2).length
  return {
    version: 1,
    hostId: host.id,
    serviceVersion: host.serviceVersion,
    live,
    selectedVm: selected ? { id: selected.id, name: selected.name, state: selected.state } : null,
    bots: bots.map((bot, i) => ({ id: bot.id, name: bot.name, status: bot.status, busy: !!bot.activeTurnId, desktop: desktops[i] })),
    nextStep: !config.botVmId || !selected
      ? 'SELECT_VM: set botVmId to the exact existing VM'
      : !live
        ? 'UPDATE_HOST: install the phase 3 Host in an authorized window'
        : !usable
          ? 'UPDATE_ENVIRONMENT: update the selected environment and restart that VM in an authorized window'
          : 'READY: npm run lab:bot:desktop -- run --authorize-desktop-lab',
  }
}

async function settle(session, operation, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  let current = operation
  while (current.status === 'running') {
    if (Date.now() > deadline) throw Error('HANDOFF_TIMEOUT: inspect the desktop operation before retrying')
    await sleep(500)
    current = await session.request('bot.desktop.operation.get', { operationId: current.id })
  }
  return current
}
async function changed(client, digest, timeoutMs = 3000) {
  const started = performance.now()
  while (client.digest() === digest) {
    if (performance.now() - started > timeoutMs) return undefined
    await client.update(true, 1000).catch(() => {})
  }
  return performance.now() - started
}

/** Physical scenarios through SSH, the Host gateway, the virtio lanes and the guest services. */
export async function live(config, directory, flags, session, media = (ticket) => openMedia(config, ticket)) {
  guardDesktopLab(config, 'bot.desktop.open', flags)
  if (!config.botVmId) throw Error('SELECTED_VM_REQUIRED: set botVmId to the exact existing VM')
  const readiness = await doctor(config, session)
  await record(directory, 'preflight', readiness)
  if (!readiness.nextStep.startsWith('READY')) return { status: 'blocked', reason: readiness.nextStep }
  const bots = (await session.request('bot.list', {})).filter((bot) => bot.vmId === config.botVmId && bot.status === 'ready')
  const usable = []
  for (const bot of bots) {
    const state = await session.request('bot.desktop.inspect', { botId: bot.id }).catch(() => undefined)
    if (state?.available && state.mode === 'bot' && state.capabilities.length === 2) usable.push(bot)
  }
  const [a, b] = usable
  if (!a) return { status: 'blocked', reason: 'NO_READY_BOT_WITH_DESKTOP' }
  if (a.activeTurnId) throw Error('BOT_BUSY: finish the current task before the desktop lab')
  if ((await session.request('bot.auth.status', { botId: a.id })).state !== 'connected') return { status: 'blocked', reason: 'ACCOUNT_REQUIRED: connect the AI account in the app' }
  const report = { status: 'running', botId: a.id, secondBotId: b?.id ?? null, scenarios: {}, targets: TARGETS }
  const clientInstanceId = randomUUID()
  const views = new Set()
  let control
  let renewControl = true
  const renewals = []
  const view = async (bot) => {
    const started = performance.now()
    const opened = await session.request('bot.desktop.open', { botId: bot.id, clientInstanceId })
    const attached = await media(opened.mediaTicket)
    const client = await RfbClient.connect(attached.stream, { timeoutMs: 15_000 })
    await client.update(false, 15_000)
    const entry = { viewId: opened.viewId, bot, attached, client, firstFrameMs: Math.round(performance.now() - started) }
    views.add(entry)
    return entry
  }
  const closeView = async (entry) => {
    views.delete(entry)
    entry.client.close()
    await session.request('bot.desktop.close', { viewId: entry.viewId }).catch(() => {})
  }
  let renewing = true
  const renewer = (async () => {
    while (renewing) {
      for (const entry of [...views]) {
        const controlling = control && entry === control.view && renewControl
        const started = performance.now()
        try {
          const result = await session.request('bot.desktop.renew', { viewId: entry.viewId, ...(controlling ? { controlEpoch: control.epoch, controlCapability: control.capability } : {}) })
          renewals.push(Math.round(performance.now() - started))
          if (controlling && !result.controlling) control.lost = true
        } catch (error) {
          renewals.push(stableCode(error.code))
        }
      }
      for (let i = 0; i < 30 && renewing; i++) await sleep(100)
    }
  })()
  try {
    const va = await view(a)
    report.scenarios.stream = { firstFrameMs: va.firstFrameMs, width: va.client.width, height: va.client.height }
    const va2 = await view(a)
    report.scenarios.twoClients = { opened: !va2.client.closed, firstFrameMs: va2.firstFrameMs }
    if (b) {
      const vb = await view(b)
      report.scenarios.twoBots = { distinctScreens: vb.client.digest() !== va.client.digest(), firstFrameMs: vb.firstFrameMs }
    } else report.scenarios.twoBots = { skipped: 'SECOND_BOT_MISSING' }
    // A real task, then takeover while it runs.
    const clientMessageId = randomUUID()
    await record(directory, 'intent-task', { botId: a.id, clientMessageId })
    const receipt = await session.request('bot.messages.send', { botId: a.id, clientMessageId, content: TASK })
    const turnId = receipt.turn.id
    for (const deadline = Date.now() + 180_000; ; await sleep(2000)) {
      const turn = await session.request('bot.turn.get', { turnId })
      if (turn.status === 'running') break
      if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(turn.status) || Date.now() > deadline)
        return { ...report, status: 'blocked', reason: `TASK_NOT_RUNNING: ${turn.status}` }
    }
    await sleep(8000)
    const acquireStarted = performance.now()
    let state = await session.request('bot.desktop.inspect', { botId: a.id })
    let operation = await session.request('bot.desktop.acquire', { viewId: va.viewId, expectedRevision: state.revision, idempotencyKey: randomUUID() })
    await record(directory, 'intent-acquire', { operationId: operation.id })
    operation = await settle(session, operation)
    if (operation.status !== 'succeeded') return { ...report, status: 'blocked', reason: `ACQUIRE_FAILED: ${operation.failureCode ?? 'UNKNOWN'}` }
    const claim = await session.request('bot.desktop.claimControl', { viewId: va.viewId, operationId: operation.id })
    control = { view: va, capability: claim.controlCapability, epoch: claim.controlEpoch, desktopGeneration: claim.desktopGeneration, sequence: 0 }
    const interrupted = await session.request('bot.turn.get', { turnId })
    report.scenarios.takeover = {
      ms: Math.round(performance.now() - acquireStarted),
      mode: claim.state.mode,
      // The Host socket replaces nested error objects, so the takeover is proven by the handoff
      // operation itself: it names exactly the task turn it interrupted for the person.
      turnInterruptedForHuman: interrupted.status === 'interrupted' && operation.interruptedTurnId === turnId,
      otherBotStillBot: b ? (await session.request('bot.desktop.inspect', { botId: b.id })).mode === 'bot' : null,
    }
    const input = (events) => session.request('bot.desktop.input', { viewId: va.viewId, controlCapability: control.capability, controlEpoch: control.epoch, desktopGeneration: control.desktopGeneration, sequence: control.sequence++, events })
    // Input-to-pixel through the app path: open and close a context menu.
    const samples = []
    let misses = 0
    for (let i = 0; i < 10; i++) {
      for (const events of [
        [{ kind: 'button', button: 'right', down: true, x: 1150, y: 720 }, { kind: 'button', button: 'right', down: false, x: 1150, y: 720 }],
        [{ kind: 'key', code: 'Escape', keysym: 0xff1b, down: true }, { kind: 'key', code: 'Escape', keysym: 0xff1b, down: false }],
      ]) {
        const digest = va.client.digest()
        const started = performance.now()
        await input(events)
        const elapsed = await changed(va.client, digest)
        if (elapsed === undefined) misses++
        else samples.push(performance.now() - started)
      }
    }
    report.scenarios.inputToPixel = { p50: samples.length ? Math.round(percentile(samples, 50)) : null, p95: samples.length ? Math.round(percentile(samples, 95)) : null, samples: samples.length, misses, method: 'context menu open/close through SSH rpc-stdio, Host, virtio control lane and XTEST; pixel through desktop-stdio and the virtio media lane (Raw-encoding test client)' }
    // Continuous human interaction: a rubber-band drag measures screen updates per second.
    const counted = va.client.updates
    const dragStarted = performance.now()
    const pump = (async () => { while (performance.now() - dragStarted < 3000) await va.client.update(true, 500).catch(() => {}) })()
    await input([{ kind: 'button', button: 'left', down: true, x: 100, y: 520 }])
    for (let i = 1; performance.now() - dragStarted < 3000; i++) await input([{ kind: 'pointer', x: 100 + ((i * 9) % 500), y: 520 + ((i * 5) % 200) }])
    await input([{ kind: 'releaseAll' }])
    await pump
    report.scenarios.updatesDuringDrag = Math.round(((va.client.updates - counted) / ((performance.now() - dragStarted) / 1000)) * 10) / 10
    // One viewer disconnects: the controller keeps working.
    va2.attached.child.kill()
    await sleep(2500)
    views.delete(va2)
    const digest = va.client.digest()
    await input([{ kind: 'button', button: 'right', down: true, x: 1150, y: 720 }, { kind: 'button', button: 'right', down: false, x: 1150, y: 720 }])
    report.scenarios.viewerDisconnect = { controllerStillSees: (await changed(va.client, digest)) !== undefined, controlling: !control.lost }
    await input([{ kind: 'key', code: 'Escape', keysym: 0xff1b, down: true }, { kind: 'key', code: 'Escape', keysym: 0xff1b, down: false }])
    // The controller stops renewing: the bot pauses instead of resuming on its own.
    renewControl = false
    const expiryStarted = performance.now()
    for (;;) {
      state = await session.request('bot.desktop.inspect', { botId: a.id })
      if (state.mode === 'paused' || performance.now() - expiryStarted > 25_000) break
      await sleep(500)
    }
    report.scenarios.leaseLoss = { mode: state.mode, afterMs: Math.round(performance.now() - expiryStarted), input: await input([{ kind: 'pointer', x: 5, y: 5 }]).then(() => 'applied', (error) => stableCode(error.code)) }
    // Hand back with continuation from the paused state.
    const returnStarted = performance.now()
    operation = await session.request('bot.desktop.return', { botId: a.id, viewId: va.viewId, expectedRevision: state.revision, idempotencyKey: randomUUID(), continueTask: true })
    await record(directory, 'intent-return', { operationId: operation.id })
    operation = await settle(session, operation)
    report.scenarios.return = { status: operation.status, failureCode: operation.failureCode ?? null, ms: Math.round(performance.now() - returnStarted), resumeOf: operation.interruptedTurnId === turnId, continuation: !!operation.continuationTurnId }
    if (operation.continuationTurnId) {
      let turn
      for (const deadline = Date.now() + 10 * 60_000; ; await sleep(3000)) {
        turn = await session.request('bot.turn.get', { turnId: operation.continuationTurnId })
        if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(turn.status) || Date.now() > deadline) break
      }
      const files = await session.request('bot.files.list', { botId: a.id, path: '' })
      report.scenarios.continuation = { status: turn.status, fileProduced: files.some((file) => file.path === 'lab-desktop.md') }
    }
    report.renewMs = { max: Math.max(0, ...renewals.filter((value) => typeof value === 'number')), failures: renewals.filter((value) => typeof value !== 'number') }
    const s = report.scenarios
    report.checks = {
      stream: s.stream.width > 0 && s.stream.height > 0,
      twoClients: s.twoClients.opened,
      twoBots: s.twoBots.skipped ? null : s.twoBots.distinctScreens,
      takeover: s.takeover.mode === 'human' && s.takeover.turnInterruptedForHuman && s.takeover.otherBotStillBot !== false,
      input: s.inputToPixel.samples >= 15,
      viewerDisconnect: s.viewerDisconnect.controllerStillSees && s.viewerDisconnect.controlling,
      leaseLoss: s.leaseLoss.mode === 'paused' && s.leaseLoss.input === 'CONTROL_EXPIRED',
      return: s.return.status === 'succeeded' && s.return.resumeOf && s.return.continuation,
      continuation: s.continuation?.status === 'succeeded' && s.continuation.fileProduced === true,
    }
    report.targetsMet = {
      firstFrame: s.stream.firstFrameMs <= TARGETS.firstFrameMs,
      inputToPixelP95: s.inputToPixel.p95 !== null && s.inputToPixel.p95 <= TARGETS.inputToPixelP95Ms,
      renew: report.renewMs.max <= TARGETS.renewMaxMs,
      updates: s.updatesDuringDrag >= TARGETS.updatesPerSecond,
    }
    report.status = Object.values(report.checks).every((value) => value !== false) ? 'supported' : 'blocked'
    report.notRun = ['archive/stop while viewing (destructive for lab data)', 'packaged app GUI (see bot-desktop-real.spec.ts)', 'media saturation beyond one drag']
    return report
  } finally {
    renewing = false
    await renewer
    for (const entry of [...views]) await closeView(entry)
  }
}

export async function main(args = process.argv.slice(2), launch = spawn) {
  const [command = 'doctor', ...flags] = args
  if (!['doctor', 'run'].includes(command) || flags.some((flag) => flag !== '--authorize-desktop-lab') || (command === 'doctor' && flags.length))
    throw Error('Usage: bot-desktop-lab.mjs [doctor] | run --authorize-desktop-lab')
  const configPath = resolve('.maestrly-host-lab.json')
  const info = await lstat(configPath)
  if (!info.isFile() || info.uid !== process.getuid?.() || info.size > 16384 || (info.mode & 0o077) !== 0)
    throw Error('Lab config must be a private regular file (chmod 600)')
  const config = validateConfig(JSON.parse(await readFile(configPath, 'utf8')))
  if (command === 'run') guardDesktopLab(config, 'bot.desktop.open', flags)
  await mkdir('.host-lab', { recursive: true, mode: 0o700 })
  const runDirectory = resolve('.host-lab', `desktop-lab-${Date.now()}-${randomUUID()}`)
  await mkdir(runDirectory, { mode: 0o700 })
  const session = new HostSession(config, flags, launch)
  let result
  try {
    result = command === 'doctor' ? await doctor(config, session) : await live(config, runDirectory, flags, session)
  } finally {
    session.close()
  }
  await writeFile(resolve(runDirectory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  process.exitCode = command === 'doctor' || result.status === 'supported' ? 0 : 2
  return result
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    if (error?.code === 'ENOENT' && error.path === resolve('.maestrly-host-lab.json')) {
      process.stderr.write('LAB_CONFIG_MISSING: create private .maestrly-host-lab.json; see docs/maestrly-bot-lab.md. No host was contacted.\n')
      process.exitCode = 1
      return
    }
    process.stderr.write(`bot-desktop-lab: blocked; ${String(error?.message ?? error).split('\n')[0].slice(0, 200)}\n`)
    process.exitCode = 1
  })
