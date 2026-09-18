import { createHash, randomUUID } from 'node:crypto'
import {
  VOICE_AUDIO,
  VOICE_LIMITS,
  VOICE_MUTATIONS,
  voiceResultSchemas,
  type TargetRef,
  type VoiceClip,
  type VoiceJob,
  type VoiceMessageMeta,
  type VoiceMethod,
  type VoiceOperation,
  type VoiceRequest,
  type VoiceResult,
  type VoiceStatus,
  type VoiceTransfer,
} from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import type { BotRepository } from '../bots/repository.js'
import type { RuntimeCoordinator } from '../bots/runtime-coordinator.js'
import type { BotTurns } from '../bots/turns.js'
import type { TeamRepository } from '../teams/repository.js'
import type { TeamService } from '../teams/service.js'
import { inspectAsrBundle, type AsrBundleState } from './assets.js'
import { type VoiceRepository, now } from './repository.js'
import { VoiceStorage } from './uploads.js'
import { type CanonicalWav, decodePcm, durationForSize, isSilent } from './wav.js'
import { AsrWorkerClient, type AsrOptions } from './worker-client.js'

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  return JSON.stringify(value)
}
const fingerprint = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')

export interface VoiceServiceOptions {
  voice: VoiceRepository
  bots: BotRepository
  teams: TeamRepository
  turns: BotTurns
  coordinator: RuntimeCoordinator
  teamService: () => TeamService
  stateDirectory: string
  asr?: AsrOptions
}

/**
 * Voice messages, end to end on the person's own machines.
 *
 * The shape of this file follows one rule: recording, transcribing and sending are three
 * separate decisions, and only the last one creates work. An upload never starts a bot. A
 * transcription never starts a bot. Silence, a cancellation or an empty transcript produce no
 * message and no task at all. Only `voice.send`, with text the person saw, admits a turn — and
 * only the text travels to the provider; the audio stays on this Host.
 */
export class VoiceService {
  readonly repo: VoiceRepository
  readonly storage: VoiceStorage
  readonly worker: AsrWorkerClient
  private bundleState: AsrBundleState
  private draining = false
  private closed = false
  constructor(private readonly options: VoiceServiceOptions) {
    this.repo = options.voice
    this.storage = new VoiceStorage(options.stateDirectory)
    this.bundleState = inspectAsrBundle(options.asr?.bundleDirectory)
    this.worker = new AsrWorkerClient(() => this.bundleState.bundle, options.asr ?? {})
  }
  isMutation(method: VoiceMethod) {
    return VOICE_MUTATIONS.includes(method)
  }
  close() {
    // Marked before the worker is stopped: closing settles the active job, and the drain loop
    // must not come back to a database that is already gone.
    this.closed = true
    this.worker.close()
  }

  status(): VoiceStatus {
    const running = this.repo.running()
    return {
      available: this.bundleState.state === 'ready' && !!this.options.asr?.factory,
      state: this.bundleState.state === 'ready' && !this.options.asr?.factory ? 'incompatible' : this.bundleState.state,
      ...(this.bundleState.modelId ? { modelId: this.bundleState.modelId } : {}),
      ...(this.bundleState.reason ? { reason: this.bundleState.reason } : {}),
      ...(this.bundleState.bundle ? { downloadBytes: this.bundleState.bundle.bytes } : {}),
      queueDepth: this.repo.queued().length,
      ...(running ? { activeJobId: running.id } : {}),
      quotaBytes: VOICE_LIMITS.quotaBytes,
      usedBytes: this.repo.usedBytes(),
      limits: {
        maxDurationMs: VOICE_LIMITS.maxDurationMs,
        maxWavBytes: VOICE_LIMITS.maxWavBytes,
        sampleRate: VOICE_AUDIO.sampleRate,
        channels: VOICE_AUDIO.channels,
      },
    }
  }

  /** The target has to exist here, and it has to be one this person can actually talk to. */
  private assertTarget(target: TargetRef) {
    if (target.kind === 'bot') {
      const bot = this.options.bots.bot(target.id)
      if (bot.status === 'archived') throw new HostError('BOT_ARCHIVED', 'Este bot está arquivado')
      return
    }
    const team = this.options.teams.team(target.id)
    if (team.status === 'archived') throw new HostError('TEAM_ARCHIVED', 'Esta equipe está arquivada')
  }

  // ------------------------------------------------------------------------------- upload

