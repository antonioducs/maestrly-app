import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { VOICE_AUDIO, VOICE_LIMITS } from '@maestrly/host-protocol'
import { encodeCanonicalWav, parseCanonicalWav, decodePcm, isSilent } from '../src/voice/wav.js'
import { labBot, routineLab, until, type RoutineLab } from './routine-helpers.js'
import { asrBundle, fakeAsr, sha256, silence, speech, upload } from './voice-helpers.js'

const labs: RoutineLab[] = []
afterEach(async () => {
  for (const lab of labs.splice(0)) await lab.close().catch(() => {})
})
async function open(options: { bundle?: boolean } = {}) {
  const asr = fakeAsr()
  const bundleDirectory = options.bundle === false ? undefined : await asrBundle()
  const lab = await routineLab({
    asr: { ...(bundleDirectory ? { bundleDirectory } : {}), factory: asr.factory, idleMs: 50, timeoutMs: 2_000 },
  })
  labs.push(lab)
  await lab.service.ready()
  return { lab, asr }
}

describe('the only audio format this Host accepts', () => {
  it('accepts exactly one canonical layout and reports its real duration', () => {
    const wav = speech(2_000)
    expect(parseCanonicalWav(wav)).toEqual({ dataBytes: VOICE_AUDIO.sampleRate * 2 * 2, durationMs: 2_000 })
    expect(decodePcm(wav).length).toBe(VOICE_AUDIO.sampleRate * 2)
  })

  it('refuses a header that disagrees with the bytes that are actually there', () => {
    const wav = speech(1_000)
    const lying = Buffer.from(wav)
    // A declared data size larger than the file: the classic "five second note" that is an hour.
    lying.writeUInt32LE(9_000_000, 40)
    expect(() => parseCanonicalWav(lying)).toThrow(/não corresponde/)

    const truncated = wav.subarray(0, wav.length - 100)
    expect(() => parseCanonicalWav(truncated)).toThrow(/não corresponde/)

    const stereo = Buffer.from(wav)
    stereo.writeUInt16LE(2, 22)
    expect(() => parseCanonicalWav(stereo)).toThrow(/mono/)

    const resampled = Buffer.from(wav)
    resampled.writeUInt32LE(44_100, 24)
    expect(() => parseCanonicalWav(resampled)).toThrow(/16000 Hz/)

    const compressed = Buffer.from(wav)
    compressed.writeUInt16LE(3, 20)
    expect(() => parseCanonicalWav(compressed)).toThrow(/PCM/)

    // Extra bytes after the audio have nowhere legitimate to be.
    expect(() => parseCanonicalWav(Buffer.concat([wav, Buffer.from('trailing')]))).toThrow()
    // Something that is not audio at all.
    expect(() => parseCanonicalWav(Buffer.from('this is not audio, it is a script'))).toThrow()
    expect(() => parseCanonicalWav(encodeCanonicalWav(Buffer.alloc(0)))).toThrow(/vazia/)
  })

  it('refuses a recording longer than the limit before anything is decoded', () => {
    const tooLong = encodeCanonicalWav(
      Buffer.alloc((VOICE_LIMITS.maxDurationMs / 1000 + 5) * VOICE_AUDIO.sampleRate * 2)
    )
    expect(() => parseCanonicalWav(tooLong)).toThrow()
  })

  it('recognises silence without loading a model', () => {
    expect(isSilent(decodePcm(silence(1_000)))).toBe(true)
    expect(isSilent(decodePcm(speech(1_000)))).toBe(false)
  })
})

