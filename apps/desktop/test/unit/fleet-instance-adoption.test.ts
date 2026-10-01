import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fleetEnvironmentTile } from '@maestrly/bot-fleet-protocol'
import { app } from 'electron'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import * as chatService from '../../src/main/chat/service'
import { adoptLegacyBot } from '../../src/main/fleet/instance/adoption'
import { EnvironmentRuntime } from '../../src/main/fleet/instance/environment'
import { parseBotInstanceConfig } from '../../src/main/fleet/instance/config'
import { readInstalledBots } from '../../src/main/fleet/instance/registry'
import { InstanceInputQueue } from '../../src/main/fleet/instance/queue'
import { InstanceTranscriptExtras } from '../../src/main/fleet/instance/transcript'
import { FleetImageStore } from '../../src/main/fleet/instance/images'
import { clearEphemeralToolImages, mcpResultToChatToolOutput } from '../../src/main/chat/tool-output'
import { createLocalMemory, listLocalMemories } from '../../src/main/memory/local-memory-service'
import { memorySpaceForConversation } from '../../src/main/memory/spaces'
import { getAppSetting, getDb, setAppSetting } from '../../src/main/store'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==',
  'base64'
)
const legacyProfile = (conversationId: string) => ({
  profile: {
    botId: 'scout',
    name: 'Scout',
    instructions: 'Track updates.',
    ceiling: 'ask',
    selection: null,
    compaction: null,
    gateway: { peersEnabled: true, artifactsEnabled: false },
  },
  primaryConversationId: conversationId,
})
const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false
  )

let dir = ''
let userData = ''
beforeEach(async () => {
  freshDb()
  dir = await mkdtemp(path.join(os.tmpdir(), 'fleet-adoption-'))
  userData = path.join(dir, 'user-data')
  await mkdir(userData, { recursive: true })
})
afterEach(async () => {
  clearEphemeralToolImages()
  vi.restoreAllMocks()
  closeDb()
  await rm(dir, { recursive: true, force: true })
})

async function legacyInstance() {
  const conversation = makeConversation(makeWorkspace().id)
  setAppSetting('fleet.instance.profile', JSON.stringify(legacyProfile(conversation.id)))
  setAppSetting('fleet.instance.paused', '1')
  const queue = new InstanceInputQueue(
    path.join(userData, 'fleet-instance', 'inputs.json'),
    path.join(userData, 'fleet-inputs')
  )
  const receipt = await queue.enqueue({
    idempotencyKey: randomUUID(),
    source: 'owner',
    text: 'Queued before the update',
    attachments: [{ name: 'shot.png', mediaType: 'image/png', dataBase64: png.toString('base64') }],
  })
  const extras = new InstanceTranscriptExtras(path.join(userData, 'fleet-instance', 'transcript.json'), () => {})
  await extras.upsert({
    kind: 'system',
    id: 'system:legacy',
    at: '2026-09-20T10:00:00.000Z',
    code: 'created',
    text: null,
    durationMs: null,
  })
  const images = new FleetImageStore(path.join(userData, 'fleet-images'))
  const output = mcpResultToChatToolOutput({
    content: [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }],
  })
  const ref = await images.capture(output.images![0])
  const own = createLocalMemory({
    workspaceId: 'bot-self',
    title: 'Portal',
    content: 'Open the portal first.',
    type: 'procedure',
    source: 'agent',
  }).memory
  const other = createLocalMemory({
    workspaceId: 'another-space',
    title: 'Other',
    content: 'Another fact.',
    type: 'reference',
    source: 'user',
  }).memory
  const now = Date.now()
  getDb()
    .prepare('INSERT INTO memory_consolidation_state (space_id, auto_created_since, updated_at) VALUES (?, ?, ?)')
    .run('bot-self', 3, now)
  getDb()
    .prepare(
      'INSERT INTO conversation_memory_state (conversation_id, space_id, core_epoch, core_text, updated_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(conversation.id, 'bot-self', 'epoch', 'core', now)
  getDb()
    .prepare('INSERT INTO memory_extraction_state (conversation_id, space_id, updated_at) VALUES (?, ?, ?)')
    .run(conversation.id, 'bot-self', now)
  return { conversation, receipt, imageId: ref!.id, own, other }
}

