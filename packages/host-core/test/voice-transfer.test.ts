import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { VOICE_LIMITS } from '@maestrly/host-protocol'
import { labBot, routineLab, until, type RoutineLab } from './routine-helpers.js'
import { asrBundle, fakeAsr, speech, upload } from './voice-helpers.js'

const labs: RoutineLab[] = []
afterEach(async () => {
  for (const lab of labs.splice(0)) await lab.close().catch(() => {})
})
async function open() {
  const asr = fakeAsr()
  const lab = await routineLab({ asr: { bundleDirectory: await asrBundle(), factory: asr.factory, idleMs: 50, timeoutMs: 2_000 } })
  labs.push(lab)
  await lab.service.ready()
  return { lab, asr }
}
/** Record, transcribe and wait for the text the person would actually review. */
async function draft(lab: RoutineLab, target: { kind: 'bot' | 'team'; id: string }) {
  const { clip } = await upload(lab, target, speech(1_500))
  const job = await lab.call('voice.transcribe', { clipId: clip.id, idempotencyKey: randomUUID() })
  const ready = await until(() => lab.call('voice.job.inspect', { jobId: job.id }), (value: any) => value.state === 'succeeded')
  return { clip, job: ready }
}

describe.skipIf(process.platform === 'win32')('sending a voice message', () => {
  it('creates the message, the task and the audio link in one go', async () => {
    const { lab } = await open()
    const bot = await labBot(lab)
    const { clip, job } = await draft(lab, { kind: 'bot', id: bot.id })
    const receipt = await lab.call('voice.send', {
      clipId: clip.id,
      transcriptRevision: job.transcriptRevision,
      editedText: job.transcript,
      clientMessageId: randomUUID(),
    })
    expect(receipt.bot.message.content).toBe(job.transcript)
    expect(receipt.meta).toMatchObject({ clipId: clip.id, edited: false, audioAvailable: true })
    // Only the text reached the bot: the recording is not an attachment and not a workspace file.
    // Dispatch is asynchronous: wait for the guest to have received the turn before reading it.
    await until(() => lab.guest(bot.id).turns.has(receipt.bot.turn.id), (reached) => reached)
    const snapshot = lab.guest(bot.id).turns.get(receipt.bot.turn.id)!.snapshot
    expect(snapshot.message).toBe(job.transcript)
    expect(snapshot.attachments).toEqual([])
    expect(JSON.stringify(snapshot)).not.toContain('RIFF')
  })

  it('records that the person edited the machine transcript, keeping both', async () => {
    const { lab } = await open()
    const bot = await labBot(lab)
    const { clip, job } = await draft(lab, { kind: 'bot', id: bot.id })
    const receipt = await lab.call('voice.send', {
      clipId: clip.id,
      transcriptRevision: job.transcriptRevision,
      editedText: 'toda segunda às nove, prepare o resumo da semana',
      clientMessageId: randomUUID(),
    })
    expect(receipt.meta.edited).toBe(true)
    expect(receipt.meta.transcript).toBe(job.transcript)
    expect(receipt.bot.message.content).toBe('toda segunda às nove, prepare o resumo da semana')
  })

  it('refuses text from a transcription that was replaced meanwhile', async () => {
    const { lab } = await open()
    const bot = await labBot(lab)
    const { clip, job } = await draft(lab, { kind: 'bot', id: bot.id })
    await expect(
      lab.call('voice.send', { clipId: clip.id, transcriptRevision: job.transcriptRevision + 1, editedText: 'outro texto', clientMessageId: randomUUID() })
    ).rejects.toMatchObject({ code: 'VOICE_TRANSCRIPT_STALE' })
  })

  it('refuses to send before there is any text at all', async () => {
    const { lab } = await open()
    const bot = await labBot(lab)
    const { clip } = await upload(lab, { kind: 'bot', id: bot.id }, speech(1_000))
    await expect(lab.call('voice.send', { clipId: clip.id, transcriptRevision: 0, editedText: 'inventado', clientMessageId: randomUUID() })).rejects.toMatchObject({
      code: 'VOICE_TRANSCRIPT_REQUIRED',
    })
    expect(lab.guest(bot.id).turns.size).toBe(0)
  })

  it('sends once however many times the request is repeated', async () => {
    const { lab } = await open()
    const bot = await labBot(lab)
    const { clip, job } = await draft(lab, { kind: 'bot', id: bot.id })
    const clientMessageId = randomUUID()
    const first = await lab.call('voice.send', { clipId: clip.id, transcriptRevision: job.transcriptRevision, editedText: job.transcript, clientMessageId })
    const second = await lab.call('voice.send', { clipId: clip.id, transcriptRevision: job.transcriptRevision, editedText: job.transcript, clientMessageId })
    expect(second.bot.message.id).toBe(first.bot.message.id)
    expect(second.bot.turn.id).toBe(first.bot.turn.id)
    expect(lab.guest(bot.id).turns.size).toBe(1)
  })

  it('keeps the draft when the bot is busy instead of sending it somewhere else', async () => {
    const { lab } = await open()
    const bot = await labBot(lab)
    const { clip, job } = await draft(lab, { kind: 'bot', id: bot.id })
    await lab.call('bot.messages.send', { botId: bot.id, clientMessageId: randomUUID(), content: 'trabalhe nisto' })
    await expect(
      lab.call('voice.send', { clipId: clip.id, transcriptRevision: job.transcriptRevision, editedText: job.transcript, clientMessageId: randomUUID() })
    ).rejects.toMatchObject({ code: 'BOT_BUSY' })
    // The recording and its text are intact, ready to send again.
    expect((await lab.call('voice.clip.inspect', { clipId: clip.id })).state).toBe('stored')
    expect((await lab.call('voice.job.inspect', { jobId: job.id })).transcript).toBe(job.transcript)
  })

  it('sends to the target the clip belongs to, not one named in the request', async () => {
    const { lab } = await open()
    const first = await labBot(lab, 'Primeira')
    const second = await labBot(lab, 'Segunda')
    const { clip, job } = await draft(lab, { kind: 'bot', id: first.id })
    await lab.call('voice.send', { clipId: clip.id, transcriptRevision: job.transcriptRevision, editedText: job.transcript, clientMessageId: randomUUID() })
    await until(() => lab.guest(first.id).turns.size, (size) => size === 1)
    expect(lab.guest(second.id).turns.size).toBe(0)
  })

  it('answers voice.forMessages only for the target that owns the messages', async () => {
    const { lab } = await open()
    const first = await labBot(lab, 'Primeira')
    const second = await labBot(lab, 'Segunda')
    const { clip, job } = await draft(lab, { kind: 'bot', id: first.id })
    const receipt = await lab.call('voice.send', { clipId: clip.id, transcriptRevision: job.transcriptRevision, editedText: job.transcript, clientMessageId: randomUUID() })
    const mine = await lab.call('voice.forMessages', { target: { kind: 'bot', id: first.id }, messageIds: [receipt.bot.message.id] })
    expect(mine).toHaveLength(1)
    const foreign = await lab.call('voice.forMessages', { target: { kind: 'bot', id: second.id }, messageIds: [receipt.bot.message.id] })
    expect(foreign).toEqual([])
  })
})

