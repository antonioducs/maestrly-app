import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { once } from 'node:events'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
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
  type BotDesktopTarget,
  type EnvironmentRuntimeDeps,
} from '../../src/main/fleet/instance/environment'
import { botRuntimeForConversation, getEnvironmentRuntime } from '../../src/main/fleet/instance'
import { parseBotInstanceConfig } from '../../src/main/fleet/instance/config'
import { emitChatHost } from '../../src/main/chat/host-events'
import { writeBotPaused } from '../../src/main/fleet/instance/registry'
import { InstanceInputQueue } from '../../src/main/fleet/instance/queue'
import { botIdentityPrompt } from '../../src/main/fleet/instance/identity'
import { gateInstanceAppTool } from '../../src/main/fleet/instance/gate'
import { createInstanceControlServer, InstanceHttpError } from '../../src/main/fleet/instance/server'
import * as wallpaperPainter from '../../src/main/fleet/instance/desktop/paint-wallpaper'
import type { DisplaySurface, VncMode } from '../../src/main/fleet/instance/displays'
import { registerBotModeTools } from '../../src/main/mcp/tools/bot-instance'
import { conversationScreen } from '../../src/main/conversation-screen'
import type { ScreenFocusOwner } from '../../src/main/screen-focus'
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
  gateway: { peersEnabled: true, artifactsEnabled: false },
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
        BROWSER: '/usr/local/bin/maestrly-open-url',
        MAESTRLY_BOT_BROWSER_PROFILE: `${home}/.config/maestrly-bots/${botId}/chromium`,
        GTK_THEME: 'Adwaita:dark',
        MAESTRLY_DESKTOP_SOCKET: `${home}/.cache/maestrly-bots/${botId}/desktop.sock`,
      },
      browserArea: fleetEnvironmentTile(slot),
    })),
    stopBot: vi.fn(async (_botId: string) => {}),
    redecorate: vi.fn(async (_botId: string) => {}),
    acquireVnc: vi.fn(async (_surface: DisplaySurface, _mode: VncMode) => ({ port: 5903, release: vi.fn() })),
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
    holdScreenFocus: vi.fn((_owner: ScreenFocusOwner | null) => vi.fn()),
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
  it('waits for gateway membership before dispatching a restored queue and applies an offline pause first', async () => {
    const first = environment()
    await first.runtime.start()
    const configured = profile('alpha', 'Alpha', {
      compaction: {
        providerId: model.providerId,
        modelId: model.modelId,
        reasoning: null,
        fastMode: false,
        intervalTokens: 100_000,
      },
    })
    const start = vi.spyOn(chatService, 'startExecutorChatTurn').mockImplementation(async (input) => {
      input.slot?.release()
      return {
        executionId: input.conversationId,
        conversationId: input.conversationId,
        assistantMessageId: () => null,
        cancel: () => {},
        done: Promise.resolve({ status: 'success', assistantMessageId: null }),
      } as never
    })
    await first.runtime.installBot({ profile: configured, slot: 1, gatewayToken: tokenA })
    const alpha = first.runtime.bot('alpha')
    await alpha.hold('paused')
    await alpha.input({
      idempotencyKey: randomUUID(),
      source: 'owner',
      text: 'Keep queued over restart',
      attachments: [],
    })
    await first.runtime.dispose()
    // The gateway can archive or pause a bot while the environment is stopped; its persisted membership is stale.
    writeBotPaused('alpha', false)
    const restarted = environment()
    await restarted.runtime.start()
    await settle(100)
    expect(start).not.toHaveBeenCalled()
    expect((await restarted.runtime.bot('alpha').status()).ready).toBe(false)
    expect((await restarted.runtime.bot('alpha').status()).queue).toHaveLength(1)
    // If still a member, its current gateway pause is installed before any work is allowed.
    await restarted.runtime.installBot({
      profile: configured,
      slot: 1,
      gatewayToken: tokenA,
      paused: true,
      takeover: true,
    })
    await settle(100)
    expect(start).not.toHaveBeenCalled()
    expect((await restarted.runtime.bot('alpha').status()).hold.reason).toBe('takeover')
    await restarted.runtime.bot('alpha').release({ note: null, durationMs: null, continue: false })
    expect((await restarted.runtime.bot('alpha').status()).hold.reason).toBe('paused')
    expect(start).not.toHaveBeenCalled()
    await restarted.runtime.bot('alpha').release({ note: null, durationMs: null, continue: false })
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
  })

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
    // Without displays, bots have no desktop: clients keep their separate screens.
    expect(aggregate.capabilities).toEqual([
      'provisioning',
      'environments',
      'environment-compaction',
      'context-limit',
      'transcript-reasoning',
      'runtime-updates',
    ])
    expect(runtime.health()).toMatchObject({
      ok: true,
      ready: true,
      capabilities: [
        'provisioning',
        'environments',
        'environment-compaction',
        'context-limit',
        'transcript-reasoning',
        'runtime-updates',
      ],
    })
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

    // Uninstalling turns the conversation's compaction off, never back to the global setting; stopping the process
    // keeps a prepared compaction.
    override.mockClear()
    await setup.runtime.uninstallBot('beta', { purge: false })
    expect(override.mock.calls).toEqual([[convB, { enabled: false, intervalTokens: 100_000, selection: null }]])
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

  it('does not start the next queued input while uninstall is cancelling and closing the conversation', async () => {
    const setup = environment()
    await setup.runtime.start()
    setup.deps.closeConversation.mockImplementation(async () => {
      await settle(200)
    })
    const start = vi.spyOn(chatService, 'startExecutorChatTurn').mockImplementation(async (input) => {
      const done = new Promise<{ status: 'cancelled'; assistantMessageId: null }>((resolve) => {
        input.signal.addEventListener(
          'abort',
          () => {
            input.slot?.release()
            resolve({ status: 'cancelled', assistantMessageId: null })
          },
          { once: true }
        )
      })
      return {
        executionId: input.conversationId,
        conversationId: input.conversationId,
        assistantMessageId: () => null,
        cancel: () => {},
        done,
      } as never
    })
    const configured = profile('alpha', 'Alpha', {
      compaction: {
        providerId: model.providerId,
        modelId: model.modelId,
        reasoning: null,
        fastMode: false,
        intervalTokens: 100_000,
      },
    })
    await setup.runtime.installBot({ profile: configured, slot: 1, gatewayToken: tokenA })
    const alpha = setup.runtime.bot('alpha')
    await alpha.input({ idempotencyKey: randomUUID(), source: 'owner', text: 'First task', attachments: [] })
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
    await alpha.input({ idempotencyKey: randomUUID(), source: 'owner', text: 'Leave this queued', attachments: [] })
    await setup.runtime.uninstallBot('alpha', { purge: false })
    expect(start).toHaveBeenCalledOnce()
    expect((await alpha.status()).queue).toHaveLength(1)
  })

  it('keeps an input queued when uninstall interrupts attachment loading before the provider starts', async () => {
    const setup = environment()
    await setup.runtime.start()
    let continueReading!: () => void
    let reading!: () => void
    const entered = new Promise<void>((resolve) => {
      reading = resolve
    })
    const pending = new Promise<void>((resolve) => {
      continueReading = resolve
    })
    vi.spyOn(InstanceInputQueue.prototype, 'readAttachments').mockImplementation(async () => {
      reading()
      await pending
      return []
    })
    const start = vi.spyOn(chatService, 'startExecutorChatTurn').mockImplementation(async (input) => {
      input.slot?.release()
      return {
        executionId: input.conversationId,
        conversationId: input.conversationId,
        assistantMessageId: () => null,
        cancel: () => {},
        done: Promise.resolve({ status: 'cancelled', assistantMessageId: null }),
      } as never
    })
    await setup.runtime.installBot({
      profile: profile('alpha', 'Alpha', {
        compaction: {
          providerId: model.providerId,
          modelId: model.modelId,
          reasoning: null,
          fastMode: false,
          intervalTokens: 100_000,
        },
      }),
      slot: 1,
      gatewayToken: tokenA,
    })
    const alpha = setup.runtime.bot('alpha')
    await alpha.input({ idempotencyKey: randomUUID(), source: 'owner', text: 'Keep this input', attachments: [] })
    await entered
    const uninstall = setup.runtime.uninstallBot('alpha', { purge: false })
    await settle(30)
    continueReading()
    await uninstall
    expect(start).not.toHaveBeenCalled()
    expect((await alpha.status()).queue).toHaveLength(1)
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

  it("starts each bot's desktop services with its display and stops them with its screens", async () => {
    const handles: Array<{
      botId: string
      display: string
      dispose: ReturnType<typeof vi.fn>
      present: ReturnType<typeof vi.fn>
    }> = []
    const order: string[] = []
    const displays = fakeDisplays(home)
    displays.dispose.mockImplementation(async () => {
      order.push('displays')
    })
    const desktop = vi.fn(async (target: BotDesktopTarget) => {
      const dispose = vi.fn(async () => {
        order.push('desktop ' + target.botId)
      })
      const handle = { present: vi.fn(), dispose }
      handles.push({ botId: target.botId, display: target.display.display, ...handle })
      return handle
    })
    const setup = environment(displays)
    const runtime = new EnvironmentRuntime({ ...setup.deps, desktop })
    environments.push(runtime)
    await runtime.start()
    await runtime.installBot({ profile: profile('alpha', 'Alpha'), slot: 1, gatewayToken: tokenA })
    await runtime.installBot({ profile: profile('beta', 'Beta'), slot: 2, gatewayToken: tokenB })
    expect(handles.map(({ botId, display }) => [botId, display])).toEqual([
      ['alpha', ':1'],
      ['beta', ':2'],
    ])
    // With a desktop for each bot, the environment tells clients to show one screen per bot.
    expect(runtime.health().capabilities).toContain('unified-desktop')
    expect((await runtime.environmentStatus()).capabilities).toContain('unified-desktop')
    expect((await runtime.bot('alpha').status()).capabilities).toContain('unified-desktop')
    vi.stubEnv('MAESTRLY_BOT_MODE', '1')
    expect(botIdentityPrompt(getConversation(runtime.bot('alpha').primaryConversationId!)!.cwd)).toContain(
      'one Linux desktop of your own'
    )
    const target = desktop.mock.calls[0][0]
    expect(target.conversationId()).toBe(runtime.bot('alpha').primaryConversationId)
    expect(target.hold()).toMatchObject({ state: 'none' })
    // The app a bot's tool uses comes forward on that bot's desktop only.
    const alphaConversation = runtime.bot('alpha').primaryConversationId!
    const betaConversation = runtime.bot('beta').primaryConversationId!
    for (const handle of handles) handle.present.mockClear()
    const tool = (conversationId: string, payload: Record<string, unknown>) =>
      emitChatHost(conversationId, `chat:delta:${conversationId}`, { messageId: 'm', ...payload })
    tool(betaConversation, { kind: 'tool-call', toolCallId: 'b1', toolName: 'browser_click', input: { ref: 1 } })
    tool(alphaConversation, {
      kind: 'tool-call',
      toolCallId: 'a1',
      toolName: 'terminal_run',
      input: { id: 'term:x:2' },
    })
    // A new terminal exists only once its tool finished.
    tool(alphaConversation, {
      kind: 'tool-call',
      toolCallId: 'a2',
      toolName: 'mcp__maestrly__terminal_create',
      input: {},
    })
    // Reading the page shows nothing.
    tool(betaConversation, { kind: 'tool-call', toolCallId: 'b2', toolName: 'browser_snapshot', input: {} })
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    expect(handles[1].present.mock.calls).toEqual([[{ app: 'browser' }]])
    expect(handles[0].present.mock.calls).toEqual([[{ app: 'terminal', terminalId: 'term:x:2' }]])
    tool(alphaConversation, {
      kind: 'tool-state',
      toolCallId: 'a2',
      state: { status: 'completed', output: { text: 'created' } },
    })
    expect(handles[0].present.mock.calls.at(-1)).toEqual([{ app: 'terminal', terminalId: null }])
    expect(setup.deps.floatBrowser).toHaveBeenCalledWith(betaConversation)

    // A new slot is a new display: the old services stop first.
    await runtime.installBot({ profile: profile('alpha', 'Alpha'), slot: 3, gatewayToken: tokenA })
    expect(handles[0].dispose).toHaveBeenCalledTimes(1)
    expect(handles.at(-1)).toMatchObject({ botId: 'alpha', display: ':3' })

    await runtime.uninstallBot('beta', { purge: false })
    expect(handles[1].dispose).toHaveBeenCalledTimes(1)

    await runtime.dispose()
    expect(handles.at(-1)!.dispose).toHaveBeenCalledTimes(1)
    // The services stop before the displays they run on.
    expect(order.at(-1)).toBe('displays')
    expect(order.indexOf('desktop alpha')).toBeLessThan(order.indexOf('displays'))
  })

  it('installs a bot whose desktop services fail to start, and starts none without a display', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const displays = fakeDisplays(home)
    const start = displays.startBot.getMockImplementation()!
    displays.startBot.mockImplementation(async (botId: string, slot: number) => {
      if (slot === 2) throw new Error('Display :2 is already in use.')
      return start(botId, slot)
    })
    const desktop = vi.fn(async (target: BotDesktopTarget) => {
      if (target.botId === 'alpha') throw new Error('socket busy')
      return { present: vi.fn(), dispose: vi.fn(async () => {}) }
    })
    const runtime = new EnvironmentRuntime({ ...environment(displays).deps, desktop })
    environments.push(runtime)
    await runtime.start()
    await expect(
      runtime.installBot({ profile: profile('alpha', 'Alpha'), slot: 1, gatewayToken: tokenA })
    ).resolves.toBeDefined()
    expect(errors.mock.calls.some(([line]) => String(line).includes('socket busy'))).toBe(true)
    await runtime.installBot({ profile: profile('beta', 'Beta'), slot: 2, gatewayToken: tokenB })
    expect(desktop.mock.calls.map(([target]) => target.botId)).toEqual(['alpha'])
  })

  it('gives a bot whose apps display cannot start its own display variables, never the environment ones', async () => {
    const displays = fakeDisplays(home)
    displays.startBot.mockRejectedValueOnce(new Error('Display :1 is already in use.'))
    const { runtime } = environment(displays)
    await runtime.start()
    await runtime.installBot({ profile: profile('alpha', 'Alpha'), slot: 1, gatewayToken: tokenA })
    await runtime.installBot({ profile: profile('beta', 'Beta'), slot: 2, gatewayToken: tokenB })
    const convA = runtime.bot('alpha').primaryConversationId!
    expect(conversationScreen(convA)).toEqual({
      display: ':1',
      width: 1280,
      height: 800,
      windowArea: fleetEnvironmentTile(1),
    })
    expect(conversationShellEnv(convA)).toEqual({
      DISPLAY: ':1',
      // Built by the bot's own Maestrly, which joins paths as the platform does.
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(home, '.cache', 'maestrly-bots', 'alpha', 'bus')}`,
      BROWSER: '/usr/local/bin/maestrly-open-url',
      MAESTRLY_BOT_BROWSER_PROFILE: path.join(home, '.config', 'maestrly-bots', 'alpha', 'chromium'),
      GTK_THEME: 'Adwaita:dark',
      MAESTRLY_DESKTOP_SOCKET: path.join(home, '.cache', 'maestrly-bots', 'alpha', 'desktop.sock'),
    })
    expect(conversationShellEnv(runtime.bot('beta').primaryConversationId!)).toMatchObject({ DISPLAY: ':2' })
  })

  it('paints the wallpaper of a bot once it is installed, and again only when its name or color changes', async () => {
    const { runtime, displays } = environment()
    await runtime.start()
    const install = (extra: Partial<FleetInstanceProfile>, name = 'Alpha') =>
      runtime.installBot({ profile: profile('alpha', name, extra), slot: 1, gatewayToken: tokenA })
    await install({ tint: '#8b6cf0' })
    // The first install started the display before the profile was known: it is painted once the profile is in.
    expect(displays.redecorate.mock.calls).toEqual([['alpha']])
    expect(runtime.bot('alpha')).toMatchObject({ name: 'Alpha', tint: '#8b6cf0' })

    await install({ tint: '#8b6cf0' })
    await install({ tint: '#8b6cf0', instructions: 'Other instructions.', ceiling: 'full' })
    expect(displays.redecorate).toHaveBeenCalledTimes(1)

    await install({ tint: '#3f9fd8' })
    expect(displays.redecorate).toHaveBeenCalledTimes(2)
    await install({ tint: '#3f9fd8' }, 'Ada')
    expect(displays.redecorate).toHaveBeenCalledTimes(3)
    // A gateway that stops sending a color takes the bot back to the neutral one.
    await install({}, 'Ada')
    expect(runtime.bot('alpha').tint).toBeNull()
    expect(displays.redecorate).toHaveBeenCalledTimes(4)
    expect(displays.redecorate.mock.calls.every(([botId]) => botId === 'alpha')).toBe(true)
  })

  it('installs a bot even when its wallpaper cannot be painted', async () => {
    const displays = fakeDisplays(home)
    displays.redecorate.mockRejectedValue(new Error('painting failed'))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { runtime } = environment(displays)
    await runtime.start()
    await expect(
      runtime.installBot({ profile: profile('alpha', 'Alpha', { tint: '#8b6cf0' }), slot: 1, gatewayToken: tokenA })
    ).resolves.toBeDefined()
    await expect(
      runtime.installBot({ profile: profile('alpha', 'Ada', { tint: '#8b6cf0' }), slot: 1, gatewayToken: tokenA })
    ).resolves.toBeDefined()
    await settle(20)
    expect(runtime.bot('alpha').name).toBe('Ada')
    expect(errors.mock.calls.filter(([line]) => String(line).includes('painting failed'))).toHaveLength(2)
    // Without displays (outside a container) there is nothing to paint and nothing to fail.
    await runtime.dispose()
    const bare = new EnvironmentRuntime({ ...environment().deps, displays: null })
    environments.push(bare)
    await bare.start()
    await expect(
      bare.installBot({ profile: profile('beta', 'Beta', { tint: '#8b6cf0' }), slot: 2, gatewayToken: tokenB })
    ).resolves.toBeDefined()
  })

  it('gives the wallpaper the stored look of a bot, nothing for an unknown bot, and the language of the app', async () => {
    const painted = vi.spyOn(wallpaperPainter, 'paintWallpaper').mockResolvedValue()
    const { runtime } = environment()
    await runtime.start()
    await runtime.installBot({
      profile: profile('alpha', 'Alpha', { tint: '#8b6cf0' }),
      slot: 1,
      gatewayToken: tokenA,
    })
    await runtime.installBot({ profile: profile('beta', 'Beta'), slot: 2, gatewayToken: tokenB })
    const display = (botId: string, slot: number) =>
      ({ botId, slot, display: `:${slot}` }) as Parameters<
        NonNullable<ReturnType<typeof productionDisplayDeps>['decorate']>
      >[0]
    const folder = (botId: string) => path.join(home, '.cache', 'maestrly-bots', botId)

    const deps = productionDisplayDeps(home)
    await deps.decorate?.(display('alpha', 1))
    await deps.decorate?.(display('beta', 2))
    await deps.decorate?.(display('gamma', 3))
    expect(painted.mock.calls).toEqual([
      [{ folder: folder('alpha'), display: ':1', name: 'Alpha', tint: '#8b6cf0' }],
      [{ folder: folder('beta'), display: ':2', name: 'Beta', tint: null }],
    ])
    // The look and the language can come from elsewhere, and a painting that fails is the caller's to log.
    let locale = 'pt-BR'
    const custom = productionDisplayDeps(
      home,
      (botId) => (botId === 'alpha' ? { name: 'Custom', tint: '#112233' } : null),
      () => locale
    )
    await custom.decorate?.(display('alpha', 1))
    expect(painted.mock.calls.at(-1)).toEqual([
      { folder: folder('alpha'), display: ':1', name: 'Custom', tint: '#112233' },
    ])
    expect(custom.language?.()).toBe('pt_BR')
    locale = 'en'
    expect(custom.language?.()).toBe('en')
    locale = 'fr'
    expect(custom.language?.()).toBe('en')
    painted.mockRejectedValueOnce(new Error('hsetroot is not installed'))
    await expect(custom.decorate?.(display('alpha', 1))).rejects.toThrow('hsetroot is not installed')
    // Without a look given, the language is the app's own.
    expect(deps.language?.()).toBe('en')
    setAppSetting('locale', 'pt-BR')
    expect(deps.language?.()).toBe('pt_BR')
  })

  it('lends VNC servers for the screens of installed bots and the environment screen only', async () => {
    const { runtime, displays, deps } = await twoBots()
    const lease = await runtime.acquireScreen({ kind: 'apps', botId: 'beta' }, 'control')
    expect(lease.port).toBe(5903)
    await runtime.acquireScreen({ kind: 'environment' }, 'view')
    expect(displays.acquireVnc.mock.calls).toEqual([
      [{ kind: 'apps', botId: 'beta' }, 'control'],
      [{ kind: 'environment' }, 'view'],
    ])
    for (const surface of [
      { kind: 'browser', botId: 'gamma' },
      { kind: 'apps', botId: 'Not_A_Bot' },
    ] as const)
      await expect(runtime.acquireScreen(surface, 'view')).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(displays.acquireVnc).toHaveBeenCalledTimes(2)
    const bare = new EnvironmentRuntime({ ...deps, displays: null })
    environments.push(bare)
    await expect(bare.acquireScreen({ kind: 'environment' }, 'view')).rejects.toMatchObject({
      status: 503,
      code: 'INSTANCE_UNAVAILABLE',
    })
  })

  it('keeps the environment display focus on the controlled screen until its lease is released', async () => {
    const { runtime, displays, deps, convA } = await twoBots()
    const holds: Array<{ owner: ScreenFocusOwner | null; end: ReturnType<typeof vi.fn> }> = []
    deps.holdScreenFocus.mockImplementation((owner: ScreenFocusOwner | null) => {
      const end = vi.fn()
      holds.push({ owner, end })
      return end
    })

    const browser = await runtime.acquireScreen({ kind: 'browser', botId: 'alpha' }, 'control')
    expect(holds.map((hold) => hold.owner)).toEqual([{ kind: 'conversation', conversationId: convA }])
    // Viewers, and each bot's own apps display, leave the environment display's focus alone.
    await runtime.acquireScreen({ kind: 'browser', botId: 'beta' }, 'view')
    await runtime.acquireScreen({ kind: 'environment' }, 'view')
    await runtime.acquireScreen({ kind: 'apps', botId: 'beta' }, 'control')
    expect(holds).toHaveLength(1)

    // Releasing the control, once or again, ends the hold and gives the VNC server back.
    const vnc = await displays.acquireVnc.mock.results[0].value
    browser.release()
    browser.release()
    expect(holds[0].end).toHaveBeenCalledOnce()
    expect(vnc.release).toHaveBeenCalledOnce()
    expect(browser.port).toBe(vnc.port)

    const settings = await runtime.acquireScreen({ kind: 'environment' }, 'control')
    expect(holds[1].owner).toEqual({ kind: 'environment' })
    settings.release()
    expect(holds[1].end).toHaveBeenCalledOnce()

    // A screen that cannot start holds nothing; a bot removed while its screen starts has no windows to type into.
    displays.acquireVnc.mockRejectedValueOnce(new Error('The VNC server on port 5904 did not start.'))
    await expect(runtime.acquireScreen({ kind: 'browser', botId: 'beta' }, 'control')).rejects.toThrow('did not start')
    expect(holds).toHaveLength(2)
    displays.acquireVnc.mockImplementationOnce(async () => {
      await runtime.uninstallBot('beta', { purge: false })
      return { port: 5904, release: vi.fn() }
    })
    const removed = await runtime.acquireScreen({ kind: 'browser', botId: 'beta' }, 'control')
    expect(holds[2].owner).toBeNull()
    removed.release()
    expect(holds[2].end).toHaveBeenCalledOnce()
  })

  it('serves its bots through the control API, each by its own id', async () => {
    const { runtime, deps } = await twoBots()
    const server = createInstanceControlServer(deps.config, runtime)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const request = (method: string, route: string, body?: unknown) =>
      fetch(base + route, {
        method,
        headers: {
          'X-Maestrly-Fleet-Protocol': '1',
          Authorization: `Bearer ${deps.config.controlToken}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    try {
      expect(await (await request('GET', '/v1/health')).json()).toEqual({
        ok: true,
        appVersion: expect.any(String),
        protocol: 1,
        ready: true,
        capabilities: [
          'provisioning',
          'environments',
          'environment-compaction',
          'context-limit',
          'transcript-reasoning',
          'runtime-updates',
        ],
      })
      expect(await (await request('GET', '/v1/environment/status')).json()).toMatchObject({
        environmentId: 'env-one',
        capabilities: [
          'provisioning',
          'environments',
          'environment-compaction',
          'context-limit',
          'transcript-reasoning',
          'runtime-updates',
        ],
        bots: [
          { botId: 'alpha', slot: 1 },
          { botId: 'beta', slot: 2 },
        ],
      })
      expect(await (await request('GET', '/v1/bots/beta/status')).json()).toMatchObject({
        profile: { botId: 'beta', name: 'Beta' },
        capabilities: [
          'provisioning',
          'environments',
          'environment-compaction',
          'context-limit',
          'transcript-reasoning',
          'runtime-updates',
        ],
      })
      const selections = await request('GET', '/v1/environment/selections')
      expect(selections.status).toBe(200)
      expect(await selections.json()).toEqual({ options: expect.any(Array), current: null })
      expect((await request('GET', '/v1/bots/gamma/status')).status).toBe(404)
      expect((await request('GET', '/v1/status')).status).toBe(404)
      expect((await request('PUT', '/v1/profile', profile('alpha', 'Alpha'))).status).toBe(404)
      const held = await request('POST', '/v1/bots/alpha/hold', { reason: 'takeover' })
      expect(await held.json()).toMatchObject({ state: 'held', reason: 'takeover' })
      expect((await runtime.bot('alpha').status()).hold).toMatchObject({ state: 'held', reason: 'takeover' })
      expect((await runtime.bot('beta').status()).hold.state).toBe('none')
      const install = { profile: profile('gamma', 'Gamma'), slot: 3, gatewayToken: 'synthetic-gateway-token-gamma' }
      expect((await request('PUT', '/v1/bots/beta', install)).status).toBe(400)
      expect((await request('PUT', '/v1/bots/gamma', install)).status).toBe(200)
      expect(runtime.bots().map((bot) => [bot.botId, bot.slot])).toEqual([
        ['alpha', 1],
        ['beta', 2],
        ['gamma', 3],
      ])
      expect(runtime.bot('gamma').gatewayConfig?.token).toBe('synthetic-gateway-token-gamma')
      expect((await request('DELETE', '/v1/bots/gamma?purge=1')).status).toBe(204)
      expect(runtime.bots().map((bot) => bot.botId)).toEqual(['alpha', 'beta'])
      expect(getAppSetting('fleet.instance.bots.gamma.profile')).toBeNull()
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

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
