import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  fleetEnvironmentTile,
  fleetInstanceEnvironmentStatusSchema,
  type FleetInstanceProfile,
} from '@maestrly/bot-fleet-protocol'
import { app } from 'electron'
import { closeDb, freshDb, restartDb } from '../helpers/db'

const screenActions = vi.hoisted(() => ({ aborted: [] as Array<string | undefined> }))
vi.mock('../../src/main/mcp/tools/computer', async (original) => ({
  ...(await original<typeof import('../../src/main/mcp/tools/computer')>()),
  abortScreenActions: (conversationId?: string) => {
    screenActions.aborted.push(conversationId)
  },
}))

import * as chatService from '../../src/main/chat/service'
import {
  EnvironmentRuntime,
  productionDisplayDeps,
  type EnvironmentRuntimeDeps,
} from '../../src/main/fleet/instance/environment'
import { botRuntimeForConversation, getEnvironmentRuntime } from '../../src/main/fleet/instance'
import { parseBotInstanceConfig } from '../../src/main/fleet/instance/config'
import { botIdentityPrompt } from '../../src/main/fleet/instance/identity'
import { gateInstanceAppTool } from '../../src/main/fleet/instance/gate'
import { InstanceHttpError } from '../../src/main/fleet/instance/server'
import { registerBotModeTools } from '../../src/main/mcp/tools/bot-instance'
import { conversationScreen } from '../../src/main/conversation-screen'
import { conversationShellEnv } from '../../src/main/chat/conversation-env'
import { memorySpaceForConversation } from '../../src/main/memory/spaces'
import { createLocalMemory, listLocalMemories } from '../../src/main/memory/local-memory-service'
import { deleteConversation, getAppSetting, getConversation, setAppSetting } from '../../src/main/store'

const model = {
  providerId: 'synthetic',
  providerLabel: 'Synthetic',
  modelId: 'model-a',
  reasoningEfforts: ['low', 'high'],
  fastMode: false,
}
const tokenA = 'synthetic-gateway-token-alpha'
const tokenB = 'synthetic-gateway-token-beta'
const profile = (botId: string, name: string, extra: Partial<FleetInstanceProfile> = {}): FleetInstanceProfile => ({
  botId,
  name,
  instructions: `Work as ${name}.`,
  ceiling: 'ask',
  selection: null,
  compaction: null,
  gateway: { peersEnabled: true },
  ...extra,
})
const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false
  )
const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms))