describe.skipIf(process.platform === 'win32')('removing and expiring audio', () => {
  it('removes the recording and keeps the conversation exactly as it was', async () => {
    const { lab } = await open()
    const bot = await labBot(lab)
    const { clip, job } = await draft(lab, { kind: 'bot', id: bot.id })
    const receipt = await lab.call('voice.send', { clipId: clip.id, transcriptRevision: job.transcriptRevision, editedText: job.transcript, clientMessageId: randomUUID() })
    const removed = await lab.call('voice.clip.remove', { clipId: clip.id, idempotencyKey: randomUUID() })
    expect(removed).toMatchObject({ state: 'removed', bytes: 0 })
    // The message the person sent is still there, and still says what it said.
    const page = await lab.call('bot.messages.list', { botId: bot.id, limit: 20 })
    expect(page.messages.find((message: any) => message.id === receipt.bot.message.id).content).toBe(job.transcript)
    const meta = await lab.call('voice.forMessages', { target: { kind: 'bot', id: bot.id }, messageIds: [receipt.bot.message.id] })
    expect(meta[0]).toMatchObject({ audioAvailable: false, transcript: job.transcript })
    await expect(lab.call('voice.clip.read', { clipId: clip.id, offset: 0, length: 1024 })).rejects.toMatchObject({ code: 'VOICE_CLIP_EXPIRED' })
  })

  it('expires an abandoned draft without touching a recording somebody sent', async () => {
    const { lab } = await open()
    const bot = await labBot(lab)
    const abandoned = await upload(lab, { kind: 'bot', id: bot.id }, speech(1_000))
    const { clip, job } = await draft(lab, { kind: 'bot', id: bot.id })
    await lab.call('voice.send', { clipId: clip.id, transcriptRevision: job.transcriptRevision, editedText: job.transcript, clientMessageId: randomUUID() })
    // A day later the draft is gone and the sent one is still playable.
    await lab.voice.sweep(Date.now() + VOICE_LIMITS.draftTtlMs + 60_000)
    expect((await lab.call('voice.clip.inspect', { clipId: abandoned.clip.id })).state).toBe('expired')
    expect((await lab.call('voice.clip.inspect', { clipId: clip.id })).state).toBe('stored')
    expect((await lab.call('voice.clip.read', { clipId: clip.id, offset: 0, length: 1024 })).size).toBeGreaterThan(0)
  })

  it('keeps a sent recording for its retention window and not longer', async () => {
    const { lab } = await open()
    const bot = await labBot(lab)
    const { clip, job } = await draft(lab, { kind: 'bot', id: bot.id })
    const receipt = await lab.call('voice.send', { clipId: clip.id, transcriptRevision: job.transcriptRevision, editedText: job.transcript, clientMessageId: randomUUID() })
    await lab.voice.sweep(Date.now() + (VOICE_LIMITS.clipTtlDays + 1) * 24 * 60 * 60_000)
    expect((await lab.call('voice.clip.inspect', { clipId: clip.id })).state).toBe('expired')
    // The message and its transcript outlive the audio.
    const meta = await lab.call('voice.forMessages', { target: { kind: 'bot', id: bot.id }, messageIds: [receipt.bot.message.id] })
    expect(meta[0]).toMatchObject({ audioAvailable: false, transcript: job.transcript })
  })
})

describe.skipIf(process.platform === 'win32')('voice to a team', () => {
  it('opens one run from the confirmed text, as a person\'s own request', async () => {
    const { lab } = await open()
    const coordinator = await labBot(lab, 'Coordenadora')
    const member = await labBot(lab, 'Analista')
    const team = await lab.call('team.create', {
      idempotencyKey: randomUUID(),
      name: 'Relatórios',
      objective: '',
      confirmSharing: true,
      members: [
        { botId: coordinator.id, role: '', coordinator: true },
        { botId: member.id, role: '', coordinator: false },
      ],
    })
    const { clip, job } = await draft(lab, { kind: 'team', id: team.team.id })
    const receipt = await lab.call('voice.send', { clipId: clip.id, transcriptRevision: job.transcriptRevision, editedText: job.transcript, clientMessageId: randomUUID() })
    expect(receipt.team.message.author).toEqual({ kind: 'human' })
    expect(receipt.team.message.content).toBe(job.transcript)
    expect(receipt.team.run.status).toBe('planning')
    expect(receipt.team.message.artifacts).toEqual([])
  })
})
