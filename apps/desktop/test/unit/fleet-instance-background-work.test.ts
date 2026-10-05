import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { fleetEnvironmentTile, type FleetInstanceProfile } from '@maestrly/bot-fleet-protocol'
import { app } from 'electron'
import { closeDb, freshDb, restartDb } from '../helpers/db'
import * as chatService from '../../src/main/chat/service'
import { BackgroundCompactionStore } from '../../src/main/chat/background-compaction/store'
import { backgroundCompactionConfigIdentity } from '../../src/main/chat/background-compaction/config'
import { getConversationContextLimit } from '../../src/main/chat/conversation-context-limit'
import { upsertChatMessage } from '../../src/main/chat/chat-store'
import { EnvironmentRuntime, type EnvironmentRuntimeDeps } from '../../src/main/fleet/instance/environment'
import { parseBotInstanceConfig } from '../../src/main/fleet/instance/config'
import { runMemoryExtraction } from '../../src/main/memory/extraction/scheduler'
import { getOwnerMemoryWriter } from '../../src/main/memory/extraction/owner-writer'
import { listLocalMemories } from '../../src/main/memory/local-memory-service'
import { memorySpaceForConversation } from '../../src/main/memory/spaces'
import { deleteConversation, getAppSetting, getConversation, setAppSetting } from '../../src/main/store'
import { getConsolidationState, getExtractionState } from '../../src/main/store/memory-extraction-state'

const model = {
  providerId: 'synthetic',
  providerLabel: 'Synthetic',
  modelId: 'model-a',
  reasoningEfforts: ['low', 'high'],
  fastMode: false,
}
const tokenA = 'synthetic-gateway-token-alpha'
const tokenB = 'synthetic-gateway-token-beta'
const compaction = {
  providerId: 'synthetic',
  modelId: 'model-a',
  reasoning: null,
  fastMode: false,
  intervalTokens: 100_000,
}
const disabled = { enabled: false, intervalTokens: 100_000, selection: null }
/** The compaction settings a bot's `compaction` gives its conversation. */
const enabled = {
  enabled: true,
  intervalTokens: 100_000,
  selection: { providerId: 'synthetic', modelId: 'model-a', effort: 'off', fastMode: false },
}
const profile = (botId: string, name: string): FleetInstanceProfile => ({
  botId,
  name,
  instructions: `Work as ${name}.`,
  ceiling: 'ask',
  selection: null,
  compaction,
  gateway: { peersEnabled: true, artifactsEnabled: false },
})
const extracted = JSON.stringify({
  memories: [{ action: 'create', type: 'decision', title: 'Blue-green deploy', content: 'Switch blue to green.' }],
  owner: [{ content: 'Prefer short answers.' }],
})

type OneShotResult = { text: string; usage: { input: number; output: number; cacheRead: number; cacheCreate: number } }
/** A provider call that ignores its abort signal and answers only when the test says so. */
function lateOneShot(text: string) {
  let answer: (() => void) | null = null
  let signal: AbortSignal | undefined
  const call = vi.fn(
    (input: { signal: AbortSignal }) =>
      new Promise<OneShotResult>((resolve) => {
        signal = input.signal
        answer = () => resolve({ text, usage: { input: 1, output: 1, cacheRead: 0, cacheCreate: 0 } })
      })
  )
  return { call, answer: () => answer?.(), signal: () => signal }
}

/** A compaction the conversation prepared under its bot's settings, as the previous process left it. */
function prepare(conversationId: string) {
  const store = new BackgroundCompactionStore()
  const generation = (store.get(conversationId)?.generation ?? 0) + 1
  const configIdentity = backgroundCompactionConfigIdentity(enabled)
  return store.write(conversationId, {
    generation,
    configIdentity,
    conversationWindow: 128_000,
    status: 'ready',
    ready: {
      version: 1,
      id: randomUUID(),
      generation,
      configIdentity,
      boundary: { messageId: 'synthetic-message', partId: 'synthetic-part', partIndex: 0 },
      sourceHash: 'synthetic-source',
      summary: 'Prepared summary.',
      summaryTokens: 10,
      coveredTokens: 1_000,
      selection: { providerId: 'synthetic', modelId: 'model-a', fastMode: false },
      createdAt: 1,
    },
    work: null,
  })
}