  private beginUpload(p: {
    target: TargetRef
    clientClipId: string
    sizeBytes: number
    durationMs: number
    sha256: string
  }): VoiceTransfer {
    this.assertTarget(p.target)
    const existing = this.repo.transferByClientClip(p.target, p.clientClipId)
    if (existing) {
      // The same recording retried: same transfer. Different bytes under the same name is a
      // conflict, never a silent overwrite of what was already accepted.
      if (existing.digest !== p.sha256 || existing.size !== p.sizeBytes)
        throw new HostError('VOICE_TRANSFER_CONFLICT', 'Esta gravação já foi enviada com outro conteúdo')
      return existing
    }
    // Duration is derived from the declared size, and both are checked again against the
    // real bytes at finish: a declared length proves nothing on its own.
    const implied = durationForSize(p.sizeBytes)
    if (implied <= 0 || implied > VOICE_LIMITS.maxDurationMs)
      throw new HostError('VOICE_FORMAT_INVALID', 'A gravação passa do tempo máximo permitido.')
    if (Math.abs(implied - p.durationMs) > 1_000)
      throw new HostError('VOICE_FORMAT_INVALID', 'A duração declarada não corresponde ao tamanho do áudio.')
    if (this.repo.usedBytes() + p.sizeBytes > VOICE_LIMITS.quotaBytes)
      throw new HostError(
        'VOICE_QUOTA_EXCEEDED',
        'O espaço reservado para áudios neste Host acabou. Remova gravações antigas para gravar de novo.'
      )
    const clipId = randomUUID()
    const transfer: VoiceTransfer = {
      transferId: randomUUID(),
      clipId,
      target: p.target,
      size: p.sizeBytes,
      offset: 0,
      chunkBytes: VOICE_LIMITS.chunkBytes,
      digest: p.sha256,
      done: false,
      expiresAt: new Date(Date.now() + VOICE_LIMITS.transferTtlMs).toISOString(),
    }
    this.repo.transaction(() => {
      const clip: VoiceClip = {
        id: clipId,
        target: p.target,
        state: 'uploading',
        bytes: p.sizeBytes,
        durationMs: implied,
        digest: p.sha256,
        sampleRate: VOICE_AUDIO.sampleRate,
        channels: VOICE_AUDIO.channels,
        expiresAt: new Date(Date.now() + VOICE_LIMITS.draftTtlMs).toISOString(),
        createdAt: now(),
        updatedAt: now(),
        revision: 0,
      }
      this.repo.saveClip(clip)
      this.repo.saveTransfer(transfer, p.clientClipId)
    })
    return transfer
  }

  private async chunk(p: { transferId: string; offset: number; dataBase64: string }): Promise<VoiceTransfer> {
    const transfer = this.load(p.transferId)
    const bytes = Buffer.from(p.dataBase64, 'base64')
    if (bytes.length > VOICE_LIMITS.chunkBytes || p.offset + bytes.length > transfer.size)
      throw new HostError('LIMIT', 'Este trecho passa do tamanho declarado.')
    // A repeated identical chunk is idempotent; a gap is refused with where to resume from.
    if (p.offset < transfer.offset) return transfer
    if (p.offset !== transfer.offset)
      throw new HostError('TRANSFER_OFFSET', `Deslocamento inesperado; retome a partir de ${transfer.offset}`)
    await this.storage.writeChunk(transfer.transferId, p.offset, bytes)
    const next: VoiceTransfer = {
      ...transfer,
      offset: p.offset + bytes.length,
      done: p.offset + bytes.length >= transfer.size,
    }
    this.repo.transaction(() => this.repo.saveTransfer(next, ''))
    return next
  }
  private load(transferId: string) {
    const transfer = this.repo.transfer(transferId)
    if (Date.parse(transfer.expiresAt) < Date.now()) {
      void this.storage.abort(transferId)
      this.repo.transaction(() => this.repo.deleteTransfer(transferId))
      throw new HostError('TRANSFER_EXPIRED', 'A transferência expirou; grave novamente')
    }
    return transfer
  }

