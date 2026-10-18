import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { app } from 'electron'
import { fleetEnvironmentTile, type FleetInstanceProfile } from '@maestrly/bot-fleet-protocol'
import * as chatService from '../../src/main/chat/service'
import { attachmentConversationDir } from '../../src/main/chat/attachment-artifacts'
import { upsertChatMessage } from '../../src/main/chat/chat-store'
import { EnvironmentRuntime, type EnvironmentRuntimeDeps } from '../../src/main/fleet/instance/environment'
import { parseBotInstanceConfig } from '../../src/main/fleet/instance/config'
import { createInstanceControlServer } from '../../src/main/fleet/instance/server'
import { writeBotPaused } from '../../src/main/fleet/instance/registry'
import { createLocalMemory, listLocalMemories } from '../../src/main/memory/local-memory-service'
import { deleteConversation, getAppSetting, getConversation } from '../../src/main/store'
import type { DisplaySurface } from '../../src/main/fleet/instance/displays'
import type { ScreenSession } from '../../src/main/fleet/instance/screen-session'
import type { ScreenFocusOwner } from '../../src/main/screen-focus'
import { closeDb, freshDb } from '../helpers/db'

const model = {
  providerId: 'synthetic',
  providerLabel: 'Synthetic',
  modelId: 'model-a',
  reasoningEfforts: [],
  fastMode: false,
}
const profile = (botId: string, name: string): FleetInstanceProfile => ({
  botId,
  name,
  instructions: `Work as ${name}.`,
  ceiling: 'ask',
  selection: null,
  compaction: null,
  gateway: { peersEnabled: false, artifactsEnabled: false, desktopBridgeEnabled: false },
})
const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false
  )

let dir = ''
const runtimes: EnvironmentRuntime[] = []
const servers: Array<import('node:http').Server> = []

/** One environment of a server: its own data folder, home folder and database, as each container has. */
async function environment(name: string, before?: (userData: string) => Promise<void>) {
  const userData = path.join(dir, name, 'user-data')
  const home = path.join(dir, name, 'home')
  await mkdir(userData, { recursive: true })
  await mkdir(home, { recursive: true })
  await before?.(userData)
  vi.spyOn(app, 'getPath').mockReturnValue(userData)
  freshDb()
  const deps = {
    config: parseBotInstanceConfig({
      MAESTRLY_BOT_MODE: '1',
      MAESTRLY_BOT_CONTROL_TOKEN: randomBytes(32).toString('base64url'),
      MAESTRLY_BOT_GATEWAY_URL: 'http://gateway.test',
      MAESTRLY_ENVIRONMENT_ID: name,
    })!,
    userData,
    home,
    displays: {
      startBot: vi.fn(async (botId: string, slot: number) => ({
        botId,
        slot,
        display: `:${slot}`,
        width: 1280 as const,
        height: 800 as const,
        env: { DISPLAY: `:${slot}` },
        browserArea: fleetEnvironmentTile(slot),
      })),
      stopBot: vi.fn(async (_botId: string) => {}),
      redecorate: vi.fn(async (_botId: string) => {}),
      acquireScreen: vi.fn(async (surface: DisplaySurface) => ({
        session: { surface } as unknown as ScreenSession,
        release: vi.fn(),
      })),
      dispose: vi.fn(async () => {}),
    },
    floatBrowser: vi.fn(),
    closeConversation: vi.fn(async (_conversationId: string) => {}),
    purgeConversation: vi.fn(async (conversationId: string) => {
      deleteConversation(conversationId)
    }),
    openSettings: vi.fn(),
    holdScreenFocus: vi.fn((_owner: ScreenFocusOwner | null) => vi.fn()),
  } as unknown as EnvironmentRuntimeDeps
  const runtime = new EnvironmentRuntime(deps)
  runtimes.push(runtime)
  await runtime.start()
  const server = createInstanceControlServer(deps.config, runtime)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const headers = { 'X-Maestrly-Fleet-Protocol': '1', Authorization: `Bearer ${deps.config.controlToken}` }
  const request = (method: string, route: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}) =>
    fetch(base + route, {
      method,
      headers: { ...headers, ...init.headers },
      body: init.body,
      ...(init.body instanceof ReadableStream ? { duplex: 'half' } : {}),
    } as RequestInit)
  return { runtime, deps, userData, home, request }
}
type Environment = Awaited<ReturnType<typeof environment>>