/** The end of the process: the conversations' own compaction settings are kept in memory and go with it. */
function endProcess(conversationIds: string[]): void {
  for (const id of conversationIds) chatService.setConversationCompactionOverride(id, null)
}

function seed(conversationId: string): void {
  upsertChatMessage({
    id: randomUUID(),
    conversationId,
    role: 'user',
    createdAt: 1,
    parts: [
      {
        type: 'text',
        id: randomUUID(),
        text: `Use blue-green deploys. Prefer short answers. ${'Context. '.repeat(200)}`,
      },
    ],
  })
  upsertChatMessage({
    id: randomUUID(),
    conversationId,
    role: 'assistant',
    createdAt: 2,
    parts: [{ type: 'text', id: randomUUID(), text: 'Understood.' }],
  })
}

function fakeDisplays() {
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
    acquireVnc: vi.fn(async () => ({ port: 5903, release: vi.fn() })),
    dispose: vi.fn(async () => {}),
  }
}

let dir = ''
let userData = ''
let home = ''
const environments: EnvironmentRuntime[] = []

function environment() {
  const deps = {
    config: parseBotInstanceConfig({
      MAESTRLY_BOT_MODE: '1',
      MAESTRLY_BOT_CONTROL_TOKEN: randomBytes(32).toString('base64url'),
      MAESTRLY_BOT_GATEWAY_URL: 'http://gateway.test',
      MAESTRLY_ENVIRONMENT_ID: 'env-one',
    })!,
    userData,
    home,
    displays: fakeDisplays(),
    floatBrowser: vi.fn(),
    closeConversation: vi.fn(async (_conversationId: string) => {}),
    purgeConversation: vi.fn(async (conversationId: string) => {
      deleteConversation(conversationId)
    }),
    openSettings: vi.fn(),
    holdScreenFocus: vi.fn(() => () => {}),
  } satisfies EnvironmentRuntimeDeps
  const runtime = new EnvironmentRuntime(deps)
  environments.push(runtime)
  return { runtime, deps }
}

async function twoBots() {
  const setup = environment()
  await setup.runtime.start()
  await setup.runtime.installBot({ profile: profile('alpha', 'Alpha'), slot: 1, gatewayToken: tokenA })
  await setup.runtime.installBot({ profile: profile('beta', 'Beta'), slot: 2, gatewayToken: tokenB })
  return {
    ...setup,
    convA: setup.runtime.bot('alpha').primaryConversationId!,
    convB: setup.runtime.bot('beta').primaryConversationId!,
  }
}

const gateway = vi.fn(async (_url: URL | string, _init?: RequestInit) => new Response(null, { status: 204 }))
/** Owner facts a bot posted to the gateway with its own token. */
const ownerSaves = (token: string) =>
  gateway.mock.calls.filter(
    ([url, init]) =>
      String(url).includes('owner-memor') &&
      init?.method === 'POST' &&
      new Headers(init.headers).get('authorization') === `Bearer ${token}`
  )