  private async finishUpload(transferId: string): Promise<VoiceClip> {
    const transfer = this.load(transferId)
    if (!transfer.done) throw new HostError('TRANSFER_INCOMPLETE', 'A transferência ainda não terminou')
    const clip = this.repo.clip(transfer.clipId)
    if (clip.state === 'stored') return clip
    let parsed: CanonicalWav
    try {
      parsed = await this.storage.finalize(transfer.transferId, clip.id, {
        size: transfer.size,
        digest: transfer.digest,
      })
    } catch (error) {
      // A refused upload is over: the bytes were discarded, so the clip must stop counting
      // against the quota now, not when its draft TTL happens to expire. Seen on real hardware,
      // where one refused recording kept its full size reserved after the next one succeeded.
      this.repo.transaction(() => {
        this.repo.saveClip({ ...clip, state: 'expired', bytes: 0, revision: clip.revision + 1, updatedAt: now() })
        this.repo.deleteTransfer(transfer.transferId)
      })
      throw error
    }
    const stored: VoiceClip = {
      ...clip,
      state: 'stored',
      durationMs: parsed.durationMs,
      revision: clip.revision + 1,
      updatedAt: now(),
    }
    this.repo.transaction(() => {
      this.repo.saveClip(stored)
      this.repo.deleteTransfer(transfer.transferId)
    })
    return stored
  }

  // -------------------------------------------------------------------------- transcription

  /** Creates a transcription job. Uploading audio never started one; this is a separate act. */
  private transcribe(p: { clipId: string; idempotencyKey: string }): VoiceJob {
    const clip = this.repo.clip(p.clipId)
    if (clip.state !== 'stored')
      throw new HostError('VOICE_CLIP_EXPIRED', 'Esta gravação não está disponível para transcrição')
    const existing = this.repo.operationByKey(p.idempotencyKey)
    if (existing?.operation.detail?.jobId) return this.repo.job(existing.operation.detail.jobId as string)
    const pending = this.repo.latestJob(clip.id)
    if (pending && (pending.state === 'queued' || pending.state === 'running')) return pending
    if (this.repo.queued().length >= VOICE_LIMITS.queueMax)
      throw new HostError('VOICE_UNAVAILABLE', 'Há transcrições demais na fila deste Host; tente em instantes.')
    const previous = pending?.transcriptRevision ?? 0
    const job: VoiceJob = {
      id: randomUUID(),
      clipId: clip.id,
      target: clip.target,
      state: 'queued',
      generation: previous + 1,
      queuePosition: this.repo.queued().length,
      transcriptRevision: previous,
      createdAt: now(),
      updatedAt: now(),
      revision: 0,
    }
    this.repo.transaction(() => this.repo.saveJob(job))
    void this.drain()
    return job
  }

  /** One job at a time, driven from durable rows so a restart never loses or repeats one. */
  private async drain() {
    if (this.draining) return
    this.draining = true
    try {
      for (;;) {
        if (this.closed || this.worker.busy) return
        const [next] = this.repo.queued()
        if (!next) return
        const clip = this.repo.clip(next.clipId)
        if (clip.state !== 'stored') {
          this.fail(next, 'ASR_UNAVAILABLE', 'A gravação não está mais disponível.')
          continue
        }
        this.repo.transaction(() =>
          this.repo.saveJob({
            ...this.repo.job(next.id),
            state: 'running',
            startedAt: now(),
            revision: next.revision + 1,
            updatedAt: now(),
          })
        )
        let samples: Float32Array
        try {
          const audio = await this.storage.load(clip.id)
          if (this.closed) return
          samples = decodePcm(audio)
        } catch (error) {
          if (this.closed) return
          this.fail(
            this.repo.job(next.id),
            'ASR_UNAVAILABLE',
            error instanceof Error ? error.message.slice(0, 300) : 'Não foi possível ler a gravação.'
          )
          continue
        }
        // Checked before a model is loaded at all: silence must come back as silence, never
        // as a plausible sentence the person never said.
        if (isSilent(samples)) {
          this.fail(this.repo.job(next.id), 'ASR_NO_SPEECH', 'Não identificamos fala nesta gravação.')
          continue
        }
        const outcome = await this.worker.transcribe(next.id, samples)
        if (this.closed) return
        const current = this.repo.job(next.id)
        if (current.state === 'cancelled') continue
        if (outcome.failureCode || outcome.text === undefined) {
          this.fail(
            current,
            outcome.failureCode ?? 'ASR_UNAVAILABLE',
            outcome.message ?? 'Não foi possível transcrever esta gravação.'
          )
          continue
        }
        const text = outcome.text.trim().slice(0, 16_000)
        if (!text) {
          this.fail(current, 'ASR_NO_SPEECH', 'Não identificamos fala nesta gravação.')
          continue
        }
        this.repo.transaction(() =>
          this.repo.saveJob({
            ...this.repo.job(next.id),
            state: 'succeeded',
            transcript: text,
            transcriptRevision: current.transcriptRevision + 1,
            ...(outcome.language ? { language: outcome.language } : {}),
            ...(outcome.durationMs !== undefined ? { durationMs: outcome.durationMs } : {}),
            finishedAt: now(),
            revision: current.revision + 1,
            updatedAt: now(),
          })
        )
      }
    } finally {
      this.draining = false
    }
  }
  private fail(job: VoiceJob, failureCode: VoiceJob['failureCode'], message: string) {
    this.repo.transaction(() => {
      const current = this.repo.job(job.id)
      if (current.state === 'succeeded' || current.state === 'cancelled') return
      this.repo.saveJob({
        ...current,
        state: 'failed',
        failureCode,
        error: { code: failureCode ?? 'ASR_UNAVAILABLE', message },
        finishedAt: now(),
        revision: current.revision + 1,
        updatedAt: now(),
      })
    })
  }
  private cancelJob(jobId: string): VoiceJob {
    const job = this.repo.job(jobId)
    if (job.state === 'succeeded' || job.state === 'failed') return job
    this.repo.transaction(() =>
      this.repo.saveJob({
        ...this.repo.job(jobId),
        state: 'cancelled',
        failureCode: 'ASR_CANCELLED',
        finishedAt: now(),
        revision: job.revision + 1,
        updatedAt: now(),
      })
    )
    this.worker.cancel(jobId)
    void this.drain()
    return this.repo.job(jobId)
  }

