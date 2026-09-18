import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync } from 'node:fs'
import { open, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { VOICE_LIMITS } from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import { parseCanonicalWav, type CanonicalWav } from './wav.js'

const GENERATED_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/

/**
 * Where recordings physically live. Every path here is built from an identifier the Host
 * generated itself and checked against that shape before it touches the filesystem: a clip
 * identifier is never a filename a caller chose, so there is nothing to escape with.
 *
 * Staging is separate from the final copy. A recording only becomes readable after its whole
 * content has been verified against the declared size and digest, so a transfer that dies
 * halfway leaves a discarded part file rather than a half-recording somebody can play.
 */
export class VoiceStorage {
  private readonly clips: string
  private readonly staging: string
  constructor(stateDirectory: string) {
    const root = join(stateDirectory, 'voice')
    this.clips = join(root, 'clips')
    this.staging = join(root, 'staging')
    for (const directory of [root, this.clips, this.staging]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const info = lstatSync(directory)
      if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid?.()) throw new Error('Invalid voice storage directory')
      chmodSync(directory, 0o700)
    }
  }
  private safe(id: string) {
    if (!GENERATED_ID.test(id)) throw new HostError('VOICE_CLIP_NOT_FOUND', 'Identificador de gravação inválido')
    return id
  }
  clipPath(clipId: string) {
    return join(this.clips, `${this.safe(clipId)}.wav`)
  }
  private stagingPath(transferId: string) {
    return join(this.staging, `${this.safe(transferId)}.part`)
  }

  /** Writes one chunk at an exact offset; a repeated chunk with the same bytes is harmless. */
  async writeChunk(transferId: string, offset: number, bytes: Buffer) {
    const handle = await open(this.stagingPath(transferId), 'a+', 0o600)
    try {
      const info = await handle.stat()
      if (info.size < offset) throw new HostError('TRANSFER_OFFSET', `Deslocamento inesperado; retome a partir de ${info.size}`)
      await handle.write(bytes, 0, bytes.length, offset)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
  async stagedBytes(transferId: string) {
    try {
      return (await stat(this.stagingPath(transferId))).size
    } catch {
      return 0
    }
  }

  /**
   * Promotes a staged upload. The bytes are verified before the file is given a name that
   * anything else can read: size, digest and the canonical WAV layout all have to agree.
   */
  async finalize(transferId: string, clipId: string, expected: { size: number; digest: string }): Promise<CanonicalWav> {
    const source = this.stagingPath(transferId)
    const info = await stat(source).catch(() => undefined)
    if (!info || info.size !== expected.size) {
      await this.abort(transferId)
      throw new HostError('VOICE_FORMAT_INVALID', 'A gravação enviada está incompleta.')
    }
    const buffer = await readFile(source)
    const digest = createHash('sha256').update(buffer).digest('hex')
    if (digest !== expected.digest) {
      await this.abort(transferId)
      throw new HostError('VOICE_FORMAT_INVALID', 'A gravação enviada não confere com o que foi declarado.')
    }
    let parsed: CanonicalWav
    try {
      parsed = parseCanonicalWav(buffer)
    } catch (error) {
      // A file that is not the canonical layout will never become a clip: leaving it staged
      // would only keep somebody's audio on disk until a sweep happens to notice.
      await this.abort(transferId)
      throw error
    }
    await rename(source, this.clipPath(clipId))
    chmodSync(this.clipPath(clipId), 0o600)
    return parsed
  }

  /** Reads one authorised chunk by identity; there is no path, handle or URL to hand out. */
  async read(clipId: string, offset: number, length: number) {
    const handle = await open(this.clipPath(clipId), 'r')
    try {
      const size = (await handle.stat()).size
      const bytes = Buffer.alloc(Math.max(0, Math.min(length, size - offset)))
      if (bytes.length) await handle.read(bytes, 0, bytes.length, offset)
      return { bytes, size }
    } finally {
      await handle.close()
    }
  }
  async remove(clipId: string) {
    await rm(this.clipPath(clipId), { force: true })
  }
  async abort(transferId: string) {
    await rm(this.stagingPath(transferId), { force: true })
  }
  /** Reads a whole clip for inference. Bounded by the format limit, never by a caller. */
  async load(clipId: string) {
    const buffer = await readFile(this.clipPath(clipId))
    if (buffer.length > VOICE_LIMITS.maxWavBytes) throw new HostError('VOICE_FORMAT_INVALID', 'A gravação é maior que o limite permitido.')
    return buffer
  }
}
