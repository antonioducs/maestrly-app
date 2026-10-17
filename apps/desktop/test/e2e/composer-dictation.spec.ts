import { createServer, type ServerResponse } from 'node:http'
import { access, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { removeTempDirEventually } from './helpers/temp-cleanup'

const desktop = fileURLToPath(new URL('../..', import.meta.url))
const SPOKEN = 'spoken words'

// The real build with Chromium's fake microphone and a local OpenAI-compatible provider. Only the speech model is
// replaced: main reports it ready and returns a fixed transcription, so no 547 MB download is needed.
test('a recording takes over the composer bar and the main button sends, queues or stops', async ({
  browserName: _browserName,
}, testInfo) => {
  test.setTimeout(180_000)
  await access(path.join(desktop, 'out/main/index.js'))
  const root = await mkdtemp(path.join(os.tmpdir(), 'maestrly-dictation-'))
  let app: ElectronApplication | undefined
  let held: ServerResponse | undefined
  const prompts: string[] = []
  const chunk = (res: ServerResponse, text: string, finish: string | null = null) =>
    res.write(
      `data: ${JSON.stringify({
        id: 'dictation-fixture',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'dictation-fixture',
        choices: [{ index: 0, delta: { content: text }, finish_reason: finish }],
      })}\n\n`
    )
  const model = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: 'dictation-fixture', object: 'model' }] }))
      return
    }
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404).end()
      return
    }
    let body = ''
    for await (const part of req) body += part
    const messages = (JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> }).messages
    prompts.push(JSON.stringify(messages.filter((message) => message.role === 'user').at(-1)?.content))
    res.setHeader('content-type', 'text/event-stream')
    // The first turn stays open so the composer can be checked while the agent works.
    if (prompts.length === 1) {
      held = res
      chunk(res, 'Working on it ')
      return
    }
    chunk(res, `Fixture reply ${prompts.length}.`)
    chunk(res, '', 'stop')
    res.end('data: [DONE]\n\n')
  })
  try {
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve))
    app = await electron.launch({
      args: [
        path.join(desktop, 'out/main/index.js'),
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
      ],
      env: {
        ...process.env,
        AGENTS_E2E: '1',
        AGENTS_CHANNEL: 'dev',
        AGENTS_INSTANCE: 'composer-dictation-e2e',
        AGENTS_USERDATA: path.join(root, 'profile'),
        AGENTS_LOCALE: 'en',
        ELECTRON_RENDERER_URL: '',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      },
    })
    const page = await app.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).api))
    const call = (name: string, ...args: unknown[]) =>
      page.evaluate(({ name, args }) => (window as any).api[name](...args), { name, args })

    await app.evaluate(({ ipcMain }, spoken) => {
      const state = { transcriptions: [] as number[] }
      ;(globalThis as any).__dictationE2E = state
      // Electron keeps invoke handlers in this map; the real status handler still answers for other components.
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })
        ._invokeHandlers
      const status = handlers.get('runtime-assets:status')
      if (!status) throw new Error('runtime-assets:status is not registered')
      for (const channel of ['chat:asr-support', 'chat:transcribe', 'runtime-assets:status'])
        ipcMain.removeHandler(channel)
      ipcMain.handle('chat:asr-support', () => ({ supported: true }))
      ipcMain.handle('chat:transcribe', (_event, audio: ArrayBuffer) => {
        state.transcriptions.push(audio.byteLength)
        return { text: spoken }
      })
      ipcMain.handle('runtime-assets:status', (event, id) =>
        id === 'whisper-model'
          ? {
              id,
              displayName: 'Voice model',
              requiredBy: 'Voice dictation',
              availableVersion: 'fixture',
              downloadBytes: 0,
              unpackedBytes: 0,
              status: { id, state: 'ready', diskUsageBytes: 0 },
            }
          : status(event, id)
      )
    }, SPOKEN)
    const transcriptions = () => app!.evaluate(() => (globalThis as any).__dictationE2E.transcriptions as number[])

    await page.getByRole('button', { name: 'Skip', exact: true }).click()
    const provider = await call('chatAddProvider', {
      name: 'Dictation fixture',
      kind: 'openai',
      key: 'fixture-key',
      baseURL: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
    })
    expect(provider.ok).toBe(true)
    await call('chatSetDefault', { providerId: provider.id, modelId: 'dictation-fixture' })
    await page.getByRole('button', { name: 'New chat', exact: true }).first().click()
    await expect.poll(async () => (await call('listStandaloneConversations', true)).length).toBe(1)
    const chat = (await call('listStandaloneConversations', true))[0]
    await call('chatSetSelection', chat.id, { providerId: provider.id, modelId: 'dictation-fixture' })

    const shell = page.locator('.chat-composer-shell:visible')
    const composer = page.locator('.chat-input[contenteditable="true"]:visible')
    const mic = page.locator('button[title^="Dictate by voice"]:visible')
    const sendButton = page.locator('button[title="Send"]:visible')
    const stopButton = page.locator('button[title="Stop"]:visible')
    const queueButton = page.locator('button[title="Queue message"]:visible')
    const sendRecording = page.getByRole('button', { name: 'Stop, transcribe and send (Enter)', exact: true })
    const insertRecording = page.getByRole('button', { name: 'Stop and add the text to the message', exact: true })
    const discardRecording = page.getByRole('button', { name: 'Discard recording (Esc)', exact: true })
    // The first message also names the chat in the sidebar; look for it in the conversation only.
    const sent = (text: string) => page.getByRole('paragraph').filter({ hasText: new RegExp(`^${text}$`) })
    const record = async () => {
      await mic.click()
      await expect(discardRecording).toBeVisible()
      // Let the recorder capture some audio before it stops.
      await page.waitForTimeout(1_000)
    }

    // The reported mistake: text typed, recording on, and the click lands where Send was. It now sends both.
    await composer.fill('typed words')
    await record()
    await expect(sendButton).toHaveCount(0)
    await expect(page.locator('button[title="Add"]:visible')).toHaveCount(0)
    await expect(sendRecording).toBeVisible()
    await testInfo.attach('recording-bar', { body: await shell.screenshot(), contentType: 'image/png' })
    await sendRecording.click()
    await expect(sent(`typed words ${SPOKEN}`)).toBeVisible()
    await expect(discardRecording).toHaveCount(0)
    await expect(mic).toBeVisible()
    expect(await transcriptions()).toHaveLength(1)
    expect((await transcriptions())[0]).toBeGreaterThan(0)
    await expect.poll(() => prompts[0] ?? '').toContain(`typed words ${SPOKEN}`)

    // While the agent works there is one main button: Stop with the box empty, Queue once there is text.
    await expect(stopButton).toBeVisible()
    await expect(stopButton.locator('.chat-working-ring')).toHaveCount(1)
    await testInfo.attach('working-stop', { body: await shell.screenshot(), contentType: 'image/png' })
    await composer.fill('first queued')
    await expect(queueButton).toBeVisible()
    await expect(stopButton).toHaveCount(0)
    await testInfo.attach('working-queue', { body: await shell.screenshot(), contentType: 'image/png' })
    await queueButton.click()
    await expect(page.getByText('first queued', { exact: true }).first()).toBeVisible()
    await expect(stopButton).toBeVisible()
    // With text in the box, Esc in the composer stops the agent and keeps the draft.
    await composer.fill('kept draft')
    await composer.press('Escape')
    await expect(stopButton).toHaveCount(0)
    await expect(sendButton).toBeVisible()
    await expect(composer).toHaveText('kept draft')
    await expect.poll(async () => (await call('chatRuntime', chat.id)).streaming).toBe(false)
    held?.end()
    held = undefined

    // Insert puts the transcription in the box and sends nothing.
    await record()
    await insertRecording.click()
    await expect(composer).toHaveText(`kept draft ${SPOKEN}`)
    await expect(mic).toBeVisible()
    expect(prompts).toHaveLength(1)

    // Esc in the editor discards the recording without transcribing it.
    await record()
    await composer.press('Escape')
    await expect(discardRecording).toHaveCount(0)
    await expect(mic).toBeVisible()
    await expect(composer).toHaveText(`kept draft ${SPOKEN}`)
    expect(await transcriptions()).toHaveLength(2)

    // The shortcut starts a recording from the editor and ends it into the draft.
    const shortcut = process.platform === 'darwin' ? 'Meta+D' : 'Control+D'
    await composer.press(shortcut)
    await expect(discardRecording).toBeVisible()
    await page.waitForTimeout(1_000)
    await composer.press(shortcut)
    await expect(composer).toHaveText(`kept draft ${SPOKEN} ${SPOKEN}`)

    // Enter while recording sends the draft with the new transcription.
    await record()
    await composer.press('Enter')
    await expect(sent(`kept draft ${SPOKEN} ${SPOKEN} ${SPOKEN}`)).toBeVisible()
    await expect(sent('Fixture reply 2.')).toBeVisible()
    await expect(stopButton).toHaveCount(0)
    expect(await transcriptions()).toHaveLength(4)

    // The options live on the microphone's context menu; there is no send-automatically switch any more.
    await mic.click({ button: 'right' })
    await expect(page.getByRole('switch', { name: 'Hold to record' })).toBeVisible()
    await expect(page.getByText('Dictation language', { exact: true })).toBeVisible()
    await expect(page.getByText('Send automatically', { exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.getByText('Dictation language', { exact: true })).toHaveCount(0)
  } finally {
    held?.end()
    await app?.close().catch(() => {})
    await new Promise<void>((resolve) => model.close(() => resolve()))
    await removeTempDirEventually(root)
  }
})