async function tree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const walk = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      const name = path.relative(root, full).split(path.sep).join('/')
      if (entry.isDirectory()) {
        out[name + '/'] = 'folder'
        await walk(full)
      } else
        out[name] = createHash('sha256')
          .update(await readFile(full))
          .digest('hex')
    }
  }
  await walk(root)
  return out
}
const settings = () =>
  getDb().prepare("SELECT key, value FROM app_settings WHERE key LIKE 'fleet.%' ORDER BY key").all()
const memoryRows = () => getDb().prepare('SELECT id, workspace_id FROM local_memories ORDER BY id').all()
const spaces = () => ({
  consolidation: getDb().prepare('SELECT space_id FROM memory_consolidation_state').all(),
  conversation: getDb().prepare('SELECT space_id FROM conversation_memory_state').all(),
  extraction: getDb().prepare('SELECT space_id FROM memory_extraction_state').all(),
})
const snapshot = async () => ({
  files: await tree(userData),
  settings: settings(),
  memories: memoryRows(),
  spaces: spaces(),
})

async function expectAdopted(legacy: Awaited<ReturnType<typeof legacyInstance>>) {
  expect(readInstalledBots()).toEqual([{ botId: 'scout', slot: 1 }])
  expect(JSON.parse(getAppSetting('fleet.instance.bots.scout.profile') ?? 'null')).toEqual(
    legacyProfile(legacy.conversation.id)
  )
  expect(getAppSetting('fleet.instance.bots.scout.paused')).toBe('1')
  expect(getAppSetting('fleet.instance.bots.scout.gatewayToken')).toBeNull()
  expect(getAppSetting('fleet.instance.profile')).toBeNull()
  expect(getAppSetting('fleet.instance.paused')).toBeNull()
  const queue = new InstanceInputQueue(
    path.join(userData, 'fleet-instance', 'bots', 'scout', 'inputs.json'),
    path.join(userData, 'fleet-inputs', 'scout')
  )
  await queue.load()
  expect(queue.list().map((item) => item.id)).toEqual([legacy.receipt.inputId])
  expect((await queue.readAttachments(queue.list()[0]))[0].bytes).toEqual(png)
  const extras = new InstanceTranscriptExtras(
    path.join(userData, 'fleet-instance', 'bots', 'scout', 'transcript.json'),
    () => {}
  )
  await extras.load()
  expect(extras.list()).toMatchObject([{ id: 'system:legacy', code: 'created' }])
  clearEphemeralToolImages()
  const images = new FleetImageStore(path.join(userData, 'fleet-images', 'scout'))
  await images.load()
  expect((await images.read(legacy.imageId, legacy.conversation.id, []))?.bytes).toEqual(png)
  expect(listLocalMemories('bot-self')).toEqual([])
  expect(listLocalMemories('bot-self:scout').map((memory) => memory.id)).toEqual([legacy.own.id])
  expect(listLocalMemories('another-space').map((memory) => memory.id)).toEqual([legacy.other.id])
  expect(spaces()).toEqual({
    consolidation: [{ space_id: 'bot-self:scout' }],
    conversation: [{ space_id: 'bot-self:scout' }],
    extraction: [{ space_id: 'bot-self:scout' }],
  })
  for (const legacyPath of [
    'fleet-instance/inputs.json',
    'fleet-instance/transcript.json',
    `fleet-inputs/${legacy.receipt.inputId}`,
    'fleet-images/index.json',
    `fleet-images/${legacy.imageId}`,
  ])
    expect(await exists(path.join(userData, legacyPath))).toBe(false)
}