/** Leaves an environment as its container would: its process ends and its database closes. */
async function leave(env: Environment) {
  await env.runtime.dispose()
  closeDb()
}

/** A bot with something of everything that moves with it, and the things that do not. */
async function seededBot(env: Environment) {
  await env.runtime.installBot({ profile: profile('alpha', 'Alpha'), slot: 1, gatewayToken: 'g'.repeat(24) })
  await env.runtime.installBot({ profile: profile('beta', 'Beta'), slot: 2, gatewayToken: 'h'.repeat(24) })
  const conversationId = env.runtime.bot('alpha').primaryConversationId!
  for (const [index, text] of ['Find the invoice', 'Found it in the portal'].entries())
    upsertChatMessage({
      id: `message-${index}`,
      conversationId,
      role: index ? 'assistant' : 'user',
      createdAt: 1_000 + index,
      parts: [{ type: 'text', id: `part-${index}`, text }],
    })
  createLocalMemory({
    workspaceId: 'bot-self:alpha',
    title: 'Portal',
    content: 'Invoices are under Billing.',
    type: 'reference',
    source: 'agent',
  })
  writeBotPaused('alpha', true)
  const cwd = getConversation(conversationId)!.cwd
  const files: Record<string, string | Buffer> = {
    [path.join(cwd, 'report.md')]: '# Report\n',
    [path.join(cwd, '.agents', 'notes', 'plan.md')]: 'Plan\n',
    [path.join(attachmentConversationDir(conversationId), 'shot.png')]: Buffer.from([137, 80, 78, 71]),
    [path.join(env.userData, 'fleet-images', 'alpha', 'tool.png')]: Buffer.from([1, 2, 3]),
    [path.join(env.userData, 'fleet-inputs', 'alpha', 'input.pdf')]: '%PDF-1.7',
    [path.join(env.home, '.config', 'maestrly-bots', 'alpha', 'chromium', 'Default', 'Cookies')]: 'cookies',
    [path.join(env.home, '.config', 'maestrly-bots', 'alpha', 'chromium', 'Default', 'Cache', 'data_0')]: 'cache',
    [path.join(env.home, '.cache', 'maestrly-bots', 'alpha', 'wallpaper.png')]: 'wallpaper',
    [path.join(env.home, '.config', 'shared-tool', 'settings.json')]: '{}',
  }
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  await symlink('/etc/hostname', path.join(cwd, 'outside'))
  return { conversationId, cwd }
}

async function exported(env: Environment, into: string) {
  const response = await env.request('GET', '/v1/bots/alpha/export')
  expect(response.status).toBe(200)
  const bytes = Buffer.from(await response.arrayBuffer())
  expect(Number(response.headers.get('content-length'))).toBe(bytes.length)
  const sha256 = response.headers.get('x-maestrly-package-sha256')!
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256)
  await writeFile(into, bytes)
  return { file: into, size: bytes.length, sha256 }
}
function upload(env: Environment, pkg: { file: string; size: number; sha256: string }, query = '?replace=1') {
  return env.request('PUT', '/v1/bots/alpha/import' + query, {
    body: Readable.toWeb(createReadStream(pkg.file)) as ReadableStream,
    headers: {
      'content-length': String(pkg.size),
      'content-type': 'application/zstd',
      'x-maestrly-package-sha256': pkg.sha256,
    },
  })
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'fleet-bot-move-'))
  vi.spyOn(chatService, 'listChatRunnerCapabilities').mockResolvedValue([model])
  vi.spyOn(chatService, 'effectiveModelMeta').mockResolvedValue({ meta: null })
  vi.spyOn(chatService, 'setConversationCompactionOverride').mockImplementation(() => {})
  vi.spyOn(chatService, 'primeChatTurnSelection').mockImplementation(() => undefined as never)
  vi.spyOn(chatService, 'publishConvChatSettings').mockImplementation(() => undefined as never)
  vi.spyOn(chatService, 'backgroundCompactionStatus').mockReturnValue({ revision: 0, status: 'idle' })
  vi.spyOn(chatService, 'stopChatAndWait').mockImplementation(async () => undefined as never)
})
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
  vi.restoreAllMocks()
  closeDb()
  await rm(dir, { recursive: true, force: true })
})

