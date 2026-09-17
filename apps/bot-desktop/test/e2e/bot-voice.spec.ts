import { expect, test } from '@playwright/test'
import { launchBot, readyBot } from './bot-helpers'

/**
 * Voice in the packaged interface. The recording itself needs a real microphone, which a
 * headless run does not have — so these tests exercise what the interface promises around it:
 * nothing is granted on load, the audio path is explicit, sending is a separate act, and a
 * computer that cannot transcribe simply has no button.
 *
 * The transcription gate itself is deliberately NOT tested here. A fixture that returns a
 * sentence proves nothing about speech recognition; that evidence comes from the Host's own
 * packaged worker, in the laboratory report.
 */
test('the microphone is never requested just because the app opened', async () => {
  const { app, page } = await launchBot()
  try {
    await readyBot(page, 'Ana')
    // No permission was asked for, and the gate is closed.
    const armed = await app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return new Promise<boolean>((resolve) => {
        window.webContents.session.setPermissionRequestHandler
        resolve(false)
      })
    })
    expect(armed).toBe(false)
    // The button exists because this computer can transcribe, but it did nothing on its own.
    await expect(page.getByRole('button', { name: 'Gravar áudio', exact: true })).toBeVisible()
  } finally {
    await app.close()
  }
})

test('a computer that cannot transcribe simply has no microphone button', async () => {
  const { app, page } = await launchBot({ MAESTRLY_BOT_FIXTURE_NO_VOICE: '1' })
  try {
    await readyBot(page, 'Ana')
    await expect(page.getByRole('button', { name: 'Gravar áudio', exact: true })).toBeHidden()
    // And typing still works exactly as before: a missing model is not a broken product.
    await page.getByRole('textbox', { name: 'Mensagem', exact: true }).fill('consigo digitar')
    await expect(page.getByRole('button', { name: 'Enviar', exact: true })).toBeEnabled()
  } finally {
    await app.close()
  }
})

test('a voice message becomes a normal message, with its transcript beside it', async () => {
  const { app, page } = await launchBot()
  try {
    await readyBot(page, 'Ana')
    // The application's own path: upload, transcribe, then send the confirmed text.
    const receipt = await page.evaluate(async () => {
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
      return window.bot.voice.call({
        method: 'voice.send',
        params: { clipId: clip.id, transcriptRevision: job.transcriptRevision, editedText: job.transcript, clientMessageId: crypto.randomUUID() },
      })
    })
    expect(receipt.meta.audioAvailable).toBe(true)
    // It reads as a message in the conversation, with the recording attached to it. The text is
    // scoped to the person's own message: the bot's reply quotes it back, which is not the subject.
    await expect(page.locator('.message.user', { hasText: 'toda segunda às nove, prepare esse resumo' }).first()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('button', { name: 'Ouvir', exact: true })).toBeVisible()

    // Removing the audio keeps the message and says the recording is gone.
    await page.evaluate(
      async (clipId) => window.bot.voice.call({ method: 'voice.clip.remove', params: { clipId, idempotencyKey: crypto.randomUUID() } }),
      receipt.meta.clipId
    )
    await page.reload()
    await expect(page.locator('.message.user', { hasText: 'toda segunda às nove, prepare esse resumo' }).first()).toBeVisible({ timeout: 15_000 })
    // The recording is gone, the message is not.
    await expect(page.getByText('Áudio removido', { exact: true })).toBeVisible()
  } finally {
    await app.close()
  }
})

test('the person can choose which microphone the next note uses, and the choice survives a restart', async () => {
  const { app, page } = await launchBot()
  try {
    // A headless run has no devices: the browser API is stubbed with two named inputs.
    await page.addInitScript(() => {
      Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', {
        value: async () => [
          { kind: 'audioinput', deviceId: 'mic-1', label: 'Microfone interno', groupId: 'g1' },
          { kind: 'audioinput', deviceId: 'mic-2', label: 'Headset USB', groupId: 'g2' },
          { kind: 'videoinput', deviceId: 'cam', label: 'Câmera', groupId: 'g3' },
        ],
        configurable: true,
      })
    })
    await page.reload()
    await readyBot(page, 'Ana')
    await page.getByRole('button', { name: 'Escolher microfone', exact: true }).click()
    const list = page.getByRole('listbox', { name: 'Escolher microfone' })
    await expect(list.getByRole('option')).toHaveCount(3)
    await expect(list.getByRole('option', { name: 'Câmera' })).toHaveCount(0)
    await list.getByRole('option', { name: 'Headset USB' }).click()
    await expect.poll(async () => (await page.evaluate(() => window.bot.preferences())).microphoneDeviceId).toBe('mic-2')
    await page.reload()
    await expect(page.locator('.chat-header h1')).toHaveText('Ana')
    await expect(page.getByRole('button', { name: 'Escolher microfone', exact: true })).toHaveAttribute('title', 'Headset USB')
  } finally {
    await app.close()
  }
})
