import type { DatabaseSync } from 'node:sqlite'
import {
  voiceClipSchema,
  voiceJobSchema,
  voiceMessageMetaSchema,
  voiceOperationSchema,
  voiceTransferSchema,
  type TargetRef,
  type VoiceClip,
  type VoiceJob,
  type VoiceMessageMeta,
  type VoiceOperation,
  type VoiceTransfer,
} from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import type { HostStore } from '../persistence/store.js'

export const now = () => new Date().toISOString()
const parseRow = <T>(schema: { parse(value: unknown): T }, row: unknown): T => schema.parse(JSON.parse((row as { body: string }).body))

/**
 * Durable state of the voice domain. No audio ever lives here: a clip row describes a file
 * under the Host state directory by size and digest, and a transcript row holds text the
 * person is going to review. The link between a message and its recording is a sidecar, so
 * deleting the audio can never damage the conversation.
 */
export class VoiceRepository {
  readonly db: DatabaseSync
  constructor(readonly store: HostStore) {
    this.db = store.db
  }
  transaction<T>(fn: () => T): T {
    return this.store.transaction(fn)
  }

  clip(id: string): VoiceClip {
    const row = this.db.prepare('SELECT body FROM voice_clips WHERE id=?').get(id)
    if (!row) throw new HostError('VOICE_CLIP_NOT_FOUND', 'Esta gravação não existe mais')
    return parseRow(voiceClipSchema, row)
  }
  saveClip(clip: VoiceClip) {
    voiceClipSchema.parse(clip)
    this.db
      .prepare(
        'INSERT INTO voice_clips(id,target_kind,target_id,state,bytes,digest,expires_at,body) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,bytes=excluded.bytes,digest=excluded.digest,expires_at=excluded.expires_at,body=excluded.body'
      )
      .run(clip.id, clip.target.kind, clip.target.id, clip.state, clip.bytes, clip.digest, clip.expiresAt, JSON.stringify(clip))
  }
  /** Bytes already committed to stored recordings on this Host, staging included. */
  usedBytes(): number {
    return Number((this.db.prepare("SELECT COALESCE(SUM(bytes),0) AS total FROM voice_clips WHERE state IN ('uploading','stored')").get() as { total: number }).total)
  }
  expiredClips(nowUtc: string): VoiceClip[] {
    return this.db
      .prepare("SELECT body FROM voice_clips WHERE state IN ('uploading','stored') AND expires_at<=? ORDER BY rowid")
      .all(nowUtc)
      .map((row) => parseRow(voiceClipSchema, row))
  }

  transfer(id: string): VoiceTransfer {
    const row = this.db.prepare('SELECT body FROM voice_uploads WHERE id=?').get(id)
    if (!row) throw new HostError('VOICE_CLIP_NOT_FOUND', 'Esta transferência não existe mais')
    return parseRow(voiceTransferSchema, row)
  }
  /** A repeated "begin" with the same client identity returns the same transfer, never a second clip. */
  transferByClientClip(target: TargetRef, clientClipId: string): VoiceTransfer | undefined {
    const row = this.db.prepare('SELECT body FROM voice_uploads WHERE target_kind=? AND target_id=? AND client_clip_id=?').get(target.kind, target.id, clientClipId)
    return row ? parseRow(voiceTransferSchema, row) : undefined
  }
  saveTransfer(transfer: VoiceTransfer, clientClipId: string) {
    voiceTransferSchema.parse(transfer)
    this.db
      .prepare(
        'INSERT INTO voice_uploads(id,clip_id,client_clip_id,target_kind,target_id,digest,body) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body'
      )
      .run(transfer.transferId, transfer.clipId, clientClipId, transfer.target.kind, transfer.target.id, transfer.digest, JSON.stringify(transfer))
  }
  deleteTransfer(id: string) {
    this.db.prepare('DELETE FROM voice_uploads WHERE id=?').run(id)
  }