describe('moving a bot between environments', () => {
  it('freezes, exports and imports a bot with everything that is its own, under the same ids', async () => {
    const work = await environment('work')
    const { conversationId } = await seededBot(work)
    const frozen = await work.request('POST', '/v1/bots/alpha/freeze')
    expect(frozen.status).toBe(200)
    const { digest } = await frozen.json()
    expect(digest).toMatchObject({ conversationId, messages: 2, memories: 1 })
    // Frozen: uninstalled and not recreated by a restart, its sibling untouched.
    expect(work.runtime.bots().map((bot) => bot.botId)).toEqual(['beta'])
    expect(JSON.parse(getAppSetting('fleet.instance.bots') ?? '[]')).toEqual([{ botId: 'beta', slot: 2 }])
    expect(work.deps.closeConversation).toHaveBeenCalledWith(conversationId)
    expect((await (await work.request('POST', '/v1/bots/alpha/freeze')).json()).digest).toEqual(digest)
    const pkg = await exported(work, path.join(dir, 'alpha.tar.zst'))
    // The export kept no copy: its staging folder goes once the package was sent.
    await vi.waitFor(async () => expect(await readdir(path.join(work.userData, 'bot-moves'))).toEqual([]))
    await leave(work)

    const home = await environment('home')
    const imported = await upload(home, pkg)
    expect(imported.status).toBe(200)
    expect((await imported.json()).digest).toEqual(digest)
    // Imported, not installed: the gateway installs it once the move commits.
    expect(home.runtime.bots()).toEqual([])
    expect(JSON.parse(getAppSetting('fleet.instance.bots.alpha.profile')!)).toMatchObject({
      primaryConversationId: conversationId,
      profile: { botId: 'alpha', name: 'Alpha' },
    })
    expect(getAppSetting('fleet.instance.bots.alpha.paused')).toBe('1')
    expect(getAppSetting('fleet.instance.bots.alpha.gatewayToken')).toBeNull()
    const conversation = getConversation(conversationId)!
    expect(conversation).toMatchObject({ scope: 'standalone', status: 'idle' })
    // The folder is named from the resolved data folder; macOS's temporary folder is behind a symbolic link.
    expect(conversation.cwd).toBe(path.join(await realpath(home.userData), 'standalone-chats', conversationId))
    expect(await readFile(path.join(conversation.cwd, 'report.md'), 'utf8')).toBe('# Report\n')
    expect(await readFile(path.join(conversation.cwd, '.agents', 'notes', 'plan.md'), 'utf8')).toBe('Plan\n')
    expect(await exists(path.join(conversation.cwd, 'outside'))).toBe(false)
    if (process.platform !== 'win32') expect((await stat(conversation.cwd)).mode & 0o777).toBe(0o700)
    expect(await readFile(path.join(attachmentConversationDir(conversationId), 'shot.png'))).toEqual(
      Buffer.from([137, 80, 78, 71])
    )
    const browser = path.join(home.home, '.config', 'maestrly-bots', 'alpha', 'chromium', 'Default')
    expect(await readFile(path.join(browser, 'Cookies'), 'utf8')).toBe('cookies')
    // Caches are made again where the bot runs, and what the environment shares never travels.
    expect(await exists(path.join(browser, 'Cache'))).toBe(false)
    expect(await exists(path.join(home.home, '.cache', 'maestrly-bots', 'alpha'))).toBe(false)
    expect(await exists(path.join(home.home, '.config', 'shared-tool'))).toBe(false)
    expect(await readFile(path.join(home.userData, 'fleet-images', 'alpha', 'tool.png'))).toEqual(
      Buffer.from([1, 2, 3])
    )
    expect(listLocalMemories('bot-self:alpha').map((memory) => memory.title)).toEqual(['Portal'])

    // Installed, it runs on its own conversation, paused as it was.
    await home.runtime.installBot({ profile: profile('alpha', 'Alpha'), slot: 1, gatewayToken: 'g'.repeat(24) })
    const alpha = home.runtime.bot('alpha')
    expect(alpha.primaryConversationId).toBe(conversationId)
    expect((await alpha.status()).hold).toMatchObject({ state: 'held', reason: 'paused' })
    const texts = (await alpha.transcript(null, 50)).items.flatMap((item) =>
      item.kind === 'user' || item.kind === 'assistant' ? [item.text] : []
    )
    expect(texts).toEqual(expect.arrayContaining(['Find the invoice', 'Found it in the portal']))
  })

  it('refuses an export of an installed bot, and imports over a bot installed or held without replace', async () => {
    const work = await environment('work')
    await seededBot(work)
    expect((await work.request('GET', '/v1/bots/alpha/export')).status).toBe(409)
    expect((await work.request('GET', '/v1/bots/ghost/export')).status).toBe(404)
    expect((await work.request('POST', '/v1/bots/ghost/freeze')).status).toBe(404)
    await work.request('POST', '/v1/bots/alpha/freeze')
    const pkg = await exported(work, path.join(dir, 'alpha.tar.zst'))
    // Back where it was: a frozen bot comes back with an install.
    await work.runtime.installBot({ profile: profile('alpha', 'Alpha'), slot: 1, gatewayToken: 'g'.repeat(24) })
    expect((await upload(work, pkg)).status).toBe(409)
    expect(work.runtime.bot('alpha').primaryConversationId).not.toBeNull()

    // Held but not installed (as an earlier move left it): replaced only when asked.
    await work.runtime.uninstallBot('alpha', { purge: false })
    const refused = await upload(work, pkg, '')
    expect(refused.status).toBe(409)
    expect((await upload(work, pkg)).status).toBe(200)
  })

  it('refuses a package that is not what was sent and writes nothing of it', async () => {
    const work = await environment('work')
    await seededBot(work)
    await work.request('POST', '/v1/bots/alpha/freeze')
    const pkg = await exported(work, path.join(dir, 'alpha.tar.zst'))
    await leave(work)

    // A package a stopped process left goes when the environment starts.
    const home = await environment('home', async (userData) => {
      await mkdir(path.join(userData, 'bot-moves', 'interrupted'), { recursive: true })
      await writeFile(path.join(userData, 'bot-moves', 'interrupted', 'bot.tar.zst'), 'partial')
    })
    expect(await exists(path.join(home.userData, 'bot-moves'))).toBe(false)
    const wrongDigest = await upload(home, { ...pkg, sha256: '0'.repeat(64) })
    expect(wrongDigest.status).toBe(400)
    // Bytes that hash as announced, but are not a whole package.
    const bytes = (await readFile(pkg.file)).subarray(0, Math.floor(pkg.size / 2))
    const corrupted = path.join(dir, 'corrupted.tar.zst')
    await writeFile(corrupted, bytes)
    const tampered = await upload(home, {
      file: corrupted,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
    expect(tampered.status).toBe(400)
    const unannounced = await home.request('PUT', '/v1/bots/alpha/import', { body: 'x' })
    expect(unannounced.status).toBe(400)
    expect(getAppSetting('fleet.instance.bots.alpha.profile')).toBeNull()
    expect(listLocalMemories('bot-self:alpha')).toEqual([])
    for (const folder of [
      path.join(home.userData, 'fleet-images', 'alpha'),
      path.join(home.home, '.config', 'maestrly-bots', 'alpha'),
      path.join(home.userData, 'standalone-chats'),
    ])
      expect(await exists(folder), folder).toBe(false)
  })

  it('deletes what an import wrote when it cannot finish, and leaves the rest of the environment alone', async () => {
    const work = await environment('work')
    const { conversationId } = await seededBot(work)
    await work.request('POST', '/v1/bots/alpha/freeze')
    const pkg = await exported(work, path.join(dir, 'alpha.tar.zst'))
    await leave(work)

    const home = await environment('home')
    await home.runtime.installBot({ profile: profile('gamma', 'Gamma'), slot: 1, gatewayToken: 'k'.repeat(24) })
    // The folder of every bot's browser profile cannot be made: the import fails after its conversation went in.
    const profiles = path.join(home.home, '.config', 'maestrly-bots')
    await mkdir(path.dirname(profiles), { recursive: true })
    await writeFile(profiles, 'not a folder')
    const blocked = await upload(home, pkg)
    expect(blocked.status).toBe(500)
    expect(getConversation(conversationId)).toBeUndefined()
    expect(getAppSetting('fleet.instance.bots.alpha.profile')).toBeNull()
    expect(getAppSetting('fleet.instance.bots.alpha.paused')).toBeNull()
    expect(listLocalMemories('bot-self:alpha')).toEqual([])
    expect(await exists(path.join(home.userData, 'standalone-chats', conversationId))).toBe(false)
    expect(await exists(path.join(home.userData, 'fleet-images', 'alpha'))).toBe(false)
    expect(home.runtime.bots().map((bot) => bot.botId)).toEqual(['gamma'])
    expect(getConversation(home.runtime.bot('gamma').primaryConversationId!)).toBeDefined()
    // Nothing is left in the way: the same package imports once the obstacle is gone, without replacing anything.
    await rm(profiles)
    expect((await upload(home, pkg, '')).status).toBe(200)
  })
})
