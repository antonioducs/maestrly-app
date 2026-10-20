import { randomUUID } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, writeFile, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import {
  FLEET_GATEWAY_ROUTES,
  fleetBotSchema,
  fleetEditMessageRequestSchema,
  fleetSendMessageRequestSchema,
  type FleetEditMessageRequest,
  type FleetSendMessageRequest,
  type FleetTranscriptItem,
} from '@maestrly/bot-fleet-protocol'
import { makeTextPdf } from '../helpers/pdf-fixtures'
import { removeTempDirEventually } from './helpers/temp-cleanup'
import { recordSyntheticWebm } from './helpers/webm-fixture'

const desktop = fileURLToPath(new URL('../..', import.meta.url))
const pdf = makeTextPdf(['Synthetic bot file: original PDF bytes'])
const code = Buffer.from('export const greeting = "Olá, bot"\n', 'utf8')

/**
 * A bot that answered a report. With `edit` set, the owner's message it answered comes first in its transcript, and the
 * server and the bot can edit it when `edit` is true: an edit cuts the transcript there and queues the new text.
 */
async function withBot(
  options: { files?: boolean; permission?: boolean; video?: boolean; edit?: boolean; slow?: boolean },
  run: (fixture: {
    page: Page
    downloads: string
    received: FleetSendMessageRequest[]
    edits: Array<{ path: string; body: FleetEditMessageRequest }>
    fileRequests: string[]
    expireFile: () => void
    revealedPaths: () => Promise<string[]>
    video: Buffer
    /** With `slow`, file bodies stop halfway until this runs; later bodies flow at once. */
    releaseFile: () => void
    notices: () => Promise<{ title: string; body: string }[]>
  }) => Promise<void>
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maestrly-bot-files-'))
  const downloads = path.join(root, 'downloads')
  await mkdir(downloads)
  const at = new Date().toISOString()
  const features = [...(options.files === false ? [] : ['files']), ...(options.edit ? ['message-edit'] : [])]
  const bot = fleetBotSchema.parse({
    id: 'file-bot',
    name: 'File Bot',
    role: '',
    instructions: '',
    tint: '#6688aa',
    ceiling: 'auto',
    selection: null,
    talksTo: [],
    paused: false,
    lifecycle: 'running',
    setup: { step: 'ready', error: null, errorMessage: null },
    status: 'idle',
    activity: null,
    pendingCount: 0,
    accounts: { connected: false, providers: [] },
    takeover: { state: 'none', deviceId: null, deviceName: null, since: null },
    resources: { memoryBytes: null, memoryLimitBytes: null, cpuPercent: null, startedAt: at },
    screen: { width: 1280, height: 800, display: ':1' },
    appVersion: '0.12.0',
    capabilities: features,
    createdAt: at,
    updatedAt: at,
  })
  const ref = { id: 'f-report', name: 'Relatório.pdf', mediaType: 'application/pdf', byteSize: pdf.length }
  // Recorded once the app is up, before the bot's transcript is read.
  let video: Buffer = Buffer.alloc(0)
  const clip = () => ({ id: 'f-clip', name: 'clip.webm', mediaType: 'video/webm', byteSize: video.length })
  const received: FleetSendMessageRequest[] = []
  const edits: Array<{ path: string; body: FleetEditMessageRequest }> = []
  const owner = (id: string, text: string, queued: boolean): FleetTranscriptItem => ({
    kind: 'user',
    id: 'input:' + id,
    at: new Date(Date.parse(at) - 60_000).toISOString(),
    text,
    source: 'owner',
    queued,
    memories: [],
    images: [],
  })
  // Replaced by an edit: the owner's message, edited and queued, and nothing after it.
  let edited: FleetTranscriptItem | null = null
  const fileRequests: string[] = []
  const failures: string[] = []
  const streams = new Set<ServerResponse>()
  let missing = false
  let held = options.slow === true
  const waiting = new Set<() => void>()
  let app: ElectronApplication | undefined
  const permission: Extract<FleetTranscriptItem, { kind: 'permission' }> = {
    kind: 'permission',
    id: 'perm:generate-report',
    requestId: 'generate-report',
    at,
    title: 'Create the report',
    detail: 'python3 report.py',
    tool: null,
    state: 'pending',
    resolvedAt: null,
  }
  const server = createServer(async (request, response) => {
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const entry = Object.entries(FLEET_GATEWAY_ROUTES).find(
        ([, route]) =>
          route.method === request.method &&
          new RegExp(`^${route.path.replace(/:[^/]+/g, '[^/]+')}$`).test(url.pathname)
      )
      if (!entry) return send(404, { code: 'NOT_FOUND', message: 'Unknown fixture route' })
      const [key, route] = entry
      if (request.headers['x-maestrly-fleet-protocol'] !== '1') {
        failures.push(`Missing protocol: ${key}`)
        return send(426, { code: 'PROTOCOL_INCOMPATIBLE', message: 'Bad protocol' })
      }
      if (!['meta', 'pair'].includes(key) && request.headers.authorization !== 'Bearer fixture-files-token') {
        failures.push(`Missing authentication: ${key}`)
        return send(401, { code: 'UNAUTHORIZED', message: 'Bad token' })
      }
      let body: any
      if (route.body) {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        body = route.body.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      }
      let value: unknown
      switch (key) {
        case 'meta':
          value = { protocol: 1, gatewayVersion: '0.12.0', botImage: 'fixture', botImageVersion: null, features }
          break
        case 'pair':
          value = { deviceId: 'fixture-device', token: 'fixture-files-token' }
          break
        case 'events':
          response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
          streams.add(response)
          response.write(': connected\n\n')
          request.on('close', () => streams.delete(response))
          return
        case 'host':
          value = {
            hostname: 'files-fixture',
            os: 'Linux',
            kernel: '6.8',
            arch: 'x64',
            cpus: 4,
            cpuPercent: 0,
            memory: { totalBytes: 8 * 1024 ** 3, usedBytes: 0, botsBytes: 0 },
            disk: { totalBytes: 80 * 1024 ** 3, usedBytes: 0 },
            uptimeSeconds: 60,
            gatewayVersion: '0.12.0',
            botImage: 'fixture',
            botImageVersion: null,
            dockerVersion: '28',
          }
          break
        case 'botsList':
          value = { bots: [bot] }
          break
        case 'botGet':
          value = bot
          break
        case 'inbox':
          value = { items: [] }
          break
        case 'peerMessages':
          value = { messages: [] }
          break
        case 'botSelections':
          value = { options: [], current: null }
          break
        case 'botRoutinesList':
          value = { routines: [] }
          break
        case 'botMemoriesList':
          value = { memories: [] }
          break
        case 'botTranscript':
          if (edited) {
            value = { items: [edited], before: null }
            break
          }
          value = {
            items: [
              ...(options.edit !== undefined ? [owner('owner-1', 'Summarize the report', false)] : []),
              ...(options.permission ? [permission] : []),
              {
                kind: 'tool',
                id: 'tool-share',
                at,
                name: 'bot_share_file',
                state: 'done',
                target: ref.name,
                output: null,
                images: [],
                files: [ref],
              },
              ...(options.video
                ? [
                    {
                      kind: 'tool',
                      id: 'tool-video',
                      at,
                      name: 'bot_share_file',
                      state: 'done',
                      target: 'clip.webm',
                      output: null,
                      images: [],
                      files: [clip()],
                    },
                  ]
                : []),
              { kind: 'assistant', id: 'answer', at, text: 'Your report is ready.', streaming: false },
            ],
            before: null,
          }
          break
        case 'botInteractionResolve':
          permission.state = body.reply === 'reject' ? 'denied' : 'approved'
          permission.resolvedAt = new Date().toISOString()
          response.writeHead(204)
          response.end()
          return
        case 'botMessageSend':
          received.push(fleetSendMessageRequestSchema.parse(body))
          value = { inputId: randomUUID(), itemId: randomUUID(), queued: false }
          break
        case 'botMessageEdit': {
          const edit = fleetEditMessageRequestSchema.parse(body)
          edits.push({ path: url.pathname, body: edit })
          edited = owner('owner-2', edit.text, true)
          value = { inputId: 'owner-2', itemId: 'input:owner-2', queued: true }
          break
        }
        case 'botConversationCall': {
          const results: Record<string, unknown> = {
            chatConfig: { mcpServers: [], appToolsEnabled: true, imageGenEnabled: true },
            chatGetConvTools: { app: true, imageGen: true, mcpDisabled: [] },
            chatSubagentProfilesGetConversation: {
              rules: null,
              diagnostics: [],
              enabled: true,
              subagentsEnabled: true,
            },
            chatSkillsState: {
              skills: [],
              groups: [],
              selection: { kind: 'all' },
              selectedGroupMissing: false,
              hasOverrides: false,
            },
            chatCommands: { prompts: [], project: [], skills: [] },
          }
          value = { result: results[body.op] ?? { ok: true } }
          break
        }
        case 'botFileMeta':
        case 'botFile': {
          fileRequests.push(url.pathname)
          if (missing) return send(404, { code: 'NOT_FOUND', message: 'File expired' })
          const isClip = url.pathname.includes('/files/f-clip')
          const file = isClip ? clip() : ref
          if (key === 'botFileMeta') {
            value = file
            break
          }
          response.writeHead(200, { 'Content-Type': file.mediaType, 'Content-Length': file.byteSize })
          const body = isClip ? video : pdf
          if (held) {
            const half = Math.floor(body.length / 2)
            response.write(body.subarray(0, half))
            // A canceled transfer closes the response; it must not wait for the release.
            await new Promise<void>((resolve) => {
              waiting.add(resolve)
              response.once('close', resolve)
            })
            if (!response.destroyed) response.end(body.subarray(half))
            return
          }
          response.end(body)
          return
        }
        default:
          return send(404, { code: 'NOT_FOUND', message: `Unused fixture route: ${key}` })
      }
      send(200, route.response ? route.response.parse(value) : value)
    } catch (error) {
      failures.push(String(error))
      send(500, { code: 'INTERNAL', message: 'Invalid fixture response' })
    }
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...process.env,
        AGENTS_E2E: '1',
        AGENTS_CHANNEL: 'dev',
        AGENTS_INSTANCE: 'bot-files',
        AGENTS_USERDATA: path.join(root, 'profile'),
        AGENTS_LOCALE: 'en',
        ELECTRON_RENDERER_URL: '',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      },
    })
    await app.evaluate(({ app }, dest) => app.setPath('downloads', dest), downloads)
    await app.evaluate(({ shell, Notification }) => {
      const state = globalThis as typeof globalThis & {
        fleetRevealedPaths: string[]
        fleetNotices: { title: string; body: string }[]
      }
      state.fleetRevealedPaths = []
      state.fleetNotices = []
      shell.showItemInFolder = (file) => {
        state.fleetRevealedPaths.push(file)
      }
      // Recorded instead of shown on the test machine.
      Notification.isSupported = () => true
      Notification.prototype.show = function (this: Electron.Notification) {
        state.fleetNotices.push({ title: this.title, body: this.body })
      }
    })
    const page = await app.firstWindow()
    await page.waitForFunction(() => Boolean(window.api))
    await page.getByRole('button', { name: 'Skip', exact: true }).click()
    if (options.video) video = await recordSyntheticWebm(page)
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing gateway address')
    await page.evaluate(
      (url) => window.api.fleetConnect({ url, code: 'ABCD-EFGH' }),
      `http://127.0.0.1:${address.port}`
    )
    await page.getByRole('tab', { name: /^Bots/ }).click()
    await page
      .getByRole('button', { name: /File Bot/ })
      .first()
      .click()
    await expect(page.getByRole('heading', { name: 'File Bot', exact: true })).toBeVisible()
    await run({
      page,
      downloads,
      received,
      edits,
      fileRequests,
      revealedPaths: () =>
        app!.evaluate(() => (globalThis as typeof globalThis & { fleetRevealedPaths: string[] }).fleetRevealedPaths),
      expireFile: () => {
        missing = true
      },
      video,
      releaseFile: () => {
        held = false
        for (const resolve of waiting) resolve()
        waiting.clear()
      },
      notices: () =>
        app!.evaluate(
          () => (globalThis as typeof globalThis & { fleetNotices: { title: string; body: string }[] }).fleetNotices
        ),
    })
    expect(failures).toEqual([])
  } finally {
    await app?.close().catch(() => {})
    for (const stream of streams) stream.end()
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
    await removeTempDirEventually(root)
  }
}