  job(id: string): VoiceJob {
    const row = this.db.prepare('SELECT body FROM voice_jobs WHERE id=?').get(id)
    if (!row) throw new HostError('VOICE_CLIP_NOT_FOUND', 'Esta transcrição não existe mais')
    return parseRow(voiceJobSchema, row)
  }
  /** The most recent transcription of a clip, whatever state it is in. */
  latestJob(clipId: string): VoiceJob | undefined {
    const row = this.db.prepare('SELECT body FROM voice_jobs WHERE clip_id=? ORDER BY rowid DESC LIMIT 1').get(clipId)
    return row ? parseRow(voiceJobSchema, row) : undefined
  }
  queued(): VoiceJob[] {
    return this.db
      .prepare("SELECT body FROM voice_jobs WHERE state='queued' ORDER BY rowid")
      .all()
      .map((row) => parseRow(voiceJobSchema, row))
  }
  running(): VoiceJob | undefined {
    const row = this.db.prepare("SELECT body FROM voice_jobs WHERE state='running' ORDER BY rowid LIMIT 1").get()
    return row ? parseRow(voiceJobSchema, row) : undefined
  }
  saveJob(job: VoiceJob) {
    voiceJobSchema.parse(job)
    this.db
      .prepare('INSERT INTO voice_jobs(id,clip_id,state,generation,body) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,body=excluded.body')
      .run(job.id, job.clipId, job.state, job.generation, JSON.stringify(job))
  }

  link(messageId: string): VoiceMessageMeta | undefined {
    const row = this.db.prepare('SELECT body FROM voice_message_links WHERE message_id=?').get(messageId)
    return row ? parseRow(voiceMessageMetaSchema, row) : undefined
  }
  linkByClip(clipId: string): VoiceMessageMeta | undefined {
    const row = this.db.prepare('SELECT body FROM voice_message_links WHERE clip_id=?').get(clipId)
    return row ? parseRow(voiceMessageMetaSchema, row) : undefined
  }
  links(target: TargetRef, messageIds: readonly string[]): VoiceMessageMeta[] {
    if (!messageIds.length) return []
    return this.db
      .prepare(`SELECT body FROM voice_message_links WHERE target_kind=? AND target_id=? AND message_id IN (${messageIds.map(() => '?').join(',')})`)
      .all(target.kind, target.id, ...messageIds)
      .map((row) => parseRow(voiceMessageMetaSchema, row))
  }
  saveLink(meta: VoiceMessageMeta) {
    voiceMessageMetaSchema.parse(meta)
    try {
      this.db
        .prepare('INSERT INTO voice_message_links(message_id,clip_id,target_kind,target_id,body) VALUES(?,?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET body=excluded.body')
        .run(meta.messageId, meta.clipId, meta.target.kind, meta.target.id, JSON.stringify(meta))
    } catch (error) {
      if (/UNIQUE/.test(String(error))) throw new HostError('IDEMPOTENCY_CONFLICT', 'Esta gravação já está ligada a outra mensagem')
      throw error
    }
  }

  operation(id: string): VoiceOperation {
    const row = this.db.prepare('SELECT body FROM voice_operations WHERE id=?').get(id)
    if (!row) throw new HostError('NOT_FOUND', 'Operação de voz não encontrada')
    return parseRow(voiceOperationSchema, row)
  }
  operationByKey(key: string): { fingerprint: string; operation: VoiceOperation } | undefined {
    const row = this.db.prepare('SELECT fingerprint,body FROM voice_operations WHERE key=?').get(key) as { fingerprint: string; body: string } | undefined
    return row ? { fingerprint: row.fingerprint, operation: voiceOperationSchema.parse(JSON.parse(row.body)) } : undefined
  }
  insertOperation(operation: VoiceOperation, key: string, fingerprint: string, request: unknown) {
    voiceOperationSchema.parse(operation)
    this.db
      .prepare('INSERT INTO voice_operations(id,key,fingerprint,clip_id,message_id,request,body) VALUES(?,?,?,?,?,?,?)')
      .run(operation.id, key, fingerprint, operation.clipId ?? null, operation.messageId ?? null, JSON.stringify(request), JSON.stringify(operation))
  }
}