  // --------------------------------------------------------------------------------- send

  /**
   * The one place a recording becomes work. The recipient comes from the clip, not from the
   * request, so a send cannot be redirected; the message, the turn (or run) and the audio link
   * commit together, so a lost reply is looked up instead of being sent twice.
   */
  private send(p: { clipId: string; transcriptRevision: number; editedText: string; clientMessageId: string }) {
    const clip = this.repo.clip(p.clipId)
    if (clip.state !== 'stored') throw new HostError('VOICE_CLIP_EXPIRED', 'Esta gravação não está mais disponível')
    const existing = this.repo.linkByClip(clip.id)
    if (existing) return this.receipt(clip, existing)
    const job = this.repo.latestJob(clip.id)
    if (job?.state !== 'succeeded' || !job.transcript)
      throw new HostError('VOICE_TRANSCRIPT_REQUIRED', 'Confira a transcrição antes de enviar')
    if (job.transcriptRevision !== p.transcriptRevision)
      throw new HostError('VOICE_TRANSCRIPT_STALE', 'A transcrição mudou; confira o texto antes de enviar')
    const text = p.editedText.trim()
    if (!text) throw new HostError('VOICE_TRANSCRIPT_REQUIRED', 'Não é possível enviar uma mensagem vazia')

    const meta: VoiceMessageMeta = {
      messageId: '',
      clipId: clip.id,
      target: clip.target,
      durationMs: clip.durationMs,
      transcript: job.transcript,
      edited: text !== job.transcript,
      audioAvailable: true,
      expiresAt: new Date(Date.now() + VOICE_LIMITS.clipTtlDays * 24 * 60 * 60_000).toISOString(),
      createdAt: now(),
    }
    if (clip.target.kind === 'bot') {
      let link: VoiceMessageMeta | undefined
      const receipt = this.options.turns.enqueueScopedTurn({
        botId: clip.target.id,
        conversationId: this.options.bots.bot(clip.target.id).conversationId ?? '',
        origin: 'user',
        clientMessageId: p.clientMessageId,
        content: text,
        attachments: [],
        onAdmitted: (_turn, message) => {
          link = { ...meta, messageId: message.id }
          this.repo.saveLink(link)
          // The recording is kept for playback, not as a workspace file and not as an attachment.
          this.repo.saveClip({
            ...this.repo.clip(clip.id),
            messageId: message.id,
            expiresAt: link.expiresAt,
            revision: clip.revision + 1,
            updatedAt: now(),
          })
        },
      })
      this.options.coordinator.events.record(clip.target.id, 'turn.status', 'Mensagem de voz recebida', {
        turnId: receipt.turn.id,
        conversationId: receipt.turn.conversationId,
      })
      this.options.coordinator.kick(clip.target.id)
      return { clip: this.repo.clip(clip.id), bot: receipt, meta: link ?? meta }
    }
    let link: VoiceMessageMeta | undefined
    const receipt = this.options.teamService().enqueueRun({
      teamId: clip.target.id,
      clientMessageId: p.clientMessageId,
      content: text,
      artifactIds: [],
      origin: { kind: 'human' },
      onAdmitted: ({ message }) => {
        link = { ...meta, messageId: message.id }
        this.repo.saveLink(link)
        this.repo.saveClip({
          ...this.repo.clip(clip.id),
          messageId: message.id,
          expiresAt: link.expiresAt,
          revision: clip.revision + 1,
          updatedAt: now(),
        })
      },
    })
    return { clip: this.repo.clip(clip.id), team: receipt, meta: link ?? meta }
  }
  private receipt(clip: VoiceClip, meta: VoiceMessageMeta) {
    if (clip.target.kind === 'bot') {
      const message = this.options.bots.message(meta.messageId)
      return { clip, bot: { message, turn: this.options.bots.turn(message.turnId!) }, meta }
    }
    const message = this.options.teams.messageById(meta.messageId)
    return { clip, team: { message, run: this.options.teams.run(message.runId!) }, meta }
  }