describe.skipIf(process.platform === 'win32')('uploading a recording', () => {
  it('stores it only after size, digest and layout all agree', async () => {
    const { lab } = await open()
    const bot = await labBot(lab)
    const wav = speech(1_500)
    const { clip } = await upload(lab, { kind: 'bot', id: bot.id }, wav)
    expect(clip).toMatchObject({ state: 'stored', bytes: wav.length, durationMs: 1_500, digest: sha256(wav) })
    // Uploading audio does not start the bot. Nothing was sent anywhere.
    expect(lab.guest(bot.id).turns.size).toBe(0)
    expect((await lab.call('bot.inspect', { botId: bot.id })).activeTurnId).toBeUndefined()
  })

  it('refuses a digest that does not match the bytes received', async () => {
    const { lab } = await open()
    const bot = await labBot(lab)
    const wav = speech(1_000)
    const transfer = await lab.call('voice.upload.begin', {
      target: { kind: 'bot', id: bot.id },
      clientClipId: randomUUID(),
      sizeBytes: wav.length,
      durationMs: 1_000,
      sha256: 'a'.repeat(64),
    })
    await lab.call('voice.upload.chunk', {
      transferId: transfer.transferId,
      offset: 0,
      dataBase64: wav.subarray(0, VOICE_LIMITS.chunkBytes).toString('base64'),
    })
    for (let offset = VOICE_LIMITS.chunkBytes; offset < wav.length; offset += VOICE_LIMITS.chunkBytes)
      await lab.call('voice.upload.chunk', {
        transferId: transfer.transferId,
        offset,
        dataBase64: wav.subarray(offset, offset + VOICE_LIMITS.chunkBytes).toString('base64'),
      })
    await expect(lab.call('voice.upload.finish', { transferId: transfer.transferId })).rejects.toMatchObject({
      code: 'VOICE_FORMAT_INVALID',
    })
    // The refused bytes are gone, so they no longer occupy the quota or the transfer table.
    expect((await lab.call('voice.status', {})).usedBytes).toBe(0)
    await expect(lab.call('voice.upload.chunk', { transferId: transfer.transferId, offset: 0, dataBase64: '' })).rejects.toMatchObject({
      code: 'VOICE_CLIP_NOT_FOUND',
    })
  })

  it('refuses a recording with extra chunks and stops charging for it at once', async () => {
    // What macOS tools produce by default: a padding chunk between "fmt " and "data". The
    // digest and size agree, only the layout is wrong — the third of the three checks.
    const { lab } = await open()
    const bot = await labBot(lab)
    const canonical = speech(1_000)
    const padding = Buffer.alloc(8 + 16)
    padding.write('FLLR', 0, 'ascii')
    padding.writeUInt32LE(16, 4)
    const wav = Buffer.concat([canonical.subarray(0, 36), padding, canonical.subarray(36)])
    wav.writeUInt32LE(wav.length - 8, 4)
    await expect(upload(lab, { kind: 'bot', id: bot.id }, wav)).rejects.toMatchObject({ code: 'VOICE_FORMAT_INVALID' })
    expect((await lab.call('voice.status', {})).usedBytes).toBe(0)
    // A correct recording right after is accepted and is the only thing counted.
    const { clip } = await upload(lab, { kind: 'bot', id: bot.id }, canonical)
    expect(clip.state).toBe('stored')
    expect((await lab.call('voice.status', {})).usedBytes).toBe(canonical.length)
  })

  it('refuses a declared duration that does not match the declared size', async () => {
    const { lab } = await open()
    const bot = await labBot(lab)
    const wav = speech(1_000)
    await expect(
      lab.call('voice.upload.begin', {
        target: { kind: 'bot', id: bot.id },
        clientClipId: randomUUID(),
        sizeBytes: wav.length,
        durationMs: 240_000,
        sha256: sha256(wav),
      })
    ).rejects.toMatchObject({ code: 'VOICE_FORMAT_INVALID' })
  })

  it('returns the same transfer for a retry and refuses different bytes under the same name', async () => {
    const { lab } = await open()
    const bot = await labBot(lab)
    const wav = speech(1_000)
    const clientClipId = randomUUID()
    const params = {
      target: { kind: 'bot', id: bot.id },
      clientClipId,
      sizeBytes: wav.length,
      durationMs: 1_000,
      sha256: sha256(wav),
    }
    const first = await lab.call('voice.upload.begin', params)
    const again = await lab.call('voice.upload.begin', params)
    expect(again.transferId).toBe(first.transferId)
    const other = speech(1_000, 0.9)
    await expect(lab.call('voice.upload.begin', { ...params, sha256: sha256(other) })).rejects.toMatchObject({
      code: 'VOICE_TRANSFER_CONFLICT',
    })
  })

  it('refuses a chunk that leaves a gap and tolerates one that was already written', async () => {
    const { lab } = await open()
    const bot = await labBot(lab)
    const wav = speech(1_000)
    const transfer = await lab.call('voice.upload.begin', {
      target: { kind: 'bot', id: bot.id },
      clientClipId: randomUUID(),
      sizeBytes: wav.length,
      durationMs: 1_000,
      sha256: sha256(wav),
    })
    await expect(
      lab.call('voice.upload.chunk', {
        transferId: transfer.transferId,
        offset: 4096,
        dataBase64: wav.subarray(4096, 8192).toString('base64'),
      })
    ).rejects.toMatchObject({ code: 'TRANSFER_OFFSET' })
    const chunk = wav.subarray(0, VOICE_LIMITS.chunkBytes).toString('base64')
    const written = await lab.call('voice.upload.chunk', {
      transferId: transfer.transferId,
      offset: 0,
      dataBase64: chunk,
    })
    const repeated = await lab.call('voice.upload.chunk', {
      transferId: transfer.transferId,
      offset: 0,
      dataBase64: chunk,
    })
    expect(repeated.offset).toBe(written.offset)
  })

  it('refuses to accept more audio than this Host reserved for it', async () => {
    const { lab } = await open()
    const bot = await labBot(lab)
    // Pretend the quota is already spent, without writing a gigabyte to a test machine.
    const repo = lab.voice.repo
    const stamp = new Date().toISOString()
    repo.saveClip({
      id: randomUUID(),
      target: { kind: 'bot', id: bot.id },
      state: 'stored',
      bytes: VOICE_LIMITS.quotaBytes,
      durationMs: 1_000,
      digest: 'a'.repeat(64),
      sampleRate: VOICE_AUDIO.sampleRate,
      channels: VOICE_AUDIO.channels,
      expiresAt: stamp,
      createdAt: stamp,
      updatedAt: stamp,
      revision: 0,
    })
    const wav = speech(1_000)
    await expect(
      lab.call('voice.upload.begin', {
        target: { kind: 'bot', id: bot.id },
        clientClipId: randomUUID(),
        sizeBytes: wav.length,
        durationMs: 1_000,
        sha256: sha256(wav),
      })
    ).rejects.toMatchObject({ code: 'VOICE_QUOTA_EXCEEDED' })
  })

  it('reads a stored recording back only by identity, in bounded chunks', async () => {
    const { lab } = await open()
    const bot = await labBot(lab)
    const wav = speech(1_000)
    const { clip } = await upload(lab, { kind: 'bot', id: bot.id }, wav)
    const parts: Buffer[] = []
    for (let offset = 0; offset < clip.bytes; offset += VOICE_LIMITS.chunkBytes) {
      const page = await lab.call('voice.clip.read', { clipId: clip.id, offset, length: VOICE_LIMITS.chunkBytes })
      parts.push(Buffer.from(page.dataBase64, 'base64'))
    }
    expect(sha256(Buffer.concat(parts))).toBe(sha256(wav))
    // There is no path, URL or handle anywhere in the reply.
    const page = await lab.call('voice.clip.read', { clipId: clip.id, offset: 0, length: 1024 })
    expect(Object.keys(page).sort()).toEqual(['clipId', 'dataBase64', 'done', 'offset', 'size'])
    expect(JSON.stringify(page)).not.toContain(lab.dir)
  })
})

