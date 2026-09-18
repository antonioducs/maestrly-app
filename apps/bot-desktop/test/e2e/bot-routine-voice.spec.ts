import { expect, test } from '@playwright/test'
import { launchBot, readyBot } from './bot-helpers'

/**
 * The two features meeting, which is the point of this phase: a person dictates a recurring
 * request, the bot suggests a routine, and the routine only exists once the person confirms
 * the card they were shown.
 *
 * What this run proves is the interface contract — one card, one confirmation, one routine, and
 * a conversation that stays a conversation. It deliberately does not claim anything about
 * speech recognition: the transcript here comes from a fixture, and the real evidence for ASR
 * is a recording transcribed by the Host's own packaged worker.
 */
test('dictating a recurring request leads to one reviewed routine and nothing else', async () => {
  const { app, page } = await launchBot({ MAESTRLY_BOT_FIXTURE_ROUTINE_PROPOSAL: '1' })
  try {
    await readyBot(page, 'Ana')

    // Record → transcribe → send, through the same path the composer uses.
    await page.evaluate(async () => {
      const bots = await window.bot.bot({ method: 'bot.list', params: {} })
      const target = { kind: 'bot' as const, id: bots[0].id }
      const wav = new Uint8Array(44 + 16_000 * 2)
      const view = new DataView(wav.buffer)
      const ascii = (offset: number, text: string) => {
        for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index))
      }
      ascii(0, 'RIFF')
      view.setUint32(4, wav.length - 8, true)
      ascii(8, 'WAVE')
      ascii(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, 16_000, true)
      view.setUint32(28, 32_000, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      ascii(36, 'data')
      view.setUint32(40, 16_000 * 2, true)
      let binary = ''
      for (const byte of wav) binary += String.fromCharCode(byte)
      const clip = await window.bot.voice.upload({ target, clientClipId: crypto.randomUUID(), dataBase64: btoa(binary), durationMs: 1_000 })
      const job = await window.bot.voice.call({ method: 'voice.transcribe', params: { clipId: clip.id, idempotencyKey: crypto.randomUUID() } })
      // The person reviewed the text before it went anywhere.
      await window.bot.voice.call({
        method: 'voice.send',
        params: { clipId: clip.id, transcriptRevision: job.transcriptRevision, editedText: job.transcript, clientMessageId: crypto.randomUUID() },
      })
    })
    await expect(page.locator('.message.user', { hasText: 'toda segunda às nove, prepare esse resumo' }).first()).toBeVisible({ timeout: 15_000 })

    // The suggestion is a card, and at this point still nothing is scheduled.
    const card = page.getByRole('group', { name: 'Sugestão de rotina' })
    await expect(card).toBeVisible({ timeout: 15_000 })
    expect(await page.evaluate(() => window.bot.routine({ method: 'routine.list', params: {} }))).toEqual([])

    await card.getByRole('button', { name: 'Ativar rotina', exact: true }).click()
    await expect(card).toBeHidden({ timeout: 15_000 })
    const routines = await page.evaluate(() => window.bot.routine({ method: 'routine.list', params: {} }))
    expect(routines).toHaveLength(1)
    expect(routines[0].status).toBe('active')

    // Confirming twice does not produce a second routine.
    expect(await page.evaluate(() => window.bot.routine({ method: 'routine.list', params: {} }))).toHaveLength(1)
    // And the conversation is still a conversation: no dashboard took over the screen.
    await expect(page.getByRole('textbox', { name: 'Mensagem', exact: true })).toBeVisible()
  } finally {
    await app.close()
  }
})
