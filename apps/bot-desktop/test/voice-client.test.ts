import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { VOICE_LIMITS } from '@maestrly/host-protocol'
import { BotJournal } from '../src/main/bot-journal'
import { VoiceClient, validateVoiceCall } from '../src/main/voice-client'
import { HostRequestError } from '../src/main/host-client'

const hostId = 'd9a02e5b-0c12-4411-9393-b5106ecff181'
const stamp = new Date().toISOString()
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
async function journal() {
  const directory = await mkdtemp(join(tmpdir(), 'voice-client-'))
  directories.push(directory)
  return new BotJournal(join(directory, 'journal.json'))
}
/** A canonical WAV of the requested size, as the renderer would hand it over. */
function wav(dataBytes: number) {
  const bytes = Buffer.alloc(44 + dataBytes)
  bytes.write('RIFF', 0, 'ascii')
  bytes.writeUInt32LE(36 + dataBytes, 4)
  bytes.write('WAVE', 8, 'ascii')
  bytes.write('fmt ', 12, 'ascii')
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(16_000, 24)
  bytes.writeUInt32LE(32_000, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36, 'ascii')
  bytes.writeUInt32LE(dataBytes, 40)
  for (let index = 0; index < dataBytes; index += 2) bytes.writeInt16LE(((index * 37) % 20000) - 10000, 44 + index)
  return bytes
}
const clip = (id: string, bytes: number) => ({
  id,
  target: { kind: 'bot' as const, id: 'bot-1' },
  state: 'stored' as const,
  bytes,
  durationMs: Math.round((bytes / 32_000) * 1000),
  digest: 'a'.repeat(64),
  sampleRate: 16_000 as const,
  channels: 1 as const,
  expiresAt: stamp,
  createdAt: stamp,
  updatedAt: stamp,
  revision: 0,
})

it('refuses anything outside the voice namespace', () => {
  expect(() => validateVoiceCall({ method: 'bot.messages.send', params: {} })).toThrow(/Invalid voice request/)
  expect(() => validateVoiceCall({ method: 'voice.status', params: {}, extra: 1 })).toThrow(/Invalid voice request/)
  expect(() => validateVoiceCall({ method: 'voice.upload.begin', params: { path: '/tmp/a.wav' } })).toThrow()
  expect(validateVoiceCall({ method: 'voice.status', params: {} }).method).toBe('voice.status')
})

it('streams a recording in bounded chunks and verifies it by digest', async () => {
  const audio = wav(VOICE_LIMITS.chunkBytes * 2 + 100)
  const sent: { method: string; params: Record<string, unknown> }[] = []
  let received = Buffer.alloc(0)
  const client = new VoiceClient(await journal(), async (method, params) => {
    sent.push({ method, params })
    if (method === 'voice.upload.begin')
      return {
        transferId: 't-1',
        clipId: 'c-1',
        target: params.target,
        size: params.sizeBytes,
        offset: 0,
        chunkBytes: VOICE_LIMITS.chunkBytes,
        digest: params.sha256,
        done: false,
        expiresAt: stamp,
      }
    if (method === 'voice.upload.chunk') {
      const chunk = Buffer.from(String(params.dataBase64), 'base64')
      received = Buffer.concat([received, chunk])
      return { transferId: 't-1', clipId: 'c-1', target: { kind: 'bot', id: 'bot-1' }, size: audio.length, offset: received.length, chunkBytes: VOICE_LIMITS.chunkBytes, digest: 'a'.repeat(64), done: received.length >= audio.length, expiresAt: stamp }
    }
    return clip('c-1', audio.length)
  })
  client.connected(hostId)
  const stored = await client.upload({ target: { kind: 'bot', id: 'bot-1' }, clientClipId: 'client-1', dataBase64: audio.toString('base64'), durationMs: 1_000 })
  expect(stored.id).toBe('c-1')
  // The digest the Host checks is computed over the exact bytes that were streamed.
  expect(sent[0].params.sha256).toBe(createHash('sha256').update(audio).digest('hex'))
  expect(received.equals(audio)).toBe(true)
  // Every chunk stayed within the declared limit.
  for (const call of sent.filter((entry) => entry.method === 'voice.upload.chunk'))
    expect(Buffer.from(String(call.params.dataBase64), 'base64').length).toBeLessThanOrEqual(VOICE_LIMITS.chunkBytes)
})

