#!/usr/bin/env node
// Phase 5 laboratory: routines and voice messages on the selected Mac mini.
//
// Without arguments it only queries (sanitized doctor). Creating a routine, recording audio or
// transcribing anything additionally requires the private .maestrly-host-lab.json to say so —
// allowRoutineSmoke / allowVoiceSmoke — plus the matching flag on the command line, and an
// explicitly named routineBotId. The lab never picks "the first free bot", never creates a bot,
// an account or a VM, never prepares or restarts a guest, and never deletes anything it did not
// create. Keys, tokens, transcripts and the administrator password are never printed.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HostSession as BaseSession, CONFIG_FILE } from './bot-team-lab.mjs'
import { validateConfig } from './host-lab.mjs'

/** Methods usable without consent: none of them changes Host, VM, bot, routine or audio state. */
export const READ_ONLY_METHODS = [
  'host.inspect',
  'vm.list',
  'bot.list',
  'bot.inspect',
  'bot.auth.status',
  'bot.session.inspect',
  'bot.turn.get',
  'team.list',
  'team.inspect',
  'routine.list',
  'routine.inspect',
  'routine.occurrences.list',
  'routine.occurrence.inspect',
  'routine.events.list',
  'routine.proposals.list',
  'routine.operation.lookup',
  'voice.status',
  'voice.job.inspect',
  'voice.clip.inspect',
  'voice.forMessages',
  'voice.operation.lookup',
]
/** Methods that only a routine consent unlocks. A preview creates nothing, but it is still work. */
const ROUTINE_METHODS = [
  'routine.preview',
  'routine.activate',
  'routine.pause',
  'routine.archive',
  'routine.runNow',
  'routine.proposals.dismiss',
  'routine.occurrence.cancel',
]
/** Methods that only a voice consent unlocks: they move real audio of a real person. */
const VOICE_METHODS = [
  'voice.upload.begin',
  'voice.upload.chunk',
  'voice.upload.finish',
  'voice.transcribe',
  'voice.job.cancel',
  'voice.clip.read',
  'voice.clip.remove',
  'voice.send',
]

export function guardPhase5(config, method, flags) {
  if (READ_ONLY_METHODS.includes(method)) return
  if (ROUTINE_METHODS.includes(method)) {
    if (config.allowRoutineSmoke !== true || !flags.includes('--authorize-routine-smoke'))
      throw Error('ROUTINE_LAB_NOT_AUTHORIZED: set allowRoutineSmoke and pass --authorize-routine-smoke')
    return
  }
  if (VOICE_METHODS.includes(method)) {
    if (config.allowVoiceSmoke !== true || !flags.includes('--authorize-voice-smoke'))
      throw Error('VOICE_LAB_NOT_AUTHORIZED: set allowVoiceSmoke and pass --authorize-voice-smoke')
    return
  }
  throw Error('PHASE5_METHOD_NOT_ALLOWED: this laboratory does not use that method')
}

/**
 * The target is exactly the bot (or team) the operator named. Reusing a consent given for
 * another phase, or inferring a target from the first entry of a list, would mean running real
 * work against something nobody chose.
 */
export function selectTarget(config, bots, teams = []) {
  if (typeof config.routineBotId !== 'string' || !config.routineBotId)
    throw Error('ROUTINE_TARGET_REQUIRED: name an explicit routineBotId in the lab configuration')
  const bot = bots.find((candidate) => candidate.id === config.routineBotId)
  if (!bot) throw Error('ROUTINE_TARGET_MISSING: the configured bot does not exist on this Host')
  if (bot.status !== 'ready') throw Error('ROUTINE_TARGET_NOT_READY: the configured bot is not ready')
  const team = config.routineTeamId ? teams.find((candidate) => candidate.id === config.routineTeamId) : undefined
  if (config.routineTeamId && !team)
    throw Error('ROUTINE_TEAM_MISSING: the configured team does not exist on this Host')
  return { bot, team }
}

/**
 * Same transport as the team laboratory, with this phase's own consent guard in place of the team
 * one. guardPhase5 is a complete policy — it refuses any method it does not list — so nothing is
 * lost by not consulting the team guard, and the routine/voice inventory reads it allows are not
 * mistaken for team work.
 */
export class HostSession extends BaseSession {
  guard(method) {
    guardPhase5(this.config, method, this.flags)
  }
}