test('bot picker sends original PDF and code bytes without message text; drop accepts a PDF without MIME', async () => {
  await withBot({}, async ({ page, received }) => {
    await page.locator('input[type="file"][accept*="image/*"]').setInputFiles([
      { name: 'input.pdf', mimeType: 'application/pdf', buffer: pdf },
      { name: 'greeting.ts', mimeType: 'text/plain', buffer: code },
    ])
    await expect(page.getByText('input.pdf', { exact: true })).toBeVisible()
    await expect(page.getByText('greeting.ts', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => received.length).toBe(1)
    expect(received[0].text).toBe('')
    expect(received[0].attachments).toEqual([
      { kind: 'pdf', name: 'input.pdf', mediaType: 'application/pdf', dataBase64: pdf.toString('base64') },
      { kind: 'text', name: 'greeting.ts', mediaType: 'text/plain', dataBase64: code.toString('base64') },
    ])
    await page.locator('.chat-input[contenteditable="true"]:visible').evaluate((element, base64) => {
      const transfer = new DataTransfer()
      transfer.items.add(
        new File([Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))], 'dropped.pdf', { type: '' })
      )
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    }, pdf.toString('base64'))
    await expect(page.getByText('dropped.pdf', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => received.length).toBe(2)
    expect(received[1].text).toBe('')
    expect(received[1].attachments).toEqual([
      { kind: 'pdf', name: 'dropped.pdf', mediaType: 'application/pdf', dataBase64: pdf.toString('base64') },
    ])
  })
})