it('follows the Host cursor instead of its own, so a retried chunk is not counted twice', async () => {
  const audio = wav(VOICE_LIMITS.chunkBytes * 2)
  let calls = 0
  const client = new VoiceClient(await journal(), async (method, params) => {
    if (method === 'voice.upload.begin')
      return { transferId: 't-1', clipId: 'c-1', target: params.target, size: audio.length, offset: 0, chunkBytes: VOICE_LIMITS.chunkBytes, digest: params.sha256, done: false, expiresAt: stamp }
    if (method === 'voice.upload.chunk') {
      calls++
      // The Host says the first chunk was already there: the client must not skip ahead.
      const offset = calls === 1 ? 0 : Math.min(audio.length, (calls - 1) * VOICE_LIMITS.chunkBytes)
      return { transferId: 't-1', clipId: 'c-1', target: { kind: 'bot', id: 'bot-1' }, size: audio.length, offset, chunkBytes: VOICE_LIMITS.chunkBytes, digest: 'a'.repeat(64), done: offset >= audio.length, expiresAt: stamp }
    }
    return clip('c-1', audio.length)
  })
  client.connected(hostId)
  await client.upload({ target: { kind: 'bot', id: 'bot-1' }, clientClipId: 'client-1', dataBase64: audio.toString('base64'), durationMs: 1_000 })
  // One extra call, because the first chunk was re-sent exactly once: the client trusted the
  // Host's cursor instead of assuming its own chunk had landed.
  expect(calls).toBe(Math.ceil(audio.length / VOICE_LIMITS.chunkBytes) + 1)
})

it('refuses an upload larger than the Host would ever accept, before any request', async () => {
  const client = new VoiceClient(await journal(), async () => {
    throw new Error('should not be called')
  })
  client.connected(hostId)
  await expect(
    client.upload({ target: { kind: 'bot', id: 'bot-1' }, clientClipId: 'c', dataBase64: Buffer.alloc(VOICE_LIMITS.maxWavBytes + 10).toString('base64'), durationMs: 1_000 })
  ).rejects.toThrow(/limite/)
  await expect(client.upload({ target: { kind: 'host', id: 'h' }, clientClipId: 'c', dataBase64: 'AAAA', durationMs: 1 } as never)).rejects.toThrow(/Invalid voice upload/)
})

it('journals a send by its client message id and forgets it when the Host refuses', async () => {
  const file = await journal()
  const receipts: unknown[] = []
  const client = new VoiceClient(file, async (method) => {
    if (method === 'voice.send') throw new HostRequestError('O bot ainda está trabalhando', 'BOT_BUSY')
    return null
  })
  client.connected(hostId)
  await expect(
    client.call({ method: 'voice.send', params: { clipId: 'c-1', transcriptRevision: 1, editedText: 'olá', clientMessageId: 'm-1' } })
  ).rejects.toThrow(/trabalhando/)
  // A definitive refusal is not an uncertain outcome: nothing is left to retry.
  expect(await client.unresolved()).toEqual([])
  expect(receipts).toEqual([])
})

it('looks a lost send up instead of sending the recording twice', async () => {
  const file = await journal()
  const asked: string[] = []
  const client = new VoiceClient(file, async (method, params) => {
    if (method === 'voice.send') throw new Error('connection dropped')
    asked.push(String(params.idempotencyKey))
    return { id: 'op-1', kind: 'voice.send', status: 'succeeded', createdAt: stamp, updatedAt: stamp }
  })
  client.connected(hostId)
  await expect(client.call({ method: 'voice.send', params: { clipId: 'c-1', transcriptRevision: 1, editedText: 'olá', clientMessageId: 'm-1' } })).rejects.toThrow()
  expect((await client.unresolved()).length).toBe(1)
  const recovery = await client.recover()
  expect(recovery.recovered).toBe(1)
  expect(recovery.unresolved).toBe(0)
  expect(asked).toEqual(['m-1'])
})

it('never writes audio into the journal file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-journal-'))
  directories.push(directory)
  const file = join(directory, 'journal.json')
  const client = new VoiceClient(new BotJournal(file), async () => {
    throw new Error('dropped')
  })
  client.connected(hostId)
  await expect(
    client.call({ method: 'voice.send', params: { clipId: 'c-1', transcriptRevision: 1, editedText: 'segredo falado', clientMessageId: randomUUID() } })
  ).rejects.toThrow()
  const { readFile } = await import('node:fs/promises')
  const contents = await readFile(file, 'utf8')
  // References only: no transcript and certainly no recording.
  expect(contents).not.toContain('segredo falado')
  expect(contents).toContain('clipId')
})

it('reads a recording back by identity, in bounded pages', async () => {
  const audio = wav(VOICE_LIMITS.chunkBytes + 500)
  const client = new VoiceClient(await journal(), async (_method, params) => {
    const offset = Number(params.offset)
    const chunk = audio.subarray(offset, Math.min(offset + VOICE_LIMITS.chunkBytes, audio.length))
    return { clipId: 'c-1', offset, dataBase64: chunk.toString('base64'), done: offset + chunk.length >= audio.length, size: audio.length }
  })
  client.connected(hostId)
  const { dataBase64 } = await client.read({ clipId: 'c-1' })
  expect(Buffer.from(dataBase64, 'base64').equals(audio)).toBe(true)
  await expect(client.read({})).rejects.toThrow(/Invalid voice clip/)
})
