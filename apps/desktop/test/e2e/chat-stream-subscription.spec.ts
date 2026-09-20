import { createServer, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { removeTempDirEventually } from './helpers/temp-cleanup'

const desktop = fileURLToPath(new URL('../..', import.meta.url))

/**
 * The main process sends conversation events only to renderers currently subscribed to that
 * conversation, so a subscription recreated mid-turn drops whatever arrives in between. Losing the
 * terminal event leaves the composer reporting a live response forever, which needs no failure
 * injection to happen: ordinary catalog reloads used to recreate the subscription during a turn.
 */
test('live chat subscriptions survive renderer churn during a turn', async () => {
  test.setTimeout(180_000)
  await access(path.join(desktop, 'out/main/index.js'))
  const root = mkdtempSync(path.join(os.tmpdir(), 'maestrly-stream-subscription-'))
  let app: ElectronApplication | undefined
  let page!: Page
  let live: ServerResponse | undefined
  let requests = 0

  const chunk = (response: ServerResponse, text: string, finish: string | null = null) => {
    response.write(
      `data: ${JSON.stringify({
        id: 'subscription-fixture',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'subscription-fixture',
        choices: [{ index: 0, delta: { content: text }, finish_reason: finish }],
      })}\n\n`
    )
  }
  const model = createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ data: [{ id: 'subscription-fixture', object: 'model' }] }))
      return
    }
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    for await (const _part of request) {
      /* Drain the request body before answering. */
    }
    requests++
    response.setHeader('content-type', 'text/event-stream')
    // Hold the response open so the turn is still live while the renderer churns.
    chunk(response, 'Streaming answer: ')
    live = response
  })

  const call = (name: string, ...args: unknown[]) =>
    page.evaluate(({ name, args }) => (window as any).api[name](...args), { name, args })

  try {
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve))
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...process.env,
        AGENTS_E2E: '1',
        AGENTS_CHANNEL: 'dev',
        AGENTS_INSTANCE: 'stream-subscription-e2e',
        AGENTS_USERDATA: path.join(root, 'profile'),
        AGENTS_LOCALE: 'en',
        ELECTRON_RENDERER_URL: '',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      },
    })
    page = await app.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).api))
    await page.getByRole('button', { name: 'Skip', exact: true }).click()

    const provider = (await call('chatAddProvider', {
      name: 'Subscription fixture',
      kind: 'openai',
      key: 'fixture-key',
      baseURL: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
    })) as { ok: boolean; id: string }
    expect(provider.ok).toBe(true)
    await call('chatSetDefault', { providerId: provider.id, modelId: 'subscription-fixture' })
    await page.getByRole('button', { name: 'New chat', exact: true }).first().click()
    await expect
      .poll(async () => ((await call('listStandaloneConversations', true)) as unknown[]).length)
      .toBe(1)
    const [conversation] = (await call('listStandaloneConversations', true)) as Array<{ id: string }>
    await call('chatSetSelection', conversation.id, {
      providerId: provider.id,
      modelId: 'subscription-fixture',
    })

    await page.locator('.chat-input[contenteditable="true"]:visible').fill('subscription-turn')
    await page.locator('button[title="Send"]:visible').click()
    await expect(page.getByText('Streaming answer:', { exact: false })).toBeVisible()
    expect(requests).toBe(1)

    await app.evaluate(({ ipcMain }) => {
      const churn = { subscribe: 0, unsubscribe: 0 }
      ;(globalThis as unknown as { __chatSubscriptionChurn: typeof churn }).__chatSubscriptionChurn = churn
      ipcMain.on('chat:subscribe', () => churn.subscribe++)
      ipcMain.on('chat:unsubscribe', () => churn.unsubscribe++)
    })

    // Catalog reloads rebuild renderer callbacks while the turn streams; the subscription must not
    // follow those identities.
    for (let reload = 0; reload < 3; reload++) {
      await page.evaluate(() => window.dispatchEvent(new Event('maestrly:subagent-profiles-changed')))
      await page.waitForTimeout(250)
    }
    expect(
      await app.evaluate(
        () => (globalThis as unknown as { __chatSubscriptionChurn: unknown }).__chatSubscriptionChurn
      )
    ).toEqual({ subscribe: 0, unsubscribe: 0 })

    chunk(live!, 'complete.')
    chunk(live!, '', 'stop')
    live!.end('data: [DONE]\n\n')
    live = undefined

    // The terminal event still reaches the renderer, so the composer stops reporting a live turn.
    await expect(page.getByText('Streaming answer: complete.', { exact: false })).toBeVisible()
    await expect(page.locator('button[title="Stop"]:visible')).toHaveCount(0)

    // A terminal event that never reaches this renderer must still release the composer: the
    // authoritative turn state in the main process decides, and a frozen queue would strand the
    // conversation. Drop the next one at the preload boundary to reproduce that loss exactly.
    await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents
      const deliver = contents.send.bind(contents)
      const state = { dropped: 0, done: false }
      ;(globalThis as unknown as { __droppedTerminalEvents: typeof state }).__droppedTerminalEvents = state
      contents.send = (channel: string, ...args: unknown[]) => {
        const event = args[0] as { kind?: string } | undefined
        // A subscription gap loses the whole tail of a turn, not a single frame.
        const terminal = event?.kind === 'finish' || event?.kind === 'done'
        if (channel.startsWith('chat:delta:') && terminal && !state.done) {
          state.dropped++
          if (event?.kind === 'done') state.done = true
          return
        }
        deliver(channel, ...args)
      }
    })

    await page.locator('.chat-input[contenteditable="true"]:visible').fill('recovered-turn')
    await page.locator('button[title="Send"]:visible').click()
    await expect(page.getByText('Streaming answer:', { exact: false }).last()).toBeVisible()
    expect(requests).toBe(2)
    chunk(live!, 'recovered.')
    chunk(live!, '', 'stop')
    live!.end('data: [DONE]\n\n')
    live = undefined

    await expect(page.getByText('Streaming answer: recovered.', { exact: false })).toBeVisible()
    expect(
      await app.evaluate(
        () => (globalThis as unknown as { __droppedTerminalEvents: { dropped: number } }).__droppedTerminalEvents.dropped
      )
    ).toBe(2)
    await expect(page.locator('button[title="Stop"]:visible')).toHaveCount(0)
  } finally {
    live?.end()
    await app?.close().catch(() => undefined)
    await new Promise<void>((resolve) => model.close(() => resolve()))
    await removeTempDirEventually(root)
  }
})
