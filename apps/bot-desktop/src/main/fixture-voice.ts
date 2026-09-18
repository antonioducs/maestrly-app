import { randomUUID } from 'node:crypto'
import {
  VOICE_AUDIO,
  VOICE_LIMITS,
  type TargetRef,
  type VoiceClip,
  type VoiceJob,
  type VoiceMessageMeta,
  type VoiceOperation,
  type VoiceTransfer,
} from '@maestrly/host-protocol'
import { HostRequestError } from './host-client'

const now = () => new Date().toISOString()
const fail = (code: string, message: string) => new HostRequestError(message, code)

/**
 * Development-only in-memory voice domain for interface work. It keeps the rules the interface
 * depends on — audio arrives in chunks, a transcription is a separate step, sending needs the
 * current transcript, removing the audio keeps the message — and produces a fixed sentence
 * rather than running a model.
 *
 * It is explicitly NOT evidence that transcription works: the packaged runtime has no fixtures,
 * and the real gate is a recording transcribed by the Host's own worker.
 */
export class FixtureVoice {
  clips = new Map<string, VoiceClip>()
  jobs = new Map<string, VoiceJob>()
  links = new Map<string, VoiceMessageMeta>()
  private transfers = new Map<string, VoiceTransfer & { received: number }>()
  private operations = new Map<string, VoiceOperation>()
  constructor(
    private readonly send: (
      target: TargetRef,
      text: string,
      clientMessageId: string
    ) => Promise<{ messageId: string; result: unknown }>,
    readonly transcript = 'toda segunda às nove, prepare esse resumo'
  ) {}