beforeEach(async () => {
  freshDb()
  dir = await mkdtemp(path.join(os.tmpdir(), 'fleet-background-'))
  userData = path.join(dir, 'user-data')
  home = path.join(dir, 'home')
  await mkdir(userData, { recursive: true })
  await mkdir(home, { recursive: true })
  vi.spyOn(app, 'getPath').mockReturnValue(userData)
  vi.spyOn(chatService, 'listChatRunnerCapabilities').mockResolvedValue([model])
  vi.spyOn(chatService, 'effectiveModelMeta').mockResolvedValue({ meta: null })
  vi.spyOn(chatService, 'primeChatTurnSelection').mockImplementation(() => undefined as never)
  vi.spyOn(chatService, 'publishConvChatSettings').mockImplementation(() => undefined as never)
  vi.spyOn(chatService, 'backgroundCompactionStatus').mockReturnValue({ revision: 0, status: 'idle' })
  vi.spyOn(chatService, 'stopChatAndWait').mockImplementation(async () => undefined as never)
  gateway.mockClear()
  vi.stubGlobal('fetch', gateway)
})
afterEach(async () => {
  for (const runtime of environments.splice(0)) await runtime.dispose()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  closeDb()
  await rm(dir, { recursive: true, force: true })
})

describe('background work of an uninstalled bot', () => {
  it('stops before the purge deletes its data, and a late provider answer writes nothing', async () => {
    const suspend = vi.spyOn(chatService, 'suspendConversationBackgroundCompaction')
    const { runtime, deps, convA, convB } = await twoBots()
    seed(convA)
    seed(convB)
    const lateA = lateOneShot(extracted)
    const lateB = lateOneShot(extracted)
    // Each bot extracts with its own compaction model, into its own memory space.
    const runA = runMemoryExtraction(convA, undefined, { oneShot: lateA.call })
    const runB = runMemoryExtraction(convB, undefined, { oneShot: lateB.call })
    await vi.waitFor(() => {
      expect(lateA.call).toHaveBeenCalledOnce()
      expect(lateB.call).toHaveBeenCalledOnce()
    })

    const uninstall = runtime.uninstallBot('alpha', { purge: true })
    // Alpha's provider ignores the abort and answers while the uninstall waits for it.
    await vi.waitFor(() => expect(lateA.signal()?.aborted).toBe(true))
    lateA.answer()
    await uninstall
    expect(await runA).toBe('cancelled')

    expect(suspend.mock.calls.map(([conversationId]) => conversationId)).toEqual([convA])
    expect(suspend.mock.invocationCallOrder[0]).toBeLessThan(deps.purgeConversation.mock.invocationCallOrder[0])
    expect(getConversation(convA)).toBeUndefined()
    expect(memorySpaceForConversation(convA)).toBeNull()
    expect(listLocalMemories('bot-self:alpha')).toEqual([])
    expect(getConsolidationState('bot-self:alpha')).toBeUndefined()
    expect(getExtractionState(convA)).toBeUndefined()
    expect(new BackgroundCompactionStore().get(convA)).toBeNull()
    expect(ownerSaves(tokenA)).toEqual([])

    // The other bot of the environment goes on.
    expect(lateB.signal()?.aborted).toBe(false)
    lateB.answer()
    expect(await runB).toBe('done')
    expect(listLocalMemories('bot-self:beta').map((memory) => memory.title)).toEqual(['Blue-green deploy'])
    expect(ownerSaves(tokenB)).toHaveLength(1)
    expect(new BackgroundCompactionStore().get(convB)?.pauseReason).not.toBe('suspended')
  })

  it('keeps an archived bot off the global compaction setting, across a restart, until it is installed again', async () => {
    const override = vi.spyOn(chatService, 'setConversationCompactionOverride')
    const first = await twoBots()
    seed(first.convA)
    const late = lateOneShot(extracted)
    const run = runMemoryExtraction(first.convA, undefined, { oneShot: late.call })
    await vi.waitFor(() => expect(late.call).toHaveBeenCalledOnce())
    override.mockClear()

    const archive = first.runtime.uninstallBot('alpha', { purge: false })
    await vi.waitFor(() => expect(late.signal()?.aborted).toBe(true))
    late.answer()
    await archive
    expect(await run).toBe('cancelled')
    // Its conversation, memories and settings stay; its compaction is off and suspended, never the global setting.
    expect(override.mock.calls).toEqual([[first.convA, disabled]])
    expect(getConversation(first.convA)).toBeDefined()
    expect(new BackgroundCompactionStore().get(first.convA)).toMatchObject({ pauseReason: 'suspended' })
    expect(new BackgroundCompactionStore().get(first.convB)?.pauseReason).not.toBe('suspended')
    expect(memorySpaceForConversation(first.convA)).toBeNull()
    expect(listLocalMemories('bot-self:alpha')).toEqual([])
    expect(ownerSaves(tokenA)).toEqual([])

    // A restart does not bring it back.
    await first.runtime.dispose()
    restartDb()
    const second = environment()
    await second.runtime.start()
    expect(second.runtime.bots().map((bot) => bot.botId)).toEqual(['beta'])
    expect(memorySpaceForConversation(first.convA)).toBeNull()
    expect(new BackgroundCompactionStore().get(first.convA)).toMatchObject({ pauseReason: 'suspended' })

    // Installed again, it resumes with its own conversation, settings and memory space.
    await second.runtime.installBot({ profile: profile('alpha', 'Alpha'), slot: 1, gatewayToken: tokenA })
    expect(second.runtime.bot('alpha').primaryConversationId).toBe(first.convA)
    expect(new BackgroundCompactionStore().get(first.convA)?.pauseReason).toBeUndefined()
    expect(override).toHaveBeenLastCalledWith(first.convA, {
      enabled: true,
      intervalTokens: 100_000,
      selection: { providerId: 'synthetic', modelId: 'model-a', effort: 'off', fastMode: false },
    })
    expect(memorySpaceForConversation(first.convA)).toEqual({ id: 'bot-self:alpha', kind: 'bot', roots: [] })
  })

  it('resumes an archived bot only once its own compaction settings are applied again', async () => {
    const first = await twoBots()
    const prepared = prepare(first.convA)
    await first.runtime.uninstallBot('alpha', { purge: false })
    expect(new BackgroundCompactionStore().get(first.convA)).toMatchObject({
      pauseReason: 'suspended',
      ready: { id: prepared.ready!.id },
    })
    await first.runtime.dispose()
    endProcess([first.convA, first.convB])
    restartDb()
    const capabilities = vi.mocked(chatService.listChatRunnerCapabilities)
    capabilities.mockRejectedValue(new Error('Accounts unavailable'))
    const override = vi.spyOn(chatService, 'setConversationCompactionOverride')
    const resume = vi.spyOn(chatService, 'resumeConversationBackgroundCompaction')
    const second = environment()
    await second.runtime.start()

    // Installed again while the accounts cannot be read: it stays suspended instead of following the global setting.
    await second.runtime.installBot({ profile: profile('alpha', 'Alpha'), slot: 1, gatewayToken: tokenA })
    expect(override.mock.calls.filter(([id]) => id === first.convA)).toEqual([])
    expect(resume).not.toHaveBeenCalled()
    expect(new BackgroundCompactionStore().get(first.convA)).toMatchObject({ pauseReason: 'suspended' })

    // Once they are read, its own settings come first, then the resume; the prepared compaction is still there.
    capabilities.mockResolvedValue([model])
    await second.runtime.bot('alpha').selections()
    const own = override.mock.calls.findIndex(([id]) => id === first.convA)
    expect(override.mock.calls.filter(([id]) => id === first.convA)).toEqual([[first.convA, enabled]])
    expect(resume.mock.calls).toEqual([[first.convA]])
    expect(resume.mock.invocationCallOrder[0]).toBeGreaterThan(override.mock.invocationCallOrder[own]!)
    const record = new BackgroundCompactionStore().get(first.convA)
    expect(record?.pauseReason).toBeUndefined()
    expect(record).toMatchObject({
      generation: prepared.generation,
      state: { status: 'ready' },
      ready: { id: prepared.ready!.id },
    })
    expect(getAppSetting('chat.backgroundCompaction')).toBeNull()
  })
})

