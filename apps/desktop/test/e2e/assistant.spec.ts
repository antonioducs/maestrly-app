import { createServer, type ServerResponse } from 'node:http'
import { access, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test as base, type ElectronApplication, type Page } from '@playwright/test'
import { removeTempDirEventually } from './helpers/temp-cleanup'

const desktop = fileURLToPath(new URL('../..', import.meta.url))
const modelId = 'assistant-fixture'
const editor = (page: Page) => page.locator('.chat-input[contenteditable="true"]:visible')
const api = (page: Page, name: string, ...args: unknown[]) =>
  page.evaluate(({ name, args }) => (window as any).api[name](...args), { name, args })

function chunk(response: ServerResponse, text: string, finish: string | null = null) {
  response.write(
    `data: ${JSON.stringify({
      id: 'assistant-fixture',
      object: 'chat.completion.chunk',
      created: 0,
      model: modelId,
      choices: [{ index: 0, delta: { content: text }, finish_reason: finish }],
    })}\n\n`
  )
}

interface Session {
  app: ElectronApplication
  page: Page
  requests: Array<{ messages: Array<{ role: string; content: unknown }> }>
}

const test = base.extend<{ session: Session }>({
  session: async ({ playwright }, use) => {
    await access(path.join(desktop, 'out/main/index.js'))
    const root = await mkdtemp(path.join(os.tmpdir(), 'maestrly-assistant-e2e-'))
    const requests: Session['requests'] = []
    let app: ElectronApplication | undefined
    const model = createServer(async (request, response) => {
      if (request.url === '/v1/models') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ data: [{ id: modelId, object: 'model' }] }))
        return
      }
      if (request.url !== '/v1/chat/completions') return void response.writeHead(404).end()
      let body = ''
      for await (const part of request) body += part
      requests.push(JSON.parse(body))
      response.setHeader('content-type', 'text/event-stream')
      chunk(response, `Assistant reply ${requests.length}.`)
      chunk(response, '', 'stop')
      response.end('data: [DONE]\n\n')
    })
    try {
      await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve))
      app = await playwright._electron.launch({
        args: [path.join(desktop, 'out/main/index.js')],
        env: {
          ...process.env,
          AGENTS_E2E: '1',
          AGENTS_CHANNEL: 'dev',
          AGENTS_INSTANCE: 'assistant-e2e',
          AGENTS_USERDATA: path.join(root, 'profile'),
          AGENTS_LOCALE: 'en',
          ELECTRON_RENDERER_URL: '',
          OPENAI_API_KEY: '',
          ANTHROPIC_API_KEY: '',
        },
      })
      const page = await app.firstWindow()
      await page.waitForFunction(() => Boolean((window as any).api))
      await page.getByRole('button', { name: 'Skip', exact: true }).click()
      const provider = await api(page, 'chatAddProvider', {
        name: 'Assistant fixture',
        kind: 'openai',
        key: 'fixture-key',
        baseURL: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
      })
      expect(provider.ok).toBe(true)
      await api(page, 'chatSetDefault', { providerId: provider.id, modelId })
      await use({ app, page, requests })
    } finally {
      await app?.close().catch(() => undefined)
      model.closeAllConnections()
      await new Promise<void>((resolve) => model.close(() => resolve()))
      await removeTempDirEventually(root)
    }
  },
})

async function assistantVisible(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some((win) => win.webContents.getURL().endsWith('/assistant.html') && win.isVisible())
  )
}

test('the assistant registers its shortcut, follows its settings and keeps the app in the background', async ({
  session,
}) => {
  const { app, page } = session
  const registered = (accelerator: string) =>
    app.evaluate(({ globalShortcut }, value) => globalShortcut.isRegistered(value), accelerator)
  const defaultAccelerator = process.platform === 'darwin' ? 'Super+Shift+Space' : 'Control+Shift+Space'
  await expect.poll(() => registered(defaultAccelerator)).toBe(true)

  const changed = await api(page, 'setAssistantSettings', { shortcut: { key: 'k', mods: ['control', 'alt'] } })
  expect(changed.shortcutError).toBeNull()
  expect(await registered('Control+Alt+K')).toBe(true)
  expect(await registered(defaultAccelerator)).toBe(false)
  await api(page, 'setAssistantSettings', { enabled: false })
  expect(await registered('Control+Alt+K')).toBe(false)
  await api(page, 'setAssistantSettings', { enabled: true })

  const mainVisible = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((win) => win.webContents.getURL().endsWith('/index.html') && win.isVisible())
    )
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().endsWith('/index.html'))
      ?.close()
  )
  await expect.poll(mainVisible).toBe(false)
  expect(app.windows().includes(page)).toBe(true)

  await api(page, 'assistantOpenSettings', 'assistant')
  await expect.poll(mainVisible).toBe(true)
  await expect(page.getByText('Global shortcut', { exact: true })).toBeVisible()
  await expect(page.getByRole('switch', { name: /Keep running in the background/ })).toHaveAttribute(
    'aria-checked',
    'true'
  )

  // Voice: the OpenAI engine without a key points to the dictation key, embedded below.
  await expect(page.getByRole('heading', { name: 'Voice', exact: true })).toBeVisible()
  await page.getByRole('combobox', { name: 'Speech engine' }).click()
  await page.getByRole('option', { name: 'OpenAI (natural, paid per use)' }).click()
  await expect.poll(async () => (await api(page, 'assistantSettings')).settings.voice.engine).toBe('openai')
  await expect(page.getByRole('button', { name: 'Test voice' })).toBeDisabled()
  await page.getByRole('button', { name: 'Set the key', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Transcription', exact: true })).toBeInViewport()

  // Realtime: billed for speech, not silence, with its own model.
  await page.getByRole('combobox', { name: 'Mode' }).click()
  await page.getByRole('option', { name: 'Realtime (OpenAI API)' }).click()
  await expect(page.getByText(/silence is not billed/)).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Realtime model' })).toContainText('gpt-realtime-2.1-mini')
  await expect.poll(async () => (await api(page, 'assistantSettings')).settings.voice.mode).toBe('realtime')
})