  async request(method: string, p: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'voice.status':
        return {
          available: true,
          state: 'ready' as const,
          modelId: 'fixture/whisper-base',
          queueDepth: 0,
          quotaBytes: VOICE_LIMITS.quotaBytes,
          usedBytes: [...this.clips.values()].reduce((sum, clip) => sum + clip.bytes, 0),
          limits: {
            maxDurationMs: VOICE_LIMITS.maxDurationMs,
            maxWavBytes: VOICE_LIMITS.maxWavBytes,
            sampleRate: VOICE_AUDIO.sampleRate,
            channels: VOICE_AUDIO.channels,
          },
        }
      case 'voice.upload.begin': {
        const clipId = randomUUID()
        const transfer: VoiceTransfer & { received: number } = {
          transferId: randomUUID(),
          clipId,
          target: p.target as TargetRef,
          size: Number(p.sizeBytes),
          offset: 0,
          chunkBytes: VOICE_LIMITS.chunkBytes,
          digest: String(p.sha256),
          done: false,
          expiresAt: new Date(Date.now() + VOICE_LIMITS.transferTtlMs).toISOString(),
          received: 0,
        }
        this.transfers.set(transfer.transferId, transfer)
        this.clips.set(clipId, {
          id: clipId,
          target: transfer.target,
          state: 'uploading',
          bytes: transfer.size,
          durationMs: Number(p.durationMs),
          digest: transfer.digest,
          sampleRate: VOICE_AUDIO.sampleRate,
          channels: VOICE_AUDIO.channels,
          expiresAt: new Date(Date.now() + VOICE_LIMITS.draftTtlMs).toISOString(),
          createdAt: now(),
          updatedAt: now(),
          revision: 0,
        })
        const { received: _received, ...state } = transfer
        return state
      }
      case 'voice.upload.chunk': {
        const transfer = this.transfers.get(String(p.transferId))
        if (!transfer) throw fail('VOICE_CLIP_NOT_FOUND', 'Esta transferência não existe mais')
        const bytes = Buffer.from(String(p.dataBase64), 'base64').length
        transfer.received = Math.max(transfer.received, Number(p.offset) + bytes)
        transfer.offset = transfer.received
        transfer.done = transfer.received >= transfer.size
        const { received: _received, ...state } = transfer
        return state
      }
      case 'voice.upload.finish': {
        const transfer = this.transfers.get(String(p.transferId))
        if (!transfer) throw fail('VOICE_CLIP_NOT_FOUND', 'Esta transferência não existe mais')
        if (!transfer.done) throw fail('TRANSFER_INCOMPLETE', 'A transferência ainda não terminou')
        const clip = { ...this.clips.get(transfer.clipId)!, state: 'stored' as const, revision: 1, updatedAt: now() }
        this.clips.set(clip.id, clip)
        this.transfers.delete(transfer.transferId)
        return clip
      }
      case 'voice.transcribe': {
        const clip = this.clips.get(String(p.clipId))
        if (!clip) throw fail('VOICE_CLIP_NOT_FOUND', 'Esta gravação não existe mais')
        const job: VoiceJob = {
          id: randomUUID(),
          clipId: clip.id,
          target: clip.target,
          state: 'succeeded',
          generation: 1,
          queuePosition: 0,
          transcript: this.transcript,
          transcriptRevision: 1,
          language: 'pt',
          durationMs: clip.durationMs,
          startedAt: now(),
          finishedAt: now(),
          createdAt: now(),
          updatedAt: now(),
          revision: 1,
        }
        this.jobs.set(job.id, job)
        return job
      }
      case 'voice.job.inspect': {
        const job = this.jobs.get(String(p.jobId))
        if (!job) throw fail('VOICE_CLIP_NOT_FOUND', 'Esta transcrição não existe mais')
        return job
      }
      case 'voice.job.cancel': {
        const job = this.jobs.get(String(p.jobId))
        if (!job) throw fail('VOICE_CLIP_NOT_FOUND', 'Esta transcrição não existe mais')
        const cancelled: VoiceJob = {
          ...job,
          state: 'cancelled',
          failureCode: 'ASR_CANCELLED',
          revision: job.revision + 1,
          updatedAt: now(),
        }
        this.jobs.set(job.id, cancelled)
        return cancelled
      }
      case 'voice.clip.inspect': {
        const clip = this.clips.get(String(p.clipId))
        if (!clip) throw fail('VOICE_CLIP_NOT_FOUND', 'Esta gravação não existe mais')
        return clip
      }
      case 'voice.clip.read': {
        const clip = this.clips.get(String(p.clipId))
        if (clip?.state !== 'stored') throw fail('VOICE_CLIP_EXPIRED', 'Esta gravação não está mais disponível')
        // A silent canonical WAV: enough for the player, and no recording of anybody.
        const samples = Buffer.alloc(Math.max(0, clip.bytes - 44))
        return {
          clipId: clip.id,
          offset: Number(p.offset),
          dataBase64: samples.subarray(0, VOICE_LIMITS.chunkBytes).toString('base64'),
          done: true,
          size: clip.bytes,
        }
      }
      case 'voice.clip.remove': {
        const clip = this.clips.get(String(p.clipId))
        if (!clip) throw fail('VOICE_CLIP_NOT_FOUND', 'Esta gravação não existe mais')
        const removed: VoiceClip = {
          ...clip,
          state: 'removed',
          bytes: 0,
          revision: clip.revision + 1,
          updatedAt: now(),
        }
        this.clips.set(clip.id, removed)
        for (const [messageId, meta] of this.links)
          if (meta.clipId === clip.id) this.links.set(messageId, { ...meta, audioAvailable: false })
        return removed
      }
      case 'voice.send': {
        const clip = this.clips.get(String(p.clipId))
        if (clip?.state !== 'stored') throw fail('VOICE_CLIP_EXPIRED', 'Esta gravação não está mais disponível')
        const job = [...this.jobs.values()].reverse().find((candidate) => candidate.clipId === clip.id)
        if (!job?.transcript) throw fail('VOICE_TRANSCRIPT_REQUIRED', 'Confira a transcrição antes de enviar')
        if (job.transcriptRevision !== p.transcriptRevision)
          throw fail('VOICE_TRANSCRIPT_STALE', 'A transcrição mudou; confira o texto antes de enviar')
        const text = String(p.editedText).trim()
        if (!text) throw fail('VOICE_TRANSCRIPT_REQUIRED', 'Não é possível enviar uma mensagem vazia')
        const { messageId, result } = await this.send(clip.target, text, String(p.clientMessageId))
        const meta: VoiceMessageMeta = {
          messageId,
          clipId: clip.id,
          target: clip.target,
          durationMs: clip.durationMs,
          transcript: job.transcript,
          edited: text !== job.transcript,
          audioAvailable: true,
          expiresAt: new Date(Date.now() + VOICE_LIMITS.clipTtlDays * 24 * 60 * 60_000).toISOString(),
          createdAt: now(),
        }
        this.links.set(messageId, meta)
        this.clips.set(clip.id, { ...clip, messageId, revision: clip.revision + 1, updatedAt: now() })
        return { clip: this.clips.get(clip.id)!, meta, ...(result as Record<string, unknown>) }
      }
      case 'voice.forMessages': {
        const target = p.target as TargetRef
        const ids = (p.messageIds as string[]) ?? []
        return ids
          .map((id) => this.links.get(id))
          .filter(
            (meta): meta is VoiceMessageMeta =>
              !!meta && meta.target.kind === target.kind && meta.target.id === target.id
          )
      }
      case 'voice.operation.lookup':
        return this.operations.get(String(p.idempotencyKey)) ?? null
      default:
        throw fail('INVALID_REQUEST', 'Fixture: unknown voice method')
    }
  }
}