  /** Removing the audio never removes the message; the text stays, marked as audio-less. */
  private async removeClip(p: { clipId: string; idempotencyKey: string }): Promise<VoiceClip> {
    const clip = this.repo.clip(p.clipId)
    if (clip.state === 'removed') return clip
    const active = this.repo.latestJob(clip.id)
    if (active && (active.state === 'queued' || active.state === 'running')) this.cancelJob(active.id)
    await this.storage.remove(clip.id)
    const removed: VoiceClip = { ...clip, state: 'removed', bytes: 0, revision: clip.revision + 1, updatedAt: now() }
    this.repo.transaction(() => {
      this.repo.saveClip(removed)
      const link = this.repo.linkByClip(clip.id)
      if (link) this.repo.saveLink({ ...link, audioAvailable: false })
      const operation: VoiceOperation = {
        id: randomUUID(),
        kind: 'voice.clip.remove',
        clipId: clip.id,
        status: 'succeeded',
        createdAt: now(),
        updatedAt: now(),
      }
      if (!this.repo.operationByKey(p.idempotencyKey))
        this.repo.insertOperation(operation, p.idempotencyKey, fingerprint(p), p)
    })
    return removed
  }

  /** TTL and quota housekeeping: only files this Host created are ever touched. */
  async sweep(nowMs = Date.now()) {
    for (const clip of this.repo.expiredClips(new Date(nowMs).toISOString())) {
      await this.storage.remove(clip.id).catch(() => {})
      this.repo.transaction(() => {
        this.repo.saveClip({
          ...this.repo.clip(clip.id),
          state: 'expired',
          bytes: 0,
          revision: clip.revision + 1,
          updatedAt: now(),
        })
        const link = this.repo.linkByClip(clip.id)
        if (link) this.repo.saveLink({ ...link, audioAvailable: false })
      })
    }
  }

  async handle<M extends VoiceMethod>(request: Extract<VoiceRequest, { method: M }>): Promise<VoiceResult<M>> {
    const result = await this.dispatch(request as VoiceRequest)
    return voiceResultSchemas[request.method].parse(result) as VoiceResult<M>
  }
  private async dispatch(request: VoiceRequest): Promise<unknown> {
    const p = request.params as any
    switch (request.method) {
      case 'voice.status':
        return this.status()
      case 'voice.upload.begin':
        return this.beginUpload(p)
      case 'voice.upload.status':
        return this.repo.transfer(p.transferId)
      case 'voice.upload.chunk':
        return this.chunk(p)
      case 'voice.upload.finish':
        return this.finishUpload(p.transferId)
      case 'voice.transcribe':
        return this.transcribe(p)
      case 'voice.job.inspect':
        return this.repo.job(p.jobId)
      case 'voice.job.cancel':
        return this.cancelJob(p.jobId)
      case 'voice.clip.inspect':
        return this.repo.clip(p.clipId)
      case 'voice.clip.read': {
        const clip = this.repo.clip(p.clipId)
        if (clip.state !== 'stored') throw new HostError('VOICE_CLIP_EXPIRED', 'Esta gravação não está mais disponível')
        const { bytes, size } = await this.storage.read(clip.id, p.offset, p.length)
        return {
          clipId: clip.id,
          offset: p.offset,
          dataBase64: bytes.toString('base64'),
          done: p.offset + bytes.length >= size,
          size,
        }
      }
      case 'voice.clip.remove':
        return this.removeClip(p)
      case 'voice.send':
        return this.send(p)
      case 'voice.forMessages':
        return this.repo.links(p.target, p.messageIds)
      case 'voice.operation.lookup':
        return this.repo.operationByKey(p.idempotencyKey)?.operation ?? null
    }
  }
}