describe('legacy single-bot adoption', () => {
  it('does nothing on an instance without a legacy bot', async () => {
    expect(await adoptLegacyBot({ userData })).toEqual({ adopted: false })
    expect(await tree(userData)).toEqual({})
    expect(settings()).toEqual([])
  })

  it('moves a single-bot instance into the per-bot layout, and a second run changes nothing', async () => {
    const legacy = await legacyInstance()
    expect(await adoptLegacyBot({ userData })).toEqual({ adopted: true, botId: 'scout' })
    await expectAdopted(legacy)
    const before = await snapshot()
    expect(await adoptLegacyBot({ userData })).toEqual({ adopted: false })
    expect(await snapshot()).toEqual(before)
  })

  it('keeps the legacy instance intact when a file cannot be moved, then completes on retry', async () => {
    const legacy = await legacyInstance()
    const before = await snapshot()
    await writeFile(path.join(userData, 'fleet-instance', 'bots'), 'not a folder')
    await expect(adoptLegacyBot({ userData })).rejects.toThrow()
    const after = await snapshot()
    expect(after.settings).toEqual(before.settings)
    expect(after.memories).toEqual(before.memories)
    expect(after.spaces).toEqual(before.spaces)
    expect(after.files).toMatchObject(before.files)
    await rm(path.join(userData, 'fleet-instance', 'bots'))
    expect(await adoptLegacyBot({ userData })).toEqual({ adopted: true, botId: 'scout' })
    await expectAdopted(legacy)
  })

  it('rolls the database back when the commit fails, then completes on retry', async () => {
    const legacy = await legacyInstance()
    const before = await snapshot()
    getDb().exec(
      "CREATE TRIGGER synthetic_rekey_failure BEFORE UPDATE ON local_memories BEGIN SELECT RAISE(ABORT, 'synthetic rekey failure'); END"
    )
    await expect(adoptLegacyBot({ userData })).rejects.toThrow('synthetic rekey failure')
    const after = await snapshot()
    expect(after.settings).toEqual(before.settings)
    expect(after.memories).toEqual(before.memories)
    expect(after.spaces).toEqual(before.spaces)
    expect(after.files).toMatchObject(before.files)
    getDb().exec('DROP TRIGGER synthetic_rekey_failure')
    expect(await adoptLegacyBot({ userData })).toEqual({ adopted: true, botId: 'scout' })
    await expectAdopted(legacy)
  })

  it('replaces stale copies left by an interrupted attempt with the legacy data', async () => {
    const legacy = await legacyInstance()
    const staged = path.join(userData, 'fleet-instance', 'bots', 'scout')
    await mkdir(staged, { recursive: true })
    await writeFile(path.join(staged, 'inputs.json'), JSON.stringify({ items: [] }))
    await mkdir(path.join(userData, 'fleet-inputs', 'scout', legacy.receipt.inputId), { recursive: true })
    await writeFile(path.join(userData, 'fleet-inputs', 'scout', legacy.receipt.inputId, '0.png'), 'partial')
    await mkdir(path.join(userData, 'fleet-images', 'scout'), { recursive: true })
    await writeFile(path.join(userData, 'fleet-images', 'scout', 'index.json'), '[]')
    expect(await adoptLegacyBot({ userData })).toEqual({ adopted: true, botId: 'scout' })
    await expectAdopted(legacy)
  })

  it('removes legacy leftovers of a committed adoption and never touches the adopted data', async () => {
    const legacy = await legacyInstance()
    expect(await adoptLegacyBot({ userData })).toEqual({ adopted: true, botId: 'scout' })
    const adopted = await snapshot()
    await writeFile(path.join(userData, 'fleet-instance', 'inputs.json'), JSON.stringify({ items: [] }))
    await mkdir(path.join(userData, 'fleet-inputs', legacy.receipt.inputId), { recursive: true })
    await writeFile(path.join(userData, 'fleet-inputs', legacy.receipt.inputId, '0.png'), png)
    await writeFile(path.join(userData, 'fleet-images', legacy.imageId), png)
    expect(await adoptLegacyBot({ userData })).toEqual({ adopted: false })
    expect(await snapshot()).toEqual(adopted)
    await expectAdopted(legacy)
  })

  it('leaves the legacy settings alone when bots are already installed', async () => {
    await legacyInstance()
    setAppSetting('fleet.instance.bots', JSON.stringify([{ botId: 'other', slot: 2 }]))
    const before = await snapshot()
    expect(await adoptLegacyBot({ userData })).toEqual({ adopted: false })
    expect(await snapshot()).toEqual(before)
  })

  it('refuses an unreadable legacy profile without changing anything', async () => {
    setAppSetting('fleet.instance.profile', '{"profile":{"botId":"Not Valid"}}')
    const before = await snapshot()
    await expect(adoptLegacyBot({ userData })).rejects.toThrow('Invalid persisted bot instance profile.')
    expect(await snapshot()).toEqual(before)
  })

  it('starts the adopted bot in slot 1 without a gateway token until the gateway installs it', async () => {
    const legacy = await legacyInstance()
    vi.spyOn(app, 'getPath').mockReturnValue(userData)
    vi.spyOn(chatService, 'listChatRunnerCapabilities').mockResolvedValue([])
    vi.spyOn(chatService, 'effectiveModelMeta').mockResolvedValue({ meta: null })
    vi.spyOn(chatService, 'setConversationCompactionOverride').mockImplementation(() => {})
    vi.spyOn(chatService, 'primeChatTurnSelection').mockImplementation(() => undefined as never)
    vi.spyOn(chatService, 'publishConvChatSettings').mockImplementation(() => undefined as never)
    vi.spyOn(chatService, 'backgroundCompactionStatus').mockReturnValue({ revision: 0, status: 'idle' })
    vi.spyOn(chatService, 'stopChatAndWait').mockImplementation(async () => undefined as never)
    const startBot = vi.fn(async (botId: string, slot: number) => ({
      botId,
      slot,
      display: `:${slot}`,
      width: 1280 as const,
      height: 800 as const,
      env: {
        DISPLAY: `:${slot}`,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=/home/synthetic/.cache/maestrly-bots/${botId}/bus`,
        BROWSER: '/usr/local/bin/maestrly-bot-browser',
        MAESTRLY_BOT_BROWSER_PROFILE: `/home/synthetic/.config/maestrly-bots/${botId}/chromium`,
      },
      browserArea: fleetEnvironmentTile(slot),
    }))
    const runtime = new EnvironmentRuntime({
      config: parseBotInstanceConfig({
        MAESTRLY_BOT_MODE: '1',
        MAESTRLY_BOT_CONTROL_TOKEN: randomBytes(32).toString('base64url'),
        MAESTRLY_BOT_GATEWAY_URL: 'http://gateway.test',
      })!,
      userData,
      home: path.join(dir, 'home'),
      displays: {
        startBot,
        stopBot: vi.fn(async () => {}),
        acquireVnc: vi.fn(async () => ({ port: 5903, release: () => {} })),
        dispose: vi.fn(async () => {}),
      },
      floatBrowser: vi.fn(),
      closeConversation: vi.fn(async () => {}),
      purgeConversation: vi.fn(async () => {}),
      openSettings: vi.fn(),
      holdScreenFocus: vi.fn(() => () => {}),
    })
    try {
      await runtime.start()
      const bot = runtime.bot('scout')
      expect(bot.slot).toBe(1)
      expect(startBot).toHaveBeenCalledWith('scout', 1)
      expect(bot.primaryConversationId).toBe(legacy.conversation.id)
      expect(bot.gatewayConfig).toBeNull()
      expect(memorySpaceForConversation(legacy.conversation.id)?.id).toBe('bot-self:scout')
      const status = await bot.status()
      expect(status.hold).toMatchObject({ state: 'held', reason: 'paused' })
      expect(status.queue.map((item) => item.inputId)).toEqual([legacy.receipt.inputId])
      await runtime.installBot({
        profile: legacyProfile(legacy.conversation.id).profile as never,
        slot: 1,
        gatewayToken: 'synthetic-gateway-token-scout',
      })
      expect(runtime.bot('scout').primaryConversationId).toBe(legacy.conversation.id)
      expect(runtime.bot('scout').gatewayConfig).toEqual({
        url: 'http://gateway.test/',
        token: 'synthetic-gateway-token-scout',
      })
    } finally {
      await runtime.dispose()
    }
  })
})