test('the assistant window opens its own pinned conversation, streams a reply and hides', async ({ session }) => {
  const { app, page, requests } = session
  const opened = app.waitForEvent('window')
  await api(page, 'assistantShow')
  const assistant = await opened
  await expect(assistant.getByRole('button', { name: 'New session', exact: true })).toBeVisible()
  await expect(editor(assistant)).toBeVisible()
  // The voice takes the microphone's place in the assistant's composer.
  await expect(assistant.getByRole('button', { name: 'Talk to the assistant', exact: true })).toBeVisible()
  await expect(assistant.locator('[data-voice-state]')).toHaveAttribute('data-voice-state', 'idle')
  // Realtime voice runs over WebRTC under the app's content security policy.
  const webrtc = await assistant.evaluate(async () => {
    const violations: string[] = []
    document.addEventListener('securitypolicyviolation', (event) => violations.push(event.violatedDirective))
    const peer = new RTCPeerConnection()
    peer.createDataChannel('oai-events')
    peer.addTransceiver('audio', { direction: 'sendrecv' })
    const offer = await peer.createOffer()
    await peer.setLocalDescription(offer)
    const audio = document.createElement('audio')
    audio.srcObject = new MediaStream()
    peer.close()
    await new Promise((resolve) => setTimeout(resolve, 50))
    return { sdp: offer.sdp?.startsWith('v=') && offer.sdp.includes('webrtc-datachannel'), violations }
  })
  expect(webrtc).toEqual({ sdp: true, violations: [] })

  const chats = (await api(page, 'listStandaloneConversations', false)) as Array<{
    id: string
    name: string
    pinnedAt: number | null
  }>
  const conversation = chats.find((chat) => chat.name === 'Assistant')
  expect(conversation?.pinnedAt).toBeTruthy()

  await editor(assistant).fill('How are things?')
  await editor(assistant).press('Enter')
  await expect(assistant.getByText('Assistant reply 1.', { exact: true })).toBeVisible()
  expect(JSON.stringify(requests[0].messages[0])).toContain('Maestrly copilot')

  // Realtime voice: what the person said reaches the assistant as their own message, a human turn with the
  // assistant's tools, and the reply comes back to be spoken.
  const spoken = await assistant.evaluate(() =>
    (window as any).api.assistantRealtimeTool({
      name: 'ask_assistant',
      arguments: JSON.stringify({ request: 'status check' }),
      heard: ['como estão as coisas?'],
    })
  )
  expect(JSON.parse(spoken as string)).toEqual({ reply: expect.stringMatching(/^Assistant reply \d+\.$/) })
  const voiced = requests.find((request) => JSON.stringify(request.messages.at(-1)).includes('🎙 como estão as coisas?'))
  expect(voiced).toBeTruthy()
  const offered = ((voiced as { tools?: Array<{ function?: { name?: string } }> }).tools ?? []).map(
    (tool) => tool.function?.name
  )
  expect(offered).toContain('maestrly_overview')
  await expect(assistant.getByText(/como estão as coisas\?/)).toBeVisible()
  await expect(
    assistant.evaluate(() =>
      (window as any).api.assistantRealtimeTool({ name: 'bot_send', arguments: '{}', heard: [] })
    )
  ).rejects.toThrow()

  await editor(assistant).press('Escape')
  await expect.poll(() => assistantVisible(app)).toBe(false)

  await api(page, 'assistantShow')
  await expect.poll(() => assistantVisible(app)).toBe(true)
  await assistant.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(assistant.getByText('Assistant reply 1.', { exact: true })).toHaveCount(0)
  const after = (await api(page, 'listStandaloneConversations', true)) as Array<{ id: string; archived: number }>
  expect(after.find((chat) => chat.id === conversation!.id)?.archived).toBe(1)
  expect(after.filter((chat) => !chat.archived && chat.id !== conversation!.id).length).toBeGreaterThan(0)
})