describe('background work of an installed bot', () => {
  it('keeps the compaction a bot prepared across a restart, never passing it through "off"', async () => {
    // A single-bot container left an enabled global setting behind: the bots neither follow nor change it.
    const legacy = JSON.stringify({ ...enabled, selection: { ...enabled.selection, modelId: 'model-legacy' } })
    setAppSetting('chat.backgroundCompaction', legacy)
    const first = environment()
    await first.runtime.start()
    await first.runtime.installBot({ profile: profile('alpha', 'Alpha'), slot: 1, gatewayToken: tokenA })
    await first.runtime.installBot({
      profile: { ...profile('beta', 'Beta'), compaction: null },
      slot: 2,
      gatewayToken: tokenB,
    })
    const convA = first.runtime.bot('alpha').primaryConversationId!
    const convB = first.runtime.bot('beta').primaryConversationId!
    await first.runtime.dispose()
    endProcess([convA, convB])
    const prepared = prepare(convA)
    restartDb()
    const override = vi.spyOn(chatService, 'setConversationCompactionOverride')
    const second = environment()
    await second.runtime.start()

    // Alpha gets its own settings at once, and beta, without a compaction model, is off at once.
    expect(override.mock.calls).toEqual([
      [convA, enabled],
      [convB, disabled],
    ])
    expect(new BackgroundCompactionStore().get(convA)).toMatchObject({
      generation: prepared.generation,
      state: { status: 'ready' },
      ready: { id: prepared.ready!.id },
    })
    const alpha = second.runtime.bot('alpha')
    expect((await alpha.status()).compaction).toMatchObject({ configured: true, problem: null })
    await alpha.selections()
    expect(override).toHaveBeenCalledTimes(2)
    expect(new BackgroundCompactionStore().get(convA)?.ready?.id).toBe(prepared.ready!.id)
    expect(getAppSetting('chat.backgroundCompaction')).toBe(legacy)
  })

  it('waits for the account list at start instead of turning its compaction off', async () => {
    const first = await twoBots()
    await first.runtime.dispose()
    endProcess([first.convA, first.convB])
    const prepared = prepare(first.convA)
    restartDb()
    const capabilities = vi.mocked(chatService.listChatRunnerCapabilities)
    capabilities.mockRejectedValue(new Error('Accounts unavailable'))
    const override = vi.spyOn(chatService, 'setConversationCompactionOverride')
    const second = environment()
    await second.runtime.start()
    const alpha = second.runtime.bot('alpha')

    // Its model cannot be checked yet: no turn starts, and nothing changes its settings or prepared compaction.
    expect(override).not.toHaveBeenCalled()
    expect((await alpha.status()).compaction).toMatchObject({ configured: false, problem: 'unavailable' })
    expect(new BackgroundCompactionStore().get(first.convA)?.ready?.id).toBe(prepared.ready!.id)

    capabilities.mockResolvedValue([model])
    await alpha.selections()
    expect(override.mock.calls).toEqual([[first.convA, enabled]])
    expect(new BackgroundCompactionStore().get(first.convA)).toMatchObject({
      generation: prepared.generation,
      ready: { id: prepared.ready!.id },
    })
    expect((await alpha.status()).compaction).toMatchObject({ configured: true, problem: null })
  })

  it('gives a disposed bot no gateway access, even through a writer it handed out', async () => {
    const { runtime, convA } = await twoBots()
    const alpha = runtime.bot('alpha')
    const writer = getOwnerMemoryWriter(convA)!
    expect(alpha.gatewayConfig).toEqual({ url: 'http://gateway.test/', token: tokenA })
    const before = gateway.mock.calls.length

    // A normal shutdown: while it runs, the memory extraction may still hold the bot's writer.
    const disposing = alpha.dispose()
    expect(alpha.gatewayConfig).toBeNull()
    await expect(writer.save({ content: 'Prefer short answers.', origin: 'auto' })).rejects.toThrow(
      'Owner memory needs the gateway.'
    )
    expect(await writer.list()).toEqual([])
    await disposing
    expect(alpha.gatewayConfig).toBeNull()
    expect(gateway.mock.calls.slice(before)).toEqual([])
  })
})