test('shared files stay visible in compact activity and download exact bytes without overwriting', async () => {
  await withBot({}, async ({ page, downloads, fileRequests, expireFile, revealedPaths }) => {
    await expect(page.getByText('Your report is ready.', { exact: true })).toBeVisible()
    const download = page.getByRole('button', { name: 'Download Relatório.pdf', exact: true })
    await expect(download).toBeVisible()
    const reveal = page.getByRole('button', { name: 'Show in folder', exact: true })
    await expect(reveal).toHaveCount(0)
    await download.click()
    const saved = path.join(downloads, 'Relatório.pdf')
    await expect
      .poll(() =>
        readFile(saved)
          .then((bytes) => bytes.toString('base64'))
          .catch(() => null)
      )
      .toBe(pdf.toString('base64'))
    await reveal.click()
    await expect.poll(revealedPaths).toEqual([saved])
    // Remount the renderer: the card must recover its local download from main.
    await page.reload()
    await page.getByRole('tab', { name: /^Bots/ }).click()
    await page
      .getByRole('button', { name: /File Bot/ })
      .first()
      .click()
    await expect(page.getByText('Saved to Downloads.', { exact: true })).toBeVisible()
    await expect(reveal).toBeVisible()
    // Different existing bytes prove a repeated download preserves the old file, not merely its name.
    const old = Buffer.from('Existing user content')
    await writeFile(saved, old)
    await expect(download).toBeEnabled()
    await download.click()
    await expect
      .poll(() =>
        readFile(path.join(downloads, 'Relatório (1).pdf'))
          .then((bytes) => bytes.toString('base64'))
          .catch(() => null)
      )
      .toBe(pdf.toString('base64'))
    expect(await readFile(saved)).toEqual(old)
    await expect(download).toBeEnabled()
    await reveal.click()
    await expect.poll(revealedPaths).toEqual([saved, path.join(downloads, 'Relatório (1).pdf')])
    expect(fileRequests).toEqual([
      '/v1/bots/file-bot/files/f-report',
      '/v1/bots/file-bot/files/f-report/content',
      '/v1/bots/file-bot/files/f-report',
      '/v1/bots/file-bot/files/f-report/content',
    ])
    expireFile()
    await expect(download).toBeEnabled()
    await download.click()
    await expect(page.getByRole('alert')).toHaveText('This file is no longer available.')
    await reveal.click()
    await expect
      .poll(revealedPaths)
      .toEqual([saved, path.join(downloads, 'Relatório (1).pdf'), path.join(downloads, 'Relatório (1).pdf')])
    expect((await readdir(downloads)).sort()).toEqual(['Relatório (1).pdf', 'Relatório.pdf'])
    await unlink(path.join(downloads, 'Relatório (1).pdf'))
    await page.reload()
    await page.getByRole('tab', { name: /^Bots/ }).click()
    await page
      .getByRole('button', { name: /File Bot/ })
      .first()
      .click()
    await reveal.click()
    await expect.poll(async () => (await revealedPaths()).at(-1)).toBe(saved)
    await unlink(saved)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(reveal).toHaveCount(0)
    await expect(page.getByText('Saved to Downloads.', { exact: true })).toHaveCount(0)
  })
})