describe.skipIf(process.platform === 'win32')('transcribing on this Host', () => {
  it('produces text the person can review, without sending anything to the bot', async () => {
    const { lab } = await open()
    const bot = await labBot(lab)
    const { clip } = await upload(lab, { kind: 'bot', id: bot.id }, speech(1_500))
    const job = await lab.call('voice.transcribe', { clipId: clip.id, idempotencyKey: randomUUID() })
    const done = await until(
      () => lab.call('voice.job.inspect', { jobId: job.id }),
      (value: any) => value.state !== 'queued' && value.state !== 'running'
    )
    expect(done.state).toBe('succeeded')
    expect(done.transcript).toBe('toda segunda às nove, prepare esse resumo')
    expect(done.transcriptRevision).toBe(1)
    // Still nothing was sent: a transcription is not a message.
    expect(lab.guest(bot.id).turns.size).toBe(0)
  })

  it('says there was no speech instead of inventing a sentence', async () => {
    const { lab } = await open()
    const bot = await labBot(lab)
    const { clip } = await upload(lab, { kind: 'bot', id: bot.id }, silence(1_000))
    const job = await lab.call('voice.transcribe', { clipId: clip.id, idempotencyKey: randomUUID() })
    const done = await until(
      () => lab.call('voice.job.inspect', { jobId: job.id }),
      (value: any) => value.state === 'failed' || value.state === 'succeeded'
    )
    expect(done).toMatchObject({ state: 'failed', failureCode: 'ASR_NO_SPEECH' })
    expect(done.transcript).toBeUndefined()
  })

  it('refuses transcription when this Host has no verified bundle at all', async () => {
    const { lab } = await open({ bundle: false })
    const bot = await labBot(lab)
    const status = await lab.call('voice.status')
    expect(status).toMatchObject({ available: false, state: 'missing' })
    const { clip } = await upload(lab, { kind: 'bot', id: bot.id }, speech(1_000))
    const job = await lab.call('voice.transcribe', { clipId: clip.id, idempotencyKey: randomUUID() })
    const done = await until(
      () => lab.call('voice.job.inspect', { jobId: job.id }),
      (value: any) => value.state === 'failed'
    )
    expect(done.failureCode).toBe('ASR_MODEL_MISSING')
    // The text chat is untouched: a missing model is not a broken product.
    const sent = await lab.call('bot.messages.send', {
      botId: bot.id,
      clientMessageId: randomUUID(),
      content: 'consigo digitar',
    })
    expect(sent.turn.id).toBeTruthy()
  })

  it('returns the same job for a repeated request and never queues two for one clip', async () => {
    const { lab, asr } = await open()
    const bot = await labBot(lab)
    asr.respond(() => {
      /* never answers: the job stays running */
    })
    const { clip } = await upload(lab, { kind: 'bot', id: bot.id }, speech(1_000))
    const key = randomUUID()
    const first = await lab.call('voice.transcribe', { clipId: clip.id, idempotencyKey: key })
    const second = await lab.call('voice.transcribe', { clipId: clip.id, idempotencyKey: randomUUID() })
    expect(second.id).toBe(first.id)
  })
})