describe('context limit of a bot conversation', () => {
  it('caps each bot at its own limit, follows a new profile, and drops the cap when uninstalled', async () => {
    const setup = environment()
    await setup.runtime.start()
    const limited = (contextLimitTokens: number): FleetInstanceProfile => ({
      ...profile('alpha', 'Alpha'),
      compaction: { ...compaction, contextLimitTokens },
    })
    await setup.runtime.installBot({ profile: limited(300_000), slot: 1, gatewayToken: tokenA })
    await setup.runtime.installBot({ profile: profile('beta', 'Beta'), slot: 2, gatewayToken: tokenB })
    const convA = setup.runtime.bot('alpha').primaryConversationId!
    const convB = setup.runtime.bot('beta').primaryConversationId!
    expect(getConversationContextLimit(convA)).toBe(300_000)
    expect(getConversationContextLimit(convB)).toBeUndefined()
    // Without a measured window yet, its usage reports the cap as its window.
    await vi.waitFor(async () =>
      expect((await setup.runtime.bot('alpha').status()).usage?.contextWindowTokens).toBe(300_000)
    )

    await setup.runtime.installBot({ profile: limited(150_000), slot: 1, gatewayToken: tokenA })
    expect(getConversationContextLimit(convA)).toBe(150_000)
    await vi.waitFor(async () =>
      expect((await setup.runtime.bot('alpha').status()).usage?.contextWindowTokens).toBe(150_000)
    )

    await setup.runtime.uninstallBot('alpha', { purge: false })
    expect(getConversationContextLimit(convA)).toBeUndefined()
    expect(getConversationContextLimit(convB)).toBeUndefined()
  })

  it("shows the new model's window as soon as the owner switches models", async () => {
    const modelB = { ...model, modelId: 'model-b' }
    vi.mocked(chatService.listChatRunnerCapabilities).mockResolvedValue([model, modelB])
    vi.mocked(chatService.effectiveModelMeta).mockImplementation(async (modelId: string) => ({
      meta: modelId === 'model-b' ? ({ contextWindow: 200_000 } as never) : null,
    }))
    const selected = (modelId: string): FleetInstanceProfile => ({
      ...profile('alpha', 'Alpha'),
      selection: { providerId: 'synthetic', modelId, reasoning: 'low', fastMode: false },
    })
    const setup = environment()
    await setup.runtime.start()
    await setup.runtime.installBot({ profile: selected('model-a'), slot: 1, gatewayToken: tokenA })
    const convA = setup.runtime.bot('alpha').primaryConversationId!
    upsertChatMessage({
      id: randomUUID(),
      conversationId: convA,
      role: 'assistant',
      createdAt: 2,
      parts: [{ type: 'text', id: randomUUID(), text: 'Understood.' }],
      contextSnapshot: {
        usedTokens: 50_000,
        modelContextWindow: 1_000_000,
        model: { providerId: 'synthetic', modelId: 'model-a' },
        quality: 'measured',
        observedAt: 2,
        sequence: 1,
      },
    })
    await setup.runtime.installBot({ profile: selected('model-a'), slot: 1, gatewayToken: tokenA })
    expect((await setup.runtime.bot('alpha').status()).usage).toMatchObject({
      contextUsedTokens: 50_000,
      contextWindowTokens: 1_000_000,
    })

    // No turn runs on the new model: its window comes from its metadata, not from the old model's sample.
    await setup.runtime.installBot({ profile: selected('model-b'), slot: 1, gatewayToken: tokenA })
    expect((await setup.runtime.bot('alpha').status()).usage).toMatchObject({
      contextUsedTokens: 50_000,
      contextWindowTokens: 200_000,
    })
  })
})
