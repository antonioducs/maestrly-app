import { createHash, randomUUID } from 'node:crypto'
import {
  VOICE_LIMITS,
  voiceMethods,
  voiceRequestSchema,
  voiceResultSchemas,
  type TargetRef,
  type VoiceClip,
  type VoiceMethod,
  type VoiceResult,
} from '@maestrly/host-protocol'
import { HostRequestError } from './host-client'
import type { BotJournal } from './bot-journal'
import type { RequestFn } from './bot-client'

export type VoiceCall = { method: VoiceMethod; params: Record<string, unknown> }

/** A voice call is validated by the shared strict schema; a method outside the namespace is refused. */
export function validateVoiceCall(value: unknown): VoiceCall {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !['method', 'params'].includes(key)))
    throw new Error('Invalid voice request')
  const call = value as VoiceCall
  if (!voiceMethods.includes(call.method)) throw new Error('Invalid voice request')
  const parsed = voiceRequestSchema.parse({ version: 1, id: 'ipc', ...call })
  return { method: parsed.method as VoiceMethod, params: parsed.params as Record<string, unknown> }
}

export interface VoiceUploadInput {
  target: TargetRef
  clientClipId: string
  /** Canonical WAV produced by the renderer, base64 for the IPC hop only. */
  dataBase64: string
  durationMs: number
}

/**
 * Voice over the active Host transport.
 *
 * Uploading is done here, in the main process, rather than in the renderer: the chunk loop is
 * a long sequence of small requests, and it must not be able to sit in front of the frames a
 * person is waiting on. The renderer hands over one recording and gets back one clip.
 *
 * The audio is never written to the journal. A send is journaled by its client message id, the
 * same way a typed message is, so a lost reply is looked up instead of producing a second
 * message — and the recording itself stays out of any file the app keeps.
 */
export class VoiceClient {
  private hostId = ''
  constructor(
    private readonly journal: BotJournal,
    private readonly request: RequestFn
  ) {}
  connected(hostId: string) {
    this.hostId = hostId
  }

  async call<M extends VoiceMethod>(input: unknown): Promise<VoiceResult<M>> {
    const call = validateVoiceCall(input)
    if (!this.hostId) throw new Error('Conecte-se a um computador antes de usar mensagens de voz')
    if (call.method === 'voice.send') return this.send(call) as Promise<VoiceResult<M>>
    const result = await this.request(call.method, call.params)
    return voiceResultSchemas[call.method].parse(result) as VoiceResult<M>
  }

  /**
   * Sends one recording to the Host: reserve, stream, verify. The digest is computed here and
   * checked again by the Host against the bytes it actually received, so a truncated or
   * altered upload is refused rather than transcribed.
   */
  async upload(value: unknown): Promise<VoiceClip> {
    if (!this.hostId) throw new Error('Conecte-se a um computador antes de usar mensagens de voz')
    const input = value as Partial<VoiceUploadInput>
    if (
      !input ||
      typeof input !== 'object' ||
      Object.keys(input).some((key) => !['target', 'clientClipId', 'dataBase64', 'durationMs'].includes(key)) ||
      typeof input.dataBase64 !== 'string' ||
      typeof input.clientClipId !== 'string' ||
      typeof input.durationMs !== 'number'
    )
      throw new Error('Invalid voice upload')
    const audio = Buffer.from(input.dataBase64, 'base64')
    if (!audio.length || audio.length > VOICE_LIMITS.maxWavBytes) throw new Error('A gravação excede o limite permitido')
    const target = input.target as TargetRef
    if (!target || (target.kind !== 'bot' && target.kind !== 'team') || typeof target.id !== 'string') throw new Error('Invalid voice upload')

    const transfer = (await this.call({
      method: 'voice.upload.begin',
      params: {
        target,
        clientClipId: input.clientClipId,
        sizeBytes: audio.length,
        durationMs: Math.round(input.durationMs),
        sha256: createHash('sha256').update(audio).digest('hex'),
      },
    })) as VoiceResult<'voice.upload.begin'>
    let offset = transfer.offset
    while (offset < audio.length) {
      const chunk = audio.subarray(offset, Math.min(offset + VOICE_LIMITS.chunkBytes, audio.length))
      const state = (await this.call({
        method: 'voice.upload.chunk',
        params: { transferId: transfer.transferId, offset, dataBase64: chunk.toString('base64') },
      })) as VoiceResult<'voice.upload.chunk'>
      // Trust the Host's own cursor: a retried chunk must not advance ours twice.
      offset = state.offset
    }
    return (await this.call({ method: 'voice.upload.finish', params: { transferId: transfer.transferId } })) as VoiceClip
  }

  /** Reads a stored recording back for playback, by identity, one bounded chunk at a time. */
  async read(value: unknown): Promise<{ clipId: string; dataBase64: string }> {
    const input = value as { clipId?: unknown }
    if (typeof input?.clipId !== 'string') throw new Error('Invalid voice clip')
    const parts: Buffer[] = []
    let offset = 0
    for (;;) {
      const page = (await this.call({ method: 'voice.clip.read', params: { clipId: input.clipId, offset, length: VOICE_LIMITS.chunkBytes } })) as VoiceResult<'voice.clip.read'>
      parts.push(Buffer.from(page.dataBase64, 'base64'))
      offset = page.offset + Buffer.from(page.dataBase64, 'base64').length
      if (page.done || !page.dataBase64.length) break
      if (offset > VOICE_LIMITS.maxWavBytes) throw new Error('A gravação excede o limite permitido')
    }
    return { clipId: input.clipId, dataBase64: Buffer.concat(parts).toString('base64') }
  }

  private async send(call: VoiceCall) {
    const entry = await this.journal.begin(this.hostId, 'voice.send', call.params)
    try {
      const result = await this.request(call.method, call.params)
      const parsed = voiceResultSchemas['voice.send'].parse(result)
      const id = parsed.bot?.turn.id ?? parsed.team?.run.id ?? 'applied'
      if (entry) await this.journal.receipt(entry, { id, kind: 'turn' })
      return parsed
    } catch (error) {
      // A refusal the Host stated is definitive: keep the draft, drop the key, let the person decide.
      if (entry && error instanceof HostRequestError) await this.journal.forget(entry)
      throw error
    }
  }

  /** After reconnecting, ask whether a send whose reply was lost actually became a message. */
  async recover(): Promise<{ recovered: number; unresolved: number }> {
    if (!this.hostId) return { recovered: 0, unresolved: 0 }
    let recovered = 0
    for (const entry of await this.unresolved()) {
      try {
        const found = await this.request('voice.operation.lookup', { idempotencyKey: entry.reference.clientMessageId })
        if (found) {
          await this.journal.receipt(entry, { id: (found as { id: string }).id, kind: 'turn' })
          recovered++
        } else await this.journal.forget(entry)
      } catch {
        /* stays unresolved until the next reconnect */
      }
    }
    return { recovered, unresolved: (await this.unresolved()).length }
  }
  async unresolved() {
    return this.hostId ? (await this.journal.unresolved(this.hostId)).filter((entry) => entry.method === 'voice.send') : []
  }
}
export const newClipId = () => randomUUID()