export async function loadPhase5Config(directory = process.cwd()) {
  const raw = await readFile(resolve(directory, CONFIG_FILE), 'utf8').catch(() => {
    throw Error(`Explicit ${CONFIG_FILE} required for the phase 5 laboratory`)
  })
  return validateConfig(JSON.parse(raw))
}

/**
 * Read-only inventory. It answers the questions a rollout actually needs: does this Host know
 * about routines, can it transcribe at all, what is already scheduled, and is the named target
 * in a state where a firing could run. It changes nothing and records no audio.
 */
export async function doctor(session) {
  const host = await session.request('host.inspect', {})
  const bots = await session.request('bot.list', { includeArchived: false })
  const routinesSupported = host.capabilities.includes('routines.v1')
  const voiceSupported = host.capabilities.includes('voice.messages.v1')
  const teams = host.capabilities.includes('teams.v1')
    ? await session.request('team.list', { includeArchived: false })
    : []
  const routines = routinesSupported ? await session.request('routine.list', { includeArchived: false }) : []
  const voice = voiceSupported ? await session.request('voice.status', {}) : undefined
  let target
  let blocker
  try {
    target = selectTarget(session.config, bots, teams)
  } catch (error) {
    blocker = error.message.split(':')[0]
  }
  const inspected = target ? await session.request('bot.inspect', { botId: target.bot.id }) : undefined
  return {
    host: { id: host.id, serviceVersion: host.serviceVersion, routines: routinesSupported, voice: voiceSupported },
    bots: bots.length,
    teams: teams.length,
    // Names and schedules only: the recurring request itself may be private.
    routines: routines.map((routine) => ({
      name: routine.spec.name,
      status: routine.status,
      nextDueUtc: routine.nextDueUtc,
      target: routine.spec.target.kind,
    })),
    transcription: voice
      ? {
          state: voice.state,
          modelId: voice.modelId,
          queueDepth: voice.queueDepth,
          usedBytes: voice.usedBytes,
          quotaBytes: voice.quotaBytes,
        }
      : undefined,
    computers: (await session.request('vm.list', { includeRetained: false })).map((vm) => ({
      id: vm.id,
      state: vm.state,
      health: vm.health,
    })),
    target: inspected
      ? {
          name: inspected.name,
          status: inspected.status,
          runtimeState: inspected.runtimeState,
          accountState: inspected.accountState,
          busy: !!inspected.activeTurnId,
          team: target?.team?.name,
        }
      : undefined,
    ...(blocker ? { blocker } : {}),
    ready:
      routinesSupported &&
      !!inspected &&
      inspected.status === 'ready' &&
      inspected.accountState === 'connected' &&
      !inspected.activeTurnId,
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(fn, predicate, timeoutMs = 900_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (predicate(value)) return value
    if (Date.now() > deadline) throw Object.assign(Error('Timed out waiting for the Host'), { code: 'TIMEOUT' })
    await sleep(5_000)
  }
}

/** A moment a few minutes from now, so the Host has to keep the schedule without the app. */
export function soon(minutes = 3, now = Date.now()) {
  const at = new Date(now + minutes * 60_000)
  at.setSeconds(0, 0)
  return at.toISOString()
}

/**
 * The routine gate: activate a single firing a few minutes out, then wait for the Host to run
 * it with nothing else connected. It stops what it created — and only what it created — so
 * nothing stays scheduled after the run.
 */
export async function routineSmoke(session, options = {}) {
  const { bot } = selectTarget(session.config, await session.request('bot.list', { includeArchived: false }))
  const timeZone = session.config.timeZone ?? 'America/Sao_Paulo'
  const spec = {
    name: `Verificação de rotina ${new Date().toISOString().slice(11, 16)}`,
    request: 'Escreva uma frase curta confirmando que esta execução programada aconteceu, com a data e a hora atuais.',
    target: { kind: 'bot', id: bot.id },
    schedule: { kind: 'once', atUtc: soon(options.minutes ?? 3), timeZone },
  }
  const preview = await session.request('routine.preview', { spec })
  if (!preview.feasible) throw Object.assign(Error('The Host refused this schedule'), { code: 'ROUTINE_NOT_FEASIBLE' })
  const activated = await session.request('routine.activate', {
    previewId: preview.previewId,
    fingerprint: preview.fingerprint,
    idempotencyKey: randomUUID(),
    confirmSchedule: true,
  })
  const routineId = activated.routine.id
  try {
    const scheduledFor = preview.occurrences[0]
    const details = await until(
      () => session.request('routine.inspect', { routineId }),
      (value) =>
        value.recent.some((occurrence) =>
          ['succeeded', 'partial', 'failed', 'cancelled', 'skipped'].includes(occurrence.status)
        ),
      options.timeoutMs ?? 900_000
    )
    const occurrence = details.recent.find((entry) =>
      ['succeeded', 'partial', 'failed', 'cancelled', 'skipped'].includes(entry.status)
    )
    const history = await session.request('routine.occurrences.list', { routineId, limit: 20 })
    return {
      routineId,
      scheduledForUtc: scheduledFor?.scheduledForUtc,
      scheduledForLocal: scheduledFor?.scheduledForLocal,
      startedAt: occurrence?.startedAt,
      finishedAt: occurrence?.finishedAt,
      status: occurrence?.status,
      causeCode: occurrence?.causeCode,
      // One firing and one execution: the property this gate exists to prove.
      occurrences: history.occurrences.length,
      executions: history.occurrences.filter((entry) => entry.execution).length,
      usedActiveMs: occurrence?.usedActiveMs,
      summaryLength: occurrence?.summary?.length ?? 0,
    }
  } finally {
    // Whatever happened, nothing this lab created stays scheduled.
    const current = await session.request('routine.inspect', { routineId })
    if (current.routine.status === 'active')
      await session
        .request('routine.pause', {
          routineId,
          expectedRevision: current.routine.revision,
          idempotencyKey: randomUUID(),
        })
        .catch(() => {})
  }
}

/**
 * The transcription gate: send one consented recording to the Host and confirm its own packaged
 * worker produced text. The audio file is supplied by the operator; this script never records
 * anybody and never prints what was said.
 */
export async function voiceSmoke(session, options = {}) {
  const file = options.audio ?? session.config.voiceSampleFile
  if (!file)
    throw Error('VOICE_SAMPLE_REQUIRED: point voiceSampleFile at a consented canonical WAV (16 kHz mono PCM16)')
  const { bot } = selectTarget(session.config, await session.request('bot.list', { includeArchived: false }))
  const audio = await readFile(resolve(file))
  const { createHash } = await import('node:crypto')
  const status = await session.request('voice.status', {})
  if (!status.available) throw Object.assign(Error('This Host cannot transcribe yet'), { code: 'VOICE_UNAVAILABLE' })
  const durationMs = Math.round(((audio.length - 44) / (16_000 * 2)) * 1000)
  const started = Date.now()
  const transfer = await session.request('voice.upload.begin', {
    target: { kind: 'bot', id: bot.id },
    clientClipId: randomUUID(),
    sizeBytes: audio.length,
    durationMs,
    sha256: createHash('sha256').update(audio).digest('hex'),
  })
  let offset = transfer.offset
  while (offset < audio.length) {
    const chunk = audio.subarray(offset, Math.min(offset + transfer.chunkBytes, audio.length))
    const state = await session.request('voice.upload.chunk', {
      transferId: transfer.transferId,
      offset,
      dataBase64: chunk.toString('base64'),
    })
    offset = state.offset
  }
  const clip = await session.request('voice.upload.finish', { transferId: transfer.transferId })
  const uploadedAt = Date.now()
  const job = await session.request('voice.transcribe', { clipId: clip.id, idempotencyKey: randomUUID() })
  const done = await until(
    () => session.request('voice.job.inspect', { jobId: job.id }),
    (value) => ['succeeded', 'failed', 'cancelled'].includes(value.state),
    options.timeoutMs ?? 900_000
  )
  return {
    clipId: clip.id,
    durationMs: clip.durationMs,
    bytes: clip.bytes,
    state: done.state,
    failureCode: done.failureCode,
    language: done.language,
    // Length and word count only: a transcript is the most private thing here.
    transcriptLength: done.transcript?.length ?? 0,
    transcriptWords: done.transcript ? done.transcript.trim().split(/\s+/).length : 0,
    uploadMs: uploadedAt - started,
    transcribeMs: Date.now() - uploadedAt,
    modelId: status.modelId,
  }
}

async function main() {
  const [command = 'doctor', ...flags] = process.argv.slice(2)
  const config = await loadPhase5Config()
  const session = new HostSession(config, flags)
  try {
    const report = { command, at: new Date().toISOString(), doctor: await doctor(session) }
    if (flags.includes('--authorize-routine-smoke')) report.routine = await routineSmoke(session)
    if (flags.includes('--authorize-voice-smoke')) report.voice = await voiceSmoke(session)
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