test('a shared video plays in place with seeking, speed and keyboard controls, and still downloads', async () => {
  await withBot({ video: true }, async ({ page, downloads, fileRequests, video }) => {
    const open = page.getByRole('button', { name: 'Play clip.webm', exact: true })
    await expect(open).toBeVisible()
    // The preview reads the first frame from main's cache through `maestrly-media:`, past the production CSP.
    const preview = page.locator('video[aria-hidden="true"]')
    await expect.poll(() => preview.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThan(0)
    // A file is named with its server: bots of two servers may share ids.
    const [server] = await page.evaluate(() => window.api.fleetServers())
    expect(await preview.getAttribute('src')).toMatch(
      new RegExp(`^maestrly-media://fleet/${server.id}/file-bot/f-clip/[0-9a-f]{32}#t=0\\.1$`)
    )
    await expect(page.getByText(/^0:0[23]$/)).toBeVisible()
    // Other files keep their usual card.
    await expect(page.getByRole('button', { name: 'Play Relatório.pdf' })).toHaveCount(0)

    await open.click()
    const dialog = page.getByRole('dialog', { name: 'clip.webm' })
    await expect(dialog).toBeVisible()
    const player = dialog.locator('video')
    const read = <T>(property: (element: HTMLVideoElement) => T) => player.evaluate(property)
    await expect.poll(() => read((element) => !element.paused && element.currentTime > 0)).toBe(true)
    await dialog.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect.poll(() => read((element) => element.paused)).toBe(true)
    await expect(dialog.getByRole('button', { name: 'Play', exact: true })).toBeVisible()

    const speed = dialog.getByRole('button', { name: 'Playback speed', exact: true })
    await speed.click()
    await dialog.getByRole('menuitemradio', { name: '1.5×', exact: true }).click()
    await expect(dialog.getByRole('menu')).toHaveCount(0)
    await expect(speed).toBeFocused()
    await expect(speed).toHaveText('1.5×')
    expect(await read((element) => element.playbackRate)).toBe(1.5)
    await page.keyboard.press('>')
    expect(await read((element) => element.playbackRate)).toBe(2)
    for (const _ of [2, 1.5, 1.25]) await page.keyboard.press('<')
    expect(await read((element) => element.playbackRate)).toBe(1)
    await expect(speed).toHaveText('1×')
    // Escape closes the speed menu first, not the player.
    await speed.click()
    await expect(dialog.getByRole('menuitemradio', { name: 'Normal', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog.getByRole('menu')).toHaveCount(0)
    await expect(dialog).toBeVisible()

    const seek = dialog.getByRole('slider', { name: 'Seek', exact: true })
    const duration = await read((element) => element.duration)
    expect(duration).toBeGreaterThan(1.5)
    const box = (await seek.boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect.poll(() => read((element) => element.currentTime)).toBeGreaterThan(duration * 0.35)
    expect(await read((element) => element.currentTime)).toBeLessThan(duration * 0.65)
    await expect(seek).toHaveAttribute('aria-valuetext', /^0:01 of 0:0[23]$/)
    await seek.press('Home')
    await expect.poll(() => read((element) => element.currentTime)).toBeLessThan(0.1)
    // Five seconds is past the end of this clip.
    await seek.press('ArrowRight')
    await expect.poll(() => read((element) => element.currentTime)).toBeGreaterThan(1.5)
    await seek.press('Home')
    await seek.press('Space')
    await expect.poll(() => read((element) => !element.paused)).toBe(true)
    await page.keyboard.press('k')
    await expect.poll(() => read((element) => element.paused)).toBe(true)
    await page.keyboard.press('m')
    await expect.poll(() => read((element) => element.muted)).toBe(true)
    await expect(dialog.getByRole('button', { name: 'Unmute', exact: true })).toBeVisible()
    await page.keyboard.press('m')
    await expect.poll(() => read((element) => element.muted)).toBe(false)

    // The player's download is the card's: both show it saved.
    await dialog.getByRole('button', { name: 'Download', exact: true }).click()
    await expect(dialog.getByRole('button', { name: 'Saved to Downloads', exact: true })).toBeVisible()
    await expect
      .poll(() =>
        readFile(path.join(downloads, 'clip.webm'))
          .then((bytes) => bytes.toString('base64'))
          .catch(() => null)
      )
      .toBe(video.toString('base64'))

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(open).toBeFocused()
    await expect(page.getByText('Saved to Downloads.', { exact: true })).toBeVisible()
    // Reopening plays from the cache: the gateway sent the video once for playback and once for the download.
    await open.click()
    await expect.poll(() => read((element) => element.readyState)).toBeGreaterThan(0)
    await dialog.getByRole('button', { name: 'Close (Esc)', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    expect(fileRequests.filter((request) => request.includes('/f-clip'))).toEqual([
      '/v1/bots/file-bot/files/f-clip',
      '/v1/bots/file-bot/files/f-clip/content',
      '/v1/bots/file-bot/files/f-clip',
      '/v1/bots/file-bot/files/f-clip/content',
    ])
  })
})

test('a slow file shows its progress, keeps saving while the chat is closed, can be canceled, and announces its end', async () => {
  await withBot({ slow: true }, async ({ page, downloads, fileRequests, releaseFile, notices }) => {
    const download = page.getByRole('button', { name: 'Download Relatório.pdf', exact: true })
    const cancel = page.getByRole('button', { name: 'Cancel downloading Relatório.pdf', exact: true })
    const bar = page.getByRole('progressbar', { name: 'Downloading Relatório.pdf', exact: true })
    const halfBytes = Math.floor(pdf.length / 2)
    const half = String(Math.round((halfBytes / pdf.length) * 100))
    const openBot = async () => {
      await page.getByRole('tab', { name: /^Bots/ }).click()
      await page
        .getByRole('button', { name: /File Bot/ })
        .first()
        .click()
    }
    const contentRequests = () => fileRequests.filter((request) => request.endsWith('/content')).length
    await download.click()
    await expect(bar).toHaveAttribute('aria-valuenow', half)
    await expect(bar).toHaveAttribute('aria-valuetext', new RegExp(`^${halfBytes} byte of ${pdf.length} byte`))
    await expect(cancel).toBeVisible()
    await expect(download).toHaveCount(0)
    // A new renderer, as after leaving the chat: the card follows the same transfer instead of offering a new one.
    await page.reload()
    await openBot()
    await expect(bar).toHaveAttribute('aria-valuenow', half)
    await expect(download).toHaveCount(0)
    expect(contentRequests()).toBe(1)
    await cancel.click()
    await expect(download).toBeEnabled()
    await expect(bar).toHaveCount(0)
    await expect(page.getByText('Saved to Downloads.', { exact: true })).toHaveCount(0)
    await expect.poll(() => readdir(downloads)).toEqual([])
    // Started, then left: it finishes away from the chat and says so.
    await download.click()
    await expect(bar).toHaveAttribute('aria-valuenow', half)
    await page.reload()
    await expect(page.getByRole('tab', { name: /^Bots/ })).toBeVisible()
    // No card of the file is on screen, so its end is news whatever window has focus.
    await expect(page.getByRole('button', { name: /^Download / })).toHaveCount(0)
    await expect(bar).toHaveCount(0)
    expect(contentRequests()).toBe(2)
    releaseFile()
    await expect
      .poll(() =>
        readFile(path.join(downloads, 'Relatório.pdf'))
          .then((bytes) => bytes.toString('base64'))
          .catch(() => null)
      )
      .toBe(pdf.toString('base64'))
    await expect.poll(notices).toEqual([{ title: 'Download complete', body: 'Relatório.pdf from File Bot' }])
    await openBot()
    await expect(page.getByText('Saved to Downloads.', { exact: true })).toBeVisible()
    await expect(download).toBeEnabled()
    expect((await readdir(downloads)).sort()).toEqual(['Relatório.pdf'])
  })
})

for (const action of ['Approve once', 'Deny']) {
  test(`permission card disappears after ${action} and stays hidden after reload`, async () => {
    await withBot({ permission: true }, async ({ page }) => {
      const title = page.getByText('Create the report', { exact: true })
      await expect(title).toBeVisible()
      await page.getByRole('button', { name: action, exact: true }).click()
      await expect(title).toHaveCount(0)
      await expect(page.getByText('Your report is ready.', { exact: true })).toBeVisible()
      await page.reload()
      await page.getByRole('tab', { name: /^Bots/ }).click()
      await page
        .getByRole('button', { name: /File Bot/ })
        .first()
        .click()
      await expect(page.getByText('Your report is ready.', { exact: true })).toBeVisible()
      await expect(title).toHaveCount(0)
    })
  })
}

test("the owner's last message is edited in place, and the bot's answer gives way to the edit", async () => {
  await withBot({ edit: true }, async ({ page, edits }) => {
    const message = page.getByText('Summarize the report', { exact: true })
    await expect(page.getByText('Your report is ready.', { exact: true })).toBeVisible()
    const pencil = page.getByRole('button', { name: 'Edit and resend', exact: true })
    const editor = page.getByRole('textbox', { name: 'Edit and resend', exact: true })
    await message.hover()
    await pencil.click()
    await expect(editor).toHaveValue('Summarize the report')
    await expect(
      page.getByText("The bot's reply to this message, and everything after it, will be replaced.")
    ).toBeVisible()
    // Escape leaves the message as it was.
    await editor.press('Escape')
    await expect(editor).toHaveCount(0)
    await expect(message).toBeVisible()
    expect(edits).toEqual([])

    await message.hover()
    await pencil.click()
    await editor.fill('Summarize the report in Portuguese')
    await editor.press('Enter')
    await expect.poll(() => edits.length).toBe(1)
    expect(edits[0]).toEqual({
      path: '/v1/bots/file-bot/messages/owner-1/edit',
      body: { text: 'Summarize the report in Portuguese', idempotencyKey: expect.any(String) },
    })
    await expect(page.getByText('Summarize the report in Portuguese', { exact: true })).toBeVisible()
    await expect(page.getByText('Your report is ready.', { exact: true })).toHaveCount(0)
    // The edit waits in the queue: nothing is offered for editing until the bot took it.
    await expect(pencil).toHaveCount(0)
  })
})

test('a server or bot without message edits offers none', async () => {
  await withBot({ edit: false }, async ({ page, edits }) => {
    const message = page.getByText('Summarize the report', { exact: true })
    await expect(message).toBeVisible()
    await message.hover()
    await expect(page.getByRole('button', { name: 'Edit and resend', exact: true })).toHaveCount(0)
    expect(edits).toEqual([])
  })
})

test('a gateway without files support rejects PDF attachments with an update hint', async () => {
  await withBot({ files: false }, async ({ page, received }) => {
    await page
      .locator('input[type="file"][accept*="image/*"]')
      .setInputFiles({ name: 'input.pdf', mimeType: 'application/pdf', buffer: pdf })
    await expect(
      page.getByText('Update the bot server and restart this environment to send PDF and text files.', { exact: true })
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
    expect(received).toEqual([])
  })
})