function fakeDisplays(home: string) {
  return {
    startBot: vi.fn(async (botId: string, slot: number) => ({
      botId,
      slot,
      display: `:${slot}`,
      width: 1280 as const,
      height: 800 as const,
      env: {
        DISPLAY: `:${slot}`,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${home}/.cache/maestrly-bots/${botId}/bus`,
        BROWSER: '/usr/local/bin/maestrly-bot-browser',
        MAESTRLY_BOT_BROWSER_PROFILE: `${home}/.config/maestrly-bots/${botId}/chromium`,
      },
      browserArea: fleetEnvironmentTile(slot),
    })),
    stopBot: vi.fn(async (_botId: string) => {}),
    dispose: vi.fn(async () => {}),
  }
}

let dir = ''
let userData = ''
let home = ''
const environments: EnvironmentRuntime[] = []
let override: MockInstance<typeof chatService.setConversationCompactionOverride>
let globalConfig: MockInstance<typeof chatService.setBackgroundCompactionConfig>

function environment(displays = fakeDisplays(home)) {
  const deps = {
    config: parseBotInstanceConfig({
      MAESTRLY_BOT_MODE: '1',
      MAESTRLY_BOT_CONTROL_TOKEN: randomBytes(32).toString('base64url'),
      MAESTRLY_BOT_GATEWAY_URL: 'http://gateway.test',
      MAESTRLY_ENVIRONMENT_ID: 'env-one',
    })!,
    userData,
    home,
    displays,
    floatBrowser: vi.fn(),
    closeConversation: vi.fn(async (_conversationId: string) => {}),
    purgeConversation: vi.fn(async (conversationId: string) => {
      deleteConversation(conversationId)
    }),
    openSettings: vi.fn(),
  } satisfies EnvironmentRuntimeDeps
  const runtime = new EnvironmentRuntime(deps)
  environments.push(runtime)
  return { runtime, deps, displays }
}

async function twoBots() {
  const setup = environment()
  await setup.runtime.start()
  await setup.runtime.installBot({ profile: profile('alpha', 'Alpha'), slot: 1, gatewayToken: tokenA })
  await setup.runtime.installBot({ profile: profile('beta', 'Beta'), slot: 2, gatewayToken: tokenB })
  const a = setup.runtime.bot('alpha')
  const b = setup.runtime.bot('beta')
  return { ...setup, a, b, convA: a.primaryConversationId!, convB: b.primaryConversationId! }
}

beforeEach(async () => {
  freshDb()
  dir = await mkdtemp(path.join(os.tmpdir(), 'fleet-environment-'))
  userData = path.join(dir, 'user-data')
  home = path.join(dir, 'home')
  await mkdir(userData, { recursive: true })
  await mkdir(home, { recursive: true })
  vi.spyOn(app, 'getPath').mockReturnValue(userData)
  screenActions.aborted.length = 0
  vi.spyOn(chatService, 'listChatRunnerCapabilities').mockResolvedValue([model])
  vi.spyOn(chatService, 'effectiveModelMeta').mockResolvedValue({ meta: null })
  override = vi.spyOn(chatService, 'setConversationCompactionOverride').mockImplementation(() => {})
  globalConfig = vi.spyOn(chatService, 'setBackgroundCompactionConfig')
  vi.spyOn(chatService, 'primeChatTurnSelection').mockImplementation(() => undefined as never)
  vi.spyOn(chatService, 'publishConvChatSettings').mockImplementation(() => undefined as never)
  vi.spyOn(chatService, 'backgroundCompactionStatus').mockReturnValue({ revision: 0, status: 'idle' })
  vi.spyOn(chatService, 'stopChatAndWait').mockImplementation(async () => undefined as never)
})
afterEach(async () => {
  for (const runtime of environments.splice(0)) await runtime.dispose()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  closeDb()
  await rm(dir, { recursive: true, force: true })
})

describe('bot environment registry', () => {
  it('keeps two bots apart: conversations, storage, memory spaces, screens, events and tokens', async () => {
    const { runtime, a, b, convA, convB, displays } = await twoBots()
    expect(runtime.bots().map((bot) => bot.botId)).toEqual(['alpha', 'beta'])
    expect(getEnvironmentRuntime()).toBe(runtime)
    expect(convA).not.toBe(convB)
    expect(getConversation(convA)?.cwd).not.toBe(getConversation(convB)?.cwd)
    expect(botRuntimeForConversation(convA)).toBe(a)
    expect(botRuntimeForConversation(convB)).toBe(b)
    expect(botRuntimeForConversation('another-conversation')).toBeNull()
    expect(botRuntimeForConversation(undefined)).toBeNull()
    expect(a.gatewayConfig).toEqual({ url: 'http://gateway.test/', token: tokenA })
    expect(b.gatewayConfig).toEqual({ url: 'http://gateway.test/', token: tokenB })
    expect(memorySpaceForConversation(convA)).toEqual({ id: 'bot-self:alpha', kind: 'bot', roots: [] })
    expect(memorySpaceForConversation(convB)).toEqual({ id: 'bot-self:beta', kind: 'bot', roots: [] })
    expect(displays.startBot.mock.calls).toEqual([
      ['alpha', 1],
      ['beta', 2],
    ])
    expect(conversationScreen(convA)).toEqual({
      display: ':1',
      width: 1280,
      height: 800,
      windowArea: fleetEnvironmentTile(1),
    })
    expect(conversationScreen(convB)).toEqual({
      display: ':2',
      width: 1280,
      height: 800,
      windowArea: fleetEnvironmentTile(2),
    })
    expect(conversationShellEnv(convA)).toMatchObject({
      DISPLAY: ':1',
      MAESTRLY_BOT_BROWSER_PROFILE: `${home}/.config/maestrly-bots/alpha/chromium`,
    })
    expect(conversationShellEnv(convB)).toMatchObject({ DISPLAY: ':2' })

    // No compaction model: the bots queue work without starting turns.
    await a.input({ idempotencyKey: randomUUID(), source: 'owner', text: 'Only for Alpha', attachments: [] })
    expect((await a.status()).queue).toHaveLength(1)
    expect((await b.status()).queue).toHaveLength(0)
    const stored = JSON.parse(
      await readFile(path.join(userData, 'fleet-instance', 'bots', 'alpha', 'inputs.json'), 'utf8')
    )
    expect(stored.items).toHaveLength(1)
    expect(await exists(path.join(userData, 'fleet-instance', 'bots', 'beta', 'inputs.json'))).toBe(false)
    expect(await exists(path.join(userData, 'fleet-instance', 'inputs.json'))).toBe(false)

    createLocalMemory({
      workspaceId: 'bot-self:alpha',
      title: 'Portal',
      content: 'Alpha opens the portal.',
      type: 'procedure',
      source: 'agent',
    })
    expect((await a.memories('active')).memories.map((memory) => memory.title)).toEqual(['Portal'])
    expect((await b.memories('active')).memories).toEqual([])

    const upserts = (runtime.events.replay(0) ?? []).filter((event) => event.type === 'transcript.upsert')
    const queued = upserts.filter((event) => event.type === 'transcript.upsert' && event.item.kind === 'user')
    expect(queued.map((event) => event.botId)).toEqual(['alpha'])
    expect(new Set(upserts.map((event) => event.botId))).toEqual(new Set(['alpha', 'beta']))

    const aggregate = await runtime.environmentStatus()
    expect(fleetInstanceEnvironmentStatusSchema.safeParse(aggregate).success).toBe(true)
    expect(aggregate).toMatchObject({
      environmentId: 'env-one',
      bots: [
        { botId: 'alpha', slot: 1, status: { profile: { botId: 'alpha', name: 'Alpha' }, conversationId: convA } },
        { botId: 'beta', slot: 2, status: { profile: { botId: 'beta', name: 'Beta' }, conversationId: convB } },
      ],
    })
    // Environment routes arrive with the routing task: until then the capability is not advertised.
    expect(aggregate.capabilities).not.toContain('environments')
  })

  it('installs idempotently, moves a bot to another slot and refuses a slot in use', async () => {
    const { runtime, displays } = environment()
    await runtime.start()
    const first = await runtime.installBot({ profile: profile('alpha', 'Alpha'), slot: 1, gatewayToken: tokenA })
    const again = await runtime.installBot({ profile: profile('alpha', 'Alpha 2'), slot: 1, gatewayToken: tokenA })
    expect(again.conversationId).toBe(first.conversationId)
    expect(again.profile).toEqual({ botId: 'alpha', name: 'Alpha 2' })
    expect(displays.startBot).toHaveBeenCalledTimes(1)
    expect(JSON.parse(getAppSetting('fleet.instance.bots') ?? '[]')).toEqual([{ botId: 'alpha', slot: 1 }])

    await expect(
      runtime.installBot({ profile: profile('beta', 'Beta'), slot: 1, gatewayToken: tokenB })
    ).rejects.toMatchObject({ status: 409, code: 'CONFLICT' })
    expect(runtime.bots().map((bot) => bot.botId)).toEqual(['alpha'])

    const moved = await runtime.installBot({ profile: profile('alpha', 'Alpha 2'), slot: 3, gatewayToken: tokenB })
    expect(moved.conversationId).toBe(first.conversationId)
    expect(displays.stopBot).toHaveBeenCalledWith('alpha')
    expect(displays.startBot).toHaveBeenLastCalledWith('alpha', 3)
    expect(conversationScreen(first.conversationId!)?.display).toBe(':3')
    expect(runtime.bot('alpha').gatewayConfig?.token).toBe(tokenB)
    expect(JSON.parse(getAppSetting('fleet.instance.bots') ?? '[]')).toEqual([{ botId: 'alpha', slot: 3 }])

    await expect(
      runtime.installBot({ profile: profile('beta', 'Beta'), slot: 9, gatewayToken: tokenB })
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_REQUEST' })
    let missing: unknown
    try {
      runtime.bot('missing')
    } catch (error) {
      missing = error
    }
    expect(missing).toBeInstanceOf(InstanceHttpError)
    expect(missing).toMatchObject({ status: 404, code: 'NOT_FOUND', message: 'Bot does not exist.' })
  })

  it('names the sibling bots and what they share in each identity prompt', async () => {
    vi.stubEnv('MAESTRLY_BOT_MODE', '1')
    const { runtime, convA, convB } = await twoBots()
    const promptA = botIdentityPrompt(getConversation(convA)!.cwd)
    const promptB = botIdentityPrompt(getConversation(convB)!.cwd)
    expect(promptA).toContain('# Bot identity\nYour name is Alpha.')
    expect(promptA).toContain('Work as Alpha.')
    expect(promptA).not.toContain('Work as Beta.')
    expect(promptA).toContain('Beta (beta)')
    expect(promptB).toContain('Your name is Beta.')
    expect(promptB).toContain('Alpha (alpha)')
    for (const prompt of [promptA, promptB]) {
      expect(prompt).toContain('browser_*')
      expect(prompt).toContain('computer_*')
      expect(prompt).toContain('site logins')
      expect(prompt).toContain('accounts')
      expect(prompt).toContain('files')
      expect(prompt).toContain('there is no sudo or Docker')
    }
    await runtime.uninstallBot('beta', { purge: false })
    const alone = botIdentityPrompt(getConversation(convA)!.cwd)
    expect(alone).not.toContain('Beta (beta)')
    expect(alone).toContain('No other bot shares this environment')
    expect(botIdentityPrompt(getConversation(convB)!.cwd)).toBe('')
  })

  it('holds one bot without stopping, gating or aborting the other', async () => {
    vi.stubEnv('MAESTRLY_BOT_MODE', '1')
    const { a, b, convA, convB } = await twoBots()
    screenActions.aborted.length = 0
    expect(await a.hold('takeover')).toMatchObject({ state: 'held', reason: 'takeover' })
    expect(screenActions.aborted).toEqual([convA])
    await expect(gateInstanceAppTool(convA, async () => 'alpha')).rejects.toThrow('owner has taken over')
    expect(await gateInstanceAppTool(convB, async () => 'beta')).toBe('beta')
    expect((await b.status()).hold.state).toBe('none')
    expect(getAppSetting('fleet.instance.bots.beta.paused')).not.toBe('1')
    await a.release({ note: null, durationMs: null, continue: false })
    expect(await gateInstanceAppTool(convA, async () => 'alpha')).toBe('alpha')
    await b.hold('paused')
    expect(screenActions.aborted).toEqual([convA, convB])
    expect(getAppSetting('fleet.instance.bots.beta.paused')).toBe('1')
    expect(getAppSetting('fleet.instance.bots.alpha.paused')).not.toBe('1')
  })

  it('sets compaction per conversation and never writes the global setting', async () => {
    const setup = environment()
    await setup.runtime.start()
    const compaction = {
      providerId: 'synthetic',
      modelId: 'model-a',
      reasoning: 'high',
      fastMode: false,
      intervalTokens: 120_000,
    }
    await setup.runtime.installBot({
      profile: profile('alpha', 'Alpha', { compaction }),
      slot: 1,
      gatewayToken: tokenA,
    })
    await setup.runtime.installBot({ profile: profile('beta', 'Beta'), slot: 2, gatewayToken: tokenB })
    const convA = setup.runtime.bot('alpha').primaryConversationId!
    const convB = setup.runtime.bot('beta').primaryConversationId!
    expect(override).toHaveBeenCalledWith(convA, {
      enabled: true,
      intervalTokens: 120_000,
      selection: { providerId: 'synthetic', modelId: 'model-a', effort: 'high', fastMode: false },
    })
    expect(override).toHaveBeenCalledWith(convB, { enabled: false, intervalTokens: 100_000, selection: null })
    expect(override.mock.calls.every(([conversationId]) => conversationId === convA || conversationId === convB)).toBe(
      true
    )
    expect((await setup.runtime.bot('alpha').status()).compaction).toMatchObject({ configured: true, problem: null })
    expect((await setup.runtime.bot('beta').status()).compaction).toMatchObject({
      configured: false,
      problem: 'missing',
    })

    // An effort the model does not offer is refused for that bot only.
    vi.mocked(chatService.effectiveModelMeta).mockResolvedValue({
      meta: { reasoning: true, reasoningEfforts: ['low', 'high'] },
    } as never)
    override.mockClear()
    await setup.runtime.installBot({
      profile: profile('alpha', 'Alpha', { compaction: { ...compaction, reasoning: 'extreme' } }),
      slot: 1,
      gatewayToken: tokenA,
    })
    expect((await setup.runtime.bot('alpha').status()).compaction).toMatchObject({ problem: 'invalid' })
    expect(override).toHaveBeenLastCalledWith(convA, { enabled: false, intervalTokens: 100_000, selection: null })
    expect(override.mock.calls.some(([conversationId]) => conversationId === convB)).toBe(false)
    expect(globalConfig).not.toHaveBeenCalled()
    expect(getAppSetting('chat.backgroundCompaction')).toBeNull()

    // Uninstalling returns the conversation to the global setting; stopping the process keeps a prepared compaction.
    override.mockClear()
    await setup.runtime.uninstallBot('beta', { purge: false })
    expect(override.mock.calls).toEqual([[convB, null]])
    override.mockClear()
    await setup.runtime.dispose()
    expect(override).not.toHaveBeenCalled()
  })

  it('purges one bot and leaves the other bot and the shared accounts and files alone', async () => {
    const { runtime, deps, displays, b, convA, convB } = await twoBots()
    setAppSetting('chat.defaultProvider', 'synthetic')
    await mkdir(path.join(home, '.config', 'shared-tool'), { recursive: true })
    await writeFile(path.join(home, '.config', 'shared-tool', 'settings.json'), '{}')
    for (const botId of ['alpha', 'beta']) {
      await mkdir(path.join(home, '.config', 'maestrly-bots', botId, 'chromium'), { recursive: true })
      await mkdir(path.join(home, '.cache', 'maestrly-bots', botId), { recursive: true })
      await mkdir(path.join(userData, 'fleet-images', botId), { recursive: true })
      await mkdir(path.join(userData, 'fleet-inputs', botId), { recursive: true })
      createLocalMemory({
        workspaceId: `bot-self:${botId}`,
        title: `Memory of ${botId}`,
        content: `Only ${botId} knows this.`,
        type: 'reference',
        source: 'agent',
      })
      await runtime
        .bot(botId)
        .input({ idempotencyKey: randomUUID(), source: 'owner', text: `Queued for ${botId}`, attachments: [] })
    }

    await runtime.uninstallBot('alpha', { purge: true })
    expect(runtime.bots().map((bot) => bot.botId)).toEqual(['beta'])
    expect(() => runtime.bot('alpha')).toThrow('Bot does not exist.')
    expect(deps.closeConversation.mock.calls).toEqual([[convA]])
    expect(displays.stopBot.mock.calls).toEqual([['alpha']])
    expect(deps.purgeConversation.mock.calls).toEqual([[convA]])
    expect(getConversation(convA)).toBeUndefined()
    expect(getConversation(convB)).toBeDefined()
    expect(botRuntimeForConversation(convA)).toBeNull()
    expect(conversationScreen(convA)).toBeNull()
    expect(conversationShellEnv(convA)).toEqual({})
    expect(conversationScreen(convB)?.display).toBe(':2')
    expect(listLocalMemories('bot-self:alpha')).toEqual([])
    expect(listLocalMemories('bot-self:beta')).toHaveLength(1)
    for (const [gone, kept] of [
      [path.join(userData, 'fleet-instance', 'bots', 'alpha'), path.join(userData, 'fleet-instance', 'bots', 'beta')],
      [path.join(userData, 'fleet-inputs', 'alpha'), path.join(userData, 'fleet-inputs', 'beta')],
      [path.join(userData, 'fleet-images', 'alpha'), path.join(userData, 'fleet-images', 'beta')],
      [path.join(home, '.config', 'maestrly-bots', 'alpha'), path.join(home, '.config', 'maestrly-bots', 'beta')],
      [path.join(home, '.cache', 'maestrly-bots', 'alpha'), path.join(home, '.cache', 'maestrly-bots', 'beta')],
    ]) {
      expect(await exists(gone)).toBe(false)
      expect(await exists(kept)).toBe(true)
    }
    expect(await exists(path.join(home, '.config', 'shared-tool', 'settings.json'))).toBe(true)
    expect(getAppSetting('chat.defaultProvider')).toBe('synthetic')
    expect(getAppSetting('fleet.instance.bots.alpha.profile')).toBeNull()
    expect(getAppSetting('fleet.instance.bots.alpha.gatewayToken')).toBeNull()
    expect(getAppSetting('fleet.instance.bots.beta.profile')).not.toBeNull()
    expect(JSON.parse(getAppSetting('fleet.instance.bots') ?? '[]')).toEqual([{ botId: 'beta', slot: 2 }])

    // Late timers of the purged bot write nothing back.
    await settle()
    expect(await exists(path.join(userData, 'fleet-instance', 'bots', 'alpha'))).toBe(false)
    expect(getAppSetting('fleet.instance.bots.alpha.paused')).toBeNull()
    expect((await b.status()).queue).toHaveLength(1)
    await expect(runtime.uninstallBot('alpha', { purge: true })).resolves.toBeUndefined()
  })

  it('stops the running turn of a purged bot and writes nothing of it back afterwards', async () => {
    const setup = environment()
    await setup.runtime.start()
    let finish: (() => void) | null = null
    const start = vi.spyOn(chatService, 'startExecutorChatTurn').mockImplementation(async (input) => {
      const done = new Promise<{ status: 'cancelled'; assistantMessageId: null }>((resolve) => {
        finish = () => {
          input.slot?.release()
          resolve({ status: 'cancelled', assistantMessageId: null })
        }
      })
      // Like a real runtime, the turn ends a moment after it is cancelled.
      input.signal.addEventListener('abort', () => setTimeout(() => finish?.(), 100), { once: true })
      return {
        executionId: input.conversationId,
        conversationId: input.conversationId,
        assistantMessageId: () => null,
        cancel: () => finish?.(),
        done,
      } as never
    })
    const compaction = {
      providerId: 'synthetic',
      modelId: 'model-a',
      reasoning: null,
      fastMode: false,
      intervalTokens: 100_000,
    }
    await setup.runtime.installBot({
      profile: profile('alpha', 'Alpha', { compaction }),
      slot: 1,
      gatewayToken: tokenA,
    })
    await setup.runtime.installBot({ profile: profile('beta', 'Beta'), slot: 2, gatewayToken: tokenB })
    const alpha = setup.runtime.bot('alpha')
    const convA = alpha.primaryConversationId!
    await alpha.input({ idempotencyKey: randomUUID(), source: 'owner', text: 'A long task', attachments: [] })
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
    expect((await alpha.status()).turn.state).toBe('running')

    await setup.runtime.uninstallBot('alpha', { purge: true })
    expect(setup.deps.closeConversation.mock.calls).toEqual([[convA]])
    await settle()
    for (const folder of [
      path.join(userData, 'fleet-instance', 'bots', 'alpha'),
      path.join(userData, 'fleet-inputs', 'alpha'),
      path.join(userData, 'fleet-images', 'alpha'),
    ])
      expect(await exists(folder)).toBe(false)
    expect(getAppSetting('fleet.instance.bots.alpha.profile')).toBeNull()
    expect(getAppSetting('fleet.instance.bots.alpha.paused')).toBeNull()
    expect(conversationScreen(convA)).toBeNull()
    expect(setup.runtime.bot('beta').primaryConversationId).toBeTruthy()
  })

  it('archives a bot, keeps its data and reuses its conversation when it is installed again', async () => {
    const { runtime, displays, convA, convB } = await twoBots()
    createLocalMemory({
      workspaceId: 'bot-self:beta',
      title: 'Kept',
      content: 'Beta keeps this.',
      type: 'reference',
      source: 'agent',
    })
    await runtime.uninstallBot('beta', { purge: false })
    expect(runtime.bots().map((bot) => bot.botId)).toEqual(['alpha'])
    expect(displays.stopBot).toHaveBeenCalledWith('beta')
    expect(getConversation(convB)).toBeDefined()
    expect(conversationScreen(convB)).toBeNull()
    expect(getAppSetting('fleet.instance.bots.beta.gatewayToken')).toBeNull()
    expect(listLocalMemories('bot-self:beta')).toHaveLength(1)
    const restored = await runtime.installBot({ profile: profile('beta', 'Beta'), slot: 4, gatewayToken: tokenB })
    expect(restored.conversationId).toBe(convB)
    expect(conversationScreen(convB)?.display).toBe(':4')
    expect(conversationScreen(convA)?.display).toBe(':1')
    expect((await runtime.bot('beta').memories('active')).memories.map((memory) => memory.title)).toEqual(['Kept'])
  })

  it('recreates the installed bots with their slots, tokens, conversations and holds after a restart', async () => {
    const first = await twoBots()
    await first.runtime.uninstallBot('beta', { purge: false })
    await first.runtime.installBot({ profile: profile('beta', 'Beta'), slot: 3, gatewayToken: tokenB })
    await first.a.hold('paused')
    const raw = getAppSetting('fleet.instance.bots.alpha.gatewayToken') ?? ''
    expect(raw).toMatch(/^enc:v1:/)
    expect(raw).not.toContain(tokenA)
    await first.runtime.dispose()
    restartDb()

    const second = environment()
    await second.runtime.start()
    expect(second.runtime.bots().map((bot) => [bot.botId, bot.slot])).toEqual([
      ['alpha', 1],
      ['beta', 3],
    ])
    expect(second.displays.startBot.mock.calls).toEqual([
      ['alpha', 1],
      ['beta', 3],
    ])
    expect(second.runtime.bot('alpha').primaryConversationId).toBe(first.convA)
    expect(second.runtime.bot('beta').primaryConversationId).toBe(first.convB)
    expect(second.runtime.bot('alpha').gatewayConfig?.token).toBe(tokenA)
    expect(second.runtime.bot('beta').gatewayConfig?.token).toBe(tokenB)
    expect((await second.runtime.bot('alpha').status()).hold).toMatchObject({ state: 'held', reason: 'paused' })
    expect((await second.runtime.bot('beta').status()).hold.state).toBe('none')
    expect(botRuntimeForConversation(first.convB)).toBe(second.runtime.bot('beta'))
  })

  it.skipIf(process.platform === 'win32')(
    'runs display programs with the process environment plus their variables and reports how they exit',
    async () => {
      const deps = productionDisplayDeps(home)
      const merged = deps.spawn(
        process.execPath,
        ['-e', 'process.exit(process.env.SYNTHETIC_DISPLAY_VAR === "set" && process.env.PATH ? 0 : 3)'],
        { env: { SYNTHETIC_DISPLAY_VAR: 'set' } }
      )
      expect(await merged.exited).toBe(0)
      expect(await deps.spawn(process.execPath, ['-e', 'process.exit(3)'], { env: {} }).exited).toBe(3)
      expect(await deps.spawn('maestrly-synthetic-missing-program', [], { env: {} }).exited).toBe(127)
      const sleeping = deps.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { env: {} })
      sleeping.kill()
      expect(await sleeping.exited).toBeNull()
      sleeping.kill()
      await deps.mkdir(path.join(home, '.cache', 'maestrly-bots', 'alpha'))
      expect(await exists(path.join(home, '.cache', 'maestrly-bots', 'alpha'))).toBe(true)
    }
  )

  it('resolves owner help and gateway tools by the calling conversation', async () => {
    vi.stubEnv('MAESTRLY_BOT_MODE', '1')
    const { a, b, convA, convB } = await twoBots()
    const fetch = vi.fn(async () =>
      Response.json({ peers: [{ botId: 'gamma', name: 'Gamma', role: 'research', status: 'idle' }] })
    )
    vi.stubGlobal('fetch', fetch)
    const sessions: Array<{ client: Client; server: McpServer }> = []
    const connect = async (convId: string) => {
      const server = new McpServer({ name: 'bot-tools', version: '1' })
      registerBotModeTools({ server, convId, locale: 'en', t: (() => '') as never }, process.env, () => false)
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      const client = new Client({ name: 'test', version: '1' })
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      sessions.push({ client, server })
      return client
    }
    try {
      const clientA = await connect(convA)
      const clientB = await connect(convB)
      await clientA.callTool({ name: 'bot_peers_list', arguments: {} })
      await clientB.callTool({ name: 'bot_peers_list', arguments: {} })
      const auth = fetch.mock.calls.map((call) =>
        new Headers((call as unknown as [unknown, RequestInit])[1].headers).get('authorization')
      )
      expect(auth).toEqual([`Bearer ${tokenA}`, `Bearer ${tokenB}`])
      const help = await clientB.callTool({ name: 'request_owner_help', arguments: { reason: 'Sign-in needed' } })
      expect(help.isError).not.toBe(true)
      expect((await b.status()).pending).toMatchObject([{ kind: 'help', reason: 'Sign-in needed' }])
      expect((await a.status()).pending).toEqual([])
    } finally {
      for (const { client, server } of sessions) {
        await client.close()
        await server.close()
      }
    }
  })
})
