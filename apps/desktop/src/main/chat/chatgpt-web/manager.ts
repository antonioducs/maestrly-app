/**
 * Global state for the "ChatGPT Web" companion integration: configuration, manual sessions, transport,
 * and Platform helpers used by the onboarding wizard.
 *
 * SHARED TRANSPORT: ONE loopback endpoint + ONE `tunnel-client` for the entire process, with an MCP
 * router routing by `session_key`. Multiple Maestrly conversations use the SAME ChatGPT app concurrently;
 * a `tunnel_id` accepts only one connected client, so multiplexing is required.
 *
 * The Platform API key is used ONLY for transport (`tunnel-client` authenticates the tunnel with it);
 * inference still uses the user's ChatGPT subscription in the chatgpt.com tab. Validated in the spike
 * with an organization holding NO API credits: the tunnel incurred no charge.
 */
import { createHash, randomBytes } from 'node:crypto'
import { app, net } from 'electron'
import { acquireRuntimeAssetLease } from '../../runtime-assets/app-service'
import {
  getAppSetting,
  getConversation,
  getConvUiPrefs,
  listAllConversations,
  patchConvUiPrefs,
  setAppSetting,
} from '../../store'
import { broadcast } from '../../window-ipc'
import { clearApiKey, getApiKey, hasApiKey, setApiKey } from '../credentials'
import { listMcpServers } from '../mcp'
import { CHATGPT_WEB_PROVIDER_ID, isChatGptWebEnabled } from '../catalog'
import {
  buildCompanionPrompt,
  createChatGptWebSession,
  deriveResumableSessionKey,
  type ChatGptWebSession,
} from './session'
import { createBridgeRouter, type BridgeRouter } from './bridge-router'
import { CHATGPT_WEB_TOOL_CATALOG_VERSION } from './bridge-protocol'
import { startBridgeHttp, type BridgeHttpEndpoint } from './bridge-http'
import { createTunnelRuntime, prepareTunnelClient, tunnelClientBinPath, type TunnelRuntime } from './tunnel-runtime'
import { listChecks, runCheck } from './checks'
import { createChatGptWebCompanionWindows, resumableChatGptConversationUrl } from './companion-window'
import { createReviewLoopController, type ReviewLoopController } from './review-loop'
import { lookupReviewLoopByConversation, releaseReviewLoop, reserveReviewLoop } from '../review-loop/registry'
import {
  createPlanReviewController,
  type PlanReviewController,
  type PlanReviewResolution,
  type PlanReviewTerminalOutcome,
} from './plan-review'
import { releasePlanRevision } from '../../plan-broker'
import { discoverPreviewTargets, prepareAndStartPreview, PreviewStartupError } from './preview-runtime'
import { createVisualBrowser } from './visual-browser'
import { createDrawerBrowserSession } from './drawer-browser-session'
import { createProjectEnvironmentJobController, type ProjectEnvironmentJobController } from './project-environment'
import { createChatGptWebMcpGateway } from './mcp-gateway'
import { createRepositoryScope, SINGLE_REPOSITORY_SELECTOR } from '../../repository-scope'
import { gitRead, type GitReadInput } from '../../git-read'
import { ghRead, type GhReadInput } from '../../gh-read'
import * as floatingManager from '../../floating-manager'
import * as popupManager from '../../popup-manager'
import { canonicalCwd } from '../../cwd-activity-coordinator'
import type {
  ChatGptWebCapabilities,
  ChatGptWebCapabilitiesInfo,
  ChatGptWebStatus,
  FrozenChatSelection,
  InternalTurnHandle,
  MessagePart,
} from '../../../shared/chat'
import {
  chatGptWebCapabilitiesInfo,
  remoteMcpServerCapabilities,
  resolveChatGptWebCapabilities,
} from './capability-policy'
import { isWorkspaceMemoryEnabled } from '../../memory/access'
import { getLocalMemory, markLocalMemoriesUsed } from '../../memory/local-memory-service'
import { getMemoryIndexStatus, reconcileMemoryIndex } from '../../memory/index'
import { retrieveHybridMemory } from '../../memory/retrieval'
import { discoverSharedKnowledge } from '../../memory/shared-knowledge'

const TUNNEL_ID_KEY = 'chat.chatgptWeb.tunnelId'
const APP_NAME_KEY = 'chat.chatgptWeb.appName'
const TOOL_CATALOG_REFRESH_VERSION_KEY = 'chat.chatgptWeb.toolCatalogRefreshVersion'
const DEFAULT_APP_NAME = 'Maestrly Bridge'
const PLATFORM_BASE = 'https://api.openai.com/v1'

const sessions = new Map<string, ChatGptWebSession>()
/** Per-conversation review-loop controller (created with the session; the loop lives as long as the session). */
const reviewLoopControllers = new Map<string, ReviewLoopController>()
/** Per-conversation Plan-tab review channel; survives brief companion-session rearms. */
const planReviewControllers = new Map<string, PlanReviewController>()
const projectEnvironmentControllers = new Map<string, ProjectEnvironmentJobController>()
/** Starts without a materialized session also own the transport; release must not overtake them. */
const sessionStarts = new Set<symbol>()
const sessionStartWaiters = new Set<() => void>()
/** `endSession` increments the epoch even before a session exists, cancelling a concurrent start. */
const sessionEpochs = new Map<string, number>()
/** Global shutdown boundary: no start begun before dispose may materialize afterward. */
let lifecycleEpoch = 0
/** After app teardown, no new companion resource may be materialized. */
let shuttingDown = false
/** Cookie/storage reset is a main-process barrier, never a decision entrusted to the renderer. */
let storageResetting = false
let storageResetPromise: Promise<void> | null = null
const listeners = new Set<() => void>()
const companionWindows = createChatGptWebCompanionWindows({
  loadConversationUrl: (conversationId) => getConvUiPrefs(conversationId).chatGptWebUrl,
  saveConversationUrl: (conversationId, url) => {
    patchConvUiPrefs(conversationId, { chatGptWebUrl: url })
    // The URL allows conversation resumption but does not prove knowledge of the current capability.
    // Only a tool call authenticated with the current key/fingerprint clears pairingRequired.
    emitChange()
  },
  clearConversationUrls: () => {
    for (const conversation of listAllConversations()) {
      if (
        conversation.uiPrefs?.chatGptWebUrl ||
        conversation.uiPrefs?.chatGptWebSessionScope ||
        conversation.uiPrefs?.chatGptWebPairedCapabilityFingerprint
      ) {
        patchConvUiPrefs(conversation.id, {
          chatGptWebUrl: undefined,
          chatGptWebSessionScope: undefined,
          chatGptWebPairedCapabilityFingerprint: undefined,
        })
      }
    }
  },
})

/** Remove a view from a popup/floating container before closing its WebContentsView. */
function releaseCompanionPlacement(conversationId: string): void {
  floatingManager.reattach(conversationId, 'chatgpt')
  popupManager.closePopup(conversationId, 'chatgpt')
}

/** Hooks depending on the rest of the app (plan, skills, project context), injected by the service. */
export interface ChatGptWebHooks {
  deliverChat: (conversationId: string, markdown: string, title?: string) => Promise<void> | void
  deliverPlan: (conversationId: string, plan: string, reviewId: string, title?: string) => Promise<void> | void
  turnCompleted: (conversationId: string) => void
  projectContext: (conversationId: string, cwd: string) => Promise<string> | string
  listSkills: (cwd: string, conversationId?: string) => Promise<Array<{ name: string; description: string }>>
  readSkill: (cwd: string, name: string) => Promise<string | null>
  getConversationContext: (conversationId: string, signal?: AbortSignal) => Promise<unknown> | unknown
  getConversationRevision: (conversationId: string, signal?: AbortSignal) => Promise<string | null> | string | null
  searchConversation: (
    conversationId: string,
    input: { query: string; limit?: number },
    signal?: AbortSignal
  ) => Promise<unknown> | unknown
  readConversation: (
    conversationId: string,
    input: { around_seq: number; limit?: number },
    signal?: AbortSignal
  ) => Promise<unknown> | unknown
  /**
   * Automatic review loop (ChatGPT Web reviewer → Maestrly Chat executor). If absent, reject review
   * tools in tools/call (the tools/list catalog remains stable and complete).
   */
  reviewLoop?: {
    validateStart: (conversationId: string) => Promise<{ ok: true } | { ok: false; error: string }>
    resolveSelection: (
      conversationId: string
    ) => Promise<{ ok: true; selection: FrozenChatSelection } | { ok: false; error: string }>
    revalidateSelection?: (selection: FrozenChatSelection) => Promise<{ ok: true } | { ok: false; error: string }>
    startInternalTurn: (input: {
      conversationId: string
      prompt: string
      hiddenParts: MessagePart[]
      selection: FrozenChatSelection
      loopId: string
      iteration: number
      maxIterations: number
      signal: AbortSignal
    }) => Promise<{ ok: true; handle: InternalTurnHandle } | { ok: false; error: string }>
    cancelInternalTurn: (executionId: string) => void
    persistSummary: (input: {
      conversationId: string
      loopId: string
      markdown: string
    }) => Promise<{ ok: true; messageId: string } | { ok: false; error: string }>
    forceAgentMode: (conversationId: string) => void
  }
}

let hooks: ChatGptWebHooks | null = null

export function setChatGptWebHooks(next: ChatGptWebHooks): void {
  hooks = next
}

function planReviewControllerFor(conversationId: string): PlanReviewController {
  const existing = planReviewControllers.get(conversationId)
  if (existing) return existing
  const created = createPlanReviewController(() => releasePlanRevision(conversationId, 'chatgpt-web'))
  planReviewControllers.set(conversationId, created)
  return created
}

export function resolvePlanReview(
  conversationId: string,
  reviewId: string,
  outcome: PlanReviewTerminalOutcome
): PlanReviewResolution {
  const controller = planReviewControllers.get(conversationId)
  return controller?.resolve(reviewId, outcome) ?? { ok: false, error: 'plan-review-not-found' }
}

/** Permanent conversation disposal; endSession alone preserves the controller for safe rearming. */
export function discardPlanReviews(conversationId: string): void {
  planReviewControllers.get(conversationId)?.dispose()
  planReviewControllers.delete(conversationId)
}

function emitChange(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      /* one broken observer cannot disrupt the others */
    }
  }
}

/** Observe status changes (the service uses this to broadcast to the renderer). */
export function onChatGptWebChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// ------------------------------------------------------------------ configuration

export function getTunnelId(): string {
  return (getAppSetting(TUNNEL_ID_KEY) ?? '').trim()
}

function clearConversationSessionScopes(): void {
  for (const conversation of listAllConversations()) {
    if (conversation.uiPrefs?.chatGptWebSessionScope) {
      patchConvUiPrefs(conversation.id, {
        chatGptWebSessionScope: undefined,
        chatGptWebPairedCapabilityFingerprint: undefined,
      })
    }
  }
}

export function setTunnelId(tunnelId: string): void {
  const next = tunnelId.trim()
  if (next !== getTunnelId()) clearConversationSessionScopes()
  setAppSetting(TUNNEL_ID_KEY, next)
  emitChange()
}

export function getAppName(): string {
  return (getAppSetting(APP_NAME_KEY) ?? '').trim() || DEFAULT_APP_NAME
}

export function setAppName(name: string): void {
  setAppSetting(APP_NAME_KEY, name.trim())
  emitChange()
}

export function setPlatformApiKey(key: string): void {
  if (key.trim() !== (getApiKey(CHATGPT_WEB_PROVIDER_ID) ?? '')) clearConversationSessionScopes()
  setApiKey(CHATGPT_WEB_PROVIDER_ID, key)
  emitChange()
}

export function clearPlatformApiKey(): void {
  if (getApiKey(CHATGPT_WEB_PROVIDER_ID)) clearConversationSessionScopes()
  clearApiKey(CHATGPT_WEB_PROVIDER_ID)
  emitChange()
}

export function hasPlatformApiKey(): boolean {
  return hasApiKey(CHATGPT_WEB_PROVIDER_ID)
}

/** Minimum configuration required to arm a session. */
export function isConfigured(): boolean {
  return !!getTunnelId() && hasPlatformApiKey() && !!tunnelClientBinPath()
}

/**
 * The credential/tunnel_id identifies the entire transport, not one session. Changing it while the
 * bridge is in use would leave status and daemon pointing to different configurations; the UI ends
 * sessions (or the probe) before allowing the change.
 */
export function transportConfigurationLocked(): boolean {
  return (
    shuttingDown ||
    storageResetting ||
    transportConfigurationMutationCount > 0 ||
    sessionStarts.size > 0 ||
    sessions.size > 0 ||
    !!probeTimer ||
    !!transportStarting ||
    !!transportStopping ||
    !!runtime?.isRunning()
  )
}

/** Already materialized resources that prevent persisting a different transport identity. */
export function transportConfigurationHasActiveResources(): boolean {
  return (
    shuttingDown ||
    storageResetting ||
    sessionStarts.size > 0 ||
    sessions.size > 0 ||
    !!probeTimer ||
    !!transportStarting ||
    !!transportStopping ||
    !!runtime?.isRunning()
  )
}

export function transportConfigurationMutationPending(): boolean {
  return transportConfigurationMutationCount > 0
}

/** Serialize configuration and hold the barrier throughout asynchronous Platform calls. */
export function withTransportConfigurationMutation<T>(operation: () => Promise<T>): Promise<T> {
  // Increment before the first await: starts/probes in the same tick already see configuration as busy.
  transportConfigurationMutationCount++
  const previous = transportConfigurationMutationTail
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const current = previous.then(() => gate)
  transportConfigurationMutationTail = current

  return (async () => {
    await previous
    try {
      return await operation()
    } finally {
      transportConfigurationMutationCount--
      release()
    }
  })()
}

export async function waitForTransportConfigurationMutations(): Promise<void> {
  await transportConfigurationMutationTail
}

// ------------------------------------------------------------------ Platform API (wizard)

async function platformRequest<T>(
  path: string,
  init: { method?: string; body?: unknown; apiKey?: string }
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  const key = init.apiKey ?? getApiKey(CHATGPT_WEB_PROVIDER_ID) ?? ''
  if (!key) return { ok: false, status: 0, error: 'missing-api-key' }
  try {
    const res = await net.fetch(`${PLATFORM_BASE}${path}`, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    })
    const text = await res.text()
    if (!res.ok) {
      let message = text.slice(0, 400)
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } }
        if (parsed.error?.message) message = parsed.error.message
      } catch {
        /* non-JSON body: retain the raw text */
      }
      return { ok: false, status: res.status, error: message }
    }
    return { ok: true, data: (text ? JSON.parse(text) : {}) as T }
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

export interface TunnelPrincipals {
  organizations: Array<{ id: string; name: string }>
  workspaces: Array<{ id: string; name: string }>
}

/** Platform organizations + eligible ChatGPT workspaces. Also validates the API key. */
export function listTunnelPrincipals(apiKey?: string) {
  return platformRequest<TunnelPrincipals>('/tunnels/principals', { apiKey })
}

export interface TunnelSummary {
  id: string
  name?: string
  description?: string
  workspace_ids?: string[]
  organization_ids?: string[]
}

export function listTunnels(apiKey?: string) {
  return platformRequest<{ data?: TunnelSummary[] } & { tunnels?: TunnelSummary[] }>('/tunnels', { apiKey })
}

/**
 * Create the tunnel already associated with the organization + ChatGPT workspace (the WORKSPACE
 * association makes the tunnel appear in the dropdown when creating the app at chatgpt.com/plugins).
 *
 * ⚠️ `description` is REQUIRED by the API (otherwise 400); the Platform UI has the same requirement
 * but leaves Create disabled without explanation. Discovered during the spike.
 */
export async function createTunnel(input: { name: string; description: string; apiKey?: string }) {
  const principals = await listTunnelPrincipals(input.apiKey)
  if (!principals.ok) return principals
  const organizationIds = principals.data.organizations?.map((org) => org.id) ?? []
  const workspaceIds = principals.data.workspaces?.map((workspace) => workspace.id) ?? []
  return platformRequest<TunnelSummary>('/tunnels', {
    method: 'POST',
    apiKey: input.apiKey,
    body: {
      name: input.name,
      description: input.description,
      ...(organizationIds.length ? { organization_ids: organizationIds } : {}),
      ...(workspaceIds.length ? { workspace_ids: workspaceIds } : {}),
    },
  })
}

// ------------------------------------------------------------------ shared transport

/**
 * ONE router + ONE endpoint + ONE `tunnel-client` for all sessions. Start with the first session
 * (or wizard probe) and stop when unused; reconnecting takes seconds, and keeping an idle daemon
 * alive brings no benefit.
 */
let router: BridgeRouter | null = null
let endpoint: BridgeHttpEndpoint | null = null
let runtime: TunnelRuntime | null = null
let runtimeAssetError: string | null = null
let transportStarting: Promise<void> | null = null
let transportStopping: Promise<void> | null = null
/** Credential/tunnel mutations remain serialized through all network awaits. */
let transportConfigurationMutationCount = 0
let transportConfigurationMutationTail: Promise<void> = Promise.resolve()

function getRouter(): BridgeRouter {
  router ??= createBridgeRouter({
    lastRefreshedToolCatalogVersion: getAppSetting(TOOL_CATALOG_REFRESH_VERSION_KEY),
    onToolCatalogRefreshed: (version) => {
      setAppSetting(TOOL_CATALOG_REFRESH_VERSION_KEY, version)
      emitChange()
    },
  })
  return router
}

function appRefreshRequired(): boolean {
  return (
    router?.appRefreshRequired() ?? getAppSetting(TOOL_CATALOG_REFRESH_VERSION_KEY) !== CHATGPT_WEB_TOOL_CATALOG_VERSION
  )
}

async function ensureTransport(): Promise<void> {
  if (shuttingDown) throw new Error('shutdown')
  if (storageResetting) throw new Error('storage-resetting')
  if (transportConfigurationMutationPending()) throw new Error('configuration-busy')
  if (runtime?.isRunning()) return
  if (transportStopping) {
    await transportStopping
    if (shuttingDown) throw new Error('shutdown')
    if (storageResetting) throw new Error('storage-resetting')
    if (runtime?.isRunning()) return
  }
  if (transportStarting) return transportStarting
  const tunnelId = getTunnelId()
  const apiKey = getApiKey(CHATGPT_WEB_PROVIDER_ID)
  if (!tunnelId || !apiKey) throw new Error('not-configured')
  transportStarting = (async () => {
    const binaryPath = await prepareTunnelClient(true)
    endpoint ??= await startBridgeHttp(getRouter())
    const assetLease = app.isPackaged ? await acquireRuntimeAssetLease('tunnel-client', binaryPath) : null
    const created = createTunnelRuntime({
      tunnelId,
      apiKey,
      mcpServerUrl: endpoint.url,
      binaryPath,
      onStopped: () => assetLease?.release(),
      onState: () => emitChange(),
    })
    runtime = created
    try {
      await created.start()
    } catch (error) {
      runtime = null
      throw error
    }
  })()
  try {
    await transportStarting
  } finally {
    transportStarting = null
  }
}

/** Stop the transport when no sessions or probes remain. */
async function releaseTransport(): Promise<void> {
  if (transportStarting) await transportStarting.catch(() => undefined)
  if (transportStopping) {
    await transportStopping.catch(() => undefined)
    if (sessionStarts.size > 0 || sessions.size > 0 || probeTimer) return
  }
  if (sessionStarts.size > 0 || sessions.size > 0 || probeTimer) return
  const current = runtime
  const currentEndpoint = endpoint
  if (!current && !currentEndpoint) return
  runtime = null
  endpoint = null
  const stopping = (async () => {
    await current?.stop().catch(() => undefined)
    await currentEndpoint?.close().catch(() => undefined)
  })()
  transportStopping = stopping
  try {
    await stopping
  } finally {
    if (transportStopping === stopping) transportStopping = null
  }
}

// ------------------------------------------------------------------ wizard probe (create/update app)

/**
 * PROBE: keep transport running WITHOUT a conversation so ChatGPT can create/update the app.
 *
 * OpenAI requirement: when creating the app (or clicking Refresh on its page), ChatGPT performs the
 * MCP handshake IMMEDIATELY over the tunnel; without `tunnel-client` running at the other end, the UI
 * returns "Error creating connector". Without registered sessions, the router answers `tools/list`
 * normally and rejects other tools, so no repository content is exposed during setup.
 */
const PROBE_TTL_MS = 15 * 60 * 1000

let probeTimer: NodeJS.Timeout | null = null
let probeEpoch = 0

function waitForSessionStarts(): Promise<void> {
  if (sessionStarts.size === 0) return Promise.resolve()
  return new Promise<void>((resolve) => sessionStartWaiters.add(resolve))
}

function releaseSessionStart(lease: symbol): void {
  sessionStarts.delete(lease)
  if (sessionStarts.size !== 0) return
  for (const resolve of sessionStartWaiters) resolve()
  sessionStartWaiters.clear()
}

function startIsCurrent(conversationId: string, epoch: number, managerEpoch: number): boolean {
  return (
    !shuttingDown &&
    !storageResetting &&
    lifecycleEpoch === managerEpoch &&
    (sessionEpochs.get(conversationId) ?? 0) === epoch &&
    isChatGptWebEnabled()
  )
}

export async function startTunnelProbe(): Promise<{ ok: boolean; error?: string }> {
  if (shuttingDown) return { ok: false, error: 'shutdown' }
  if (storageResetting) return { ok: false, error: 'storage-resetting' }
  if (transportConfigurationMutationPending()) return { ok: false, error: 'configuration-busy' }
  const currentProbeEpoch = ++probeEpoch
  try {
    if (probeTimer) clearTimeout(probeTimer)
    probeTimer = setTimeout(() => {
      if (probeEpoch === currentProbeEpoch) void stopTunnelProbe()
    }, PROBE_TTL_MS)
    probeTimer.unref?.()
    await ensureTransport()
    if (probeEpoch !== currentProbeEpoch || shuttingDown || storageResetting || !probeTimer) {
      await releaseTransport()
      return { ok: false, error: 'probe-canceled' }
    }
    emitChange()
    return { ok: true }
  } catch (error) {
    if (probeEpoch === currentProbeEpoch) {
      if (probeTimer) clearTimeout(probeTimer)
      probeTimer = null
    }
    await releaseTransport()
    emitChange()
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function stopTunnelProbe(): Promise<void> {
  probeEpoch++
  if (probeTimer) clearTimeout(probeTimer)
  probeTimer = null
  await releaseTransport()
  emitChange()
}

// ------------------------------------------------------------------ sessions

export function sessionForConversation(conversationId: string): ChatGptWebSession | null {
  const session = sessions.get(conversationId)
  return session && session.getState() !== 'ended' ? session : null
}

export function listSessions(): ChatGptWebSession[] {
  return [...sessions.values()]
}

export function capabilitiesForConversation(conversationId: string): ChatGptWebCapabilitiesInfo {
  const prefs = getConvUiPrefs(conversationId)
  return chatGptWebCapabilitiesInfo(
    prefs.chatGptWebCapabilities,
    listMcpServers(),
    sessionForConversation(conversationId) === null
  )
}

/** Main-validated persistence boundary. A live session is immutable and cannot be escalated in place. */
export function setCapabilitiesForConversation(
  conversationId: string,
  input: ChatGptWebCapabilities
): ChatGptWebCapabilitiesInfo {
  if (sessionForConversation(conversationId)) throw new Error('companion-session-active')
  const servers = listMcpServers()
  const sanitized = resolveChatGptWebCapabilities(input, servers)
  patchConvUiPrefs(conversationId, { chatGptWebCapabilities: sanitized })
  emitChange()
  return chatGptWebCapabilitiesInfo(sanitized, servers, true)
}

export interface StartSessionInput {
  conversationId: string
  cwd: string
  gitBase?: string
}

export function companionNeedsPairing(conversationId: string): boolean {
  const prefs = getConvUiPrefs(conversationId)
  const fingerprint = capabilitiesForConversation(conversationId).fingerprint
  return (
    !/^[0-9a-f]{32}$/.test(prefs.chatGptWebSessionScope?.trim() ?? '') ||
    !resumableChatGptConversationUrl(prefs.chatGptWebUrl) ||
    prefs.chatGptWebPairedCapabilityFingerprint !== fingerprint
  )
}

function sessionKeyForConversation(conversationId: string, capabilityFingerprint: string): string {
  const platformKey = getApiKey(CHATGPT_WEB_PROVIDER_ID)
  const tunnelId = getTunnelId()
  if (!platformKey || !tunnelId) throw new Error('not-configured')
  const prefs = getConvUiPrefs(conversationId)
  let sessionScope = prefs.chatGptWebSessionScope?.trim() ?? ''
  if (!/^[0-9a-f]{32}$/.test(sessionScope)) {
    sessionScope = randomBytes(16).toString('hex')
    patchConvUiPrefs(conversationId, { chatGptWebSessionScope: sessionScope })
  }
  return deriveResumableSessionKey({ platformKey, tunnelId, conversationId, sessionScope, capabilityFingerprint })
}

function rollbackSession(conversationId: string, created: ChatGptWebSession, sessionRouter: BridgeRouter): void {
  reviewLoopControllers.get(conversationId)?.dispose()
  reviewLoopControllers.delete(conversationId)
  projectEnvironmentControllers.get(conversationId)?.stop()
  projectEnvironmentControllers.delete(conversationId)
  sessionRouter.unregister(created.sessionKey)
  if (sessions.get(conversationId) === created) sessions.delete(conversationId)
  created.end()
  releaseCompanionPlacement(conversationId)
  companionWindows.close(conversationId)
}

export async function startSession(input: StartSessionInput): Promise<{ ok: boolean; error?: string }> {
  if (!isChatGptWebEnabled()) return { ok: false, error: 'feature-disabled' }
  if (shuttingDown) return { ok: false, error: 'shutdown' }
  if (storageResetting) return { ok: false, error: 'storage-resetting' }
  if (transportConfigurationMutationPending()) return { ok: false, error: 'configuration-busy' }
  const epoch = sessionEpochs.get(input.conversationId) ?? 0
  const managerEpoch = lifecycleEpoch
  const lease = Symbol(input.conversationId)
  let provisionalBrowser: ReturnType<typeof createDrawerBrowserSession> | null = null
  let provisionalEnvironment: ProjectEnvironmentJobController | null = null
  sessionStarts.add(lease)
  try {
    const existing = sessionForConversation(input.conversationId)
    if (existing) {
      await ensureTransport()
      if (!startIsCurrent(input.conversationId, epoch, managerEpoch)) {
        return { ok: false, error: 'session-canceled' }
      }
      return { ok: true }
    }

    await ensureTransport()
    // Clear/end/disable may occur while the daemon starts. The epoch prevents the asynchronous
    // continuation from resurrecting a session that has already crossed this lifecycle boundary.
    if (!startIsCurrent(input.conversationId, epoch, managerEpoch)) {
      return { ok: false, error: 'session-canceled' }
    }
    // Two invokes may await the same transport start. Only the first creates the session;
    // the second reuses the winner, leaving no orphan bridge registered in the router.
    const raced = sessionForConversation(input.conversationId)
    if (raced) {
      if (!startIsCurrent(input.conversationId, epoch, managerEpoch)) {
        return { ok: false, error: 'session-canceled' }
      }
      return { ok: true }
    }
    const mcpServers = listMcpServers()
    const conversation = getConversation(input.conversationId)
    if (!conversation) throw new Error('invalid-conversation')
    const repositoryScope = await createRepositoryScope(conversation)
    const capabilityInfo = chatGptWebCapabilitiesInfo(
      getConvUiPrefs(input.conversationId).chatGptWebCapabilities,
      mcpServers,
      false
    )
    const memoryRoots = repositoryScope.repositories.map((repository) => ({
      root: repository.realWorktreePath,
      linkName: repository.linkName,
    }))
    const localMemoryAllowed = capabilityInfo.capabilities.memory === 'read'
    const assertMemoryEnabled = () => {
      if (!isWorkspaceMemoryEnabled(conversation.workspaceId)) throw new Error('memory-disabled')
    }
    const publicRepositoryId = (root: string): string | undefined => {
      const match = repositoryScope.repositories.find(
        (repository) =>
          repository.realWorktreePath === root ||
          repository.linkName === root ||
          (!repository.linkName && root === SINGLE_REPOSITORY_SELECTOR)
      )
      return match ? match.linkName || SINGLE_REPOSITORY_SELECTOR : undefined
    }
    const sessionKey = sessionKeyForConversation(input.conversationId, capabilityInfo.fingerprint)
    const mcpGateway = createChatGptWebMcpGateway({
      servers: mcpServers,
      scopes: capabilityInfo.capabilities.mcp,
    })
    const planReviewController = planReviewControllerFor(input.conversationId)
    const browserSession = createDrawerBrowserSession({ conversationId: input.conversationId })
    provisionalBrowser = browserSession
    const projectEnvironment = createProjectEnvironmentJobController({
      conversationId: input.conversationId,
      sessionActive: () => {
        const session = sessions.get(input.conversationId)
        return !!session && session.getState() !== 'ended'
      },
      validateStart: async () => {
        if (!hooks?.reviewLoop) return { ok: false, error: 'review-loop-unavailable' }
        if (reviewLoopControllers.get(input.conversationId)?.busy()) {
          return { ok: false, error: 'review-loop-active' }
        }
        return hooks.reviewLoop.validateStart(input.conversationId)
      },
      resolveSelection: async () => {
        if (!hooks?.reviewLoop) return { ok: false, error: 'review-loop-unavailable' }
        return hooks.reviewLoop.resolveSelection(input.conversationId)
      },
      startTurn: async ({ prompt, selection, jobId, signal }) => {
        if (!hooks?.reviewLoop) return { ok: false, error: 'review-loop-unavailable' }
        return hooks.reviewLoop.startInternalTurn({
          conversationId: input.conversationId,
          prompt,
          hiddenParts: [],
          selection,
          loopId: jobId,
          iteration: 1,
          maxIterations: 1,
          signal,
        })
      },
      cancelTurn: (executionId) => hooks?.reviewLoop?.cancelInternalTurn(executionId),
      forceAgentMode: () => hooks?.reviewLoop?.forceAgentMode(input.conversationId),
      onChange: emitChange,
    })
    provisionalEnvironment = projectEnvironment
    projectEnvironmentControllers.set(input.conversationId, projectEnvironment)
    // Create the review-loop controller with the session (which supplies bridge and state). The
    // conversation lock (activeLoopId) begins at start_review_loop; session teardown cancels the loop.
    const controller = createReviewLoopController({
      conversationId: input.conversationId,
      cwd: input.cwd,
      // The key NEVER enters loop state; only an opaque hash is retained for auditing.
      sessionKeyHash: createHash('sha256').update(sessionKey).digest('hex'),
      sessionActive: () => {
        const session = sessions.get(input.conversationId)
        return !!session && session.getState() !== 'ended'
      },
      validateStart: async () => {
        if (!hooks?.reviewLoop) return { ok: false, error: 'review-loop-unavailable' }
        if (projectEnvironment.info()) return { ok: false, error: 'project-environment-active' }
        return hooks.reviewLoop.validateStart(input.conversationId)
      },
      resolveSelection: async () => {
        if (!hooks?.reviewLoop) return { ok: false, error: 'review-loop-unavailable' }
        return hooks.reviewLoop.resolveSelection(input.conversationId)
      },
      revalidateSelection: async (selection) => {
        if (!hooks?.reviewLoop?.revalidateSelection) return { ok: true }
        return hooks.reviewLoop.revalidateSelection(selection)
      },
      startTurn: async ({ prompt, hiddenParts, selection, loopId, iteration, maxIterations, signal }) => {
        if (!hooks?.reviewLoop) return { ok: false, error: 'review-loop-unavailable' }
        return hooks.reviewLoop.startInternalTurn({
          conversationId: input.conversationId,
          prompt,
          hiddenParts,
          selection,
          loopId,
          iteration,
          maxIterations,
          signal,
        })
      },
      cancelTurn: (executionId) => hooks?.reviewLoop?.cancelInternalTurn(executionId),
      getBridgeEvidence: (loopId) =>
        sessions.get(input.conversationId)?.bridge.getReviewEvidence(loopId) ?? {
          contextLoaded: false,
          byIteration: {},
          checks: [],
        },
      setReviewIteration: (loopId, iteration) =>
        sessions.get(input.conversationId)?.bridge.setReviewIteration(loopId, iteration),
      clearReviewIteration: (loopId) => sessions.get(input.conversationId)?.bridge.clearReviewIteration(loopId),
      forgetReviewLoop: (loopId) => sessions.get(input.conversationId)?.bridge.forgetReviewLoop(loopId),
      persistSummary: async ({ loopId, markdown }) => {
        if (!hooks?.reviewLoop) return { ok: false as const, error: 'review-loop-unavailable' }
        return hooks.reviewLoop.persistSummary({ conversationId: input.conversationId, loopId, markdown })
      },
      forceAgentMode: () => hooks?.reviewLoop?.forceAgentMode(input.conversationId),
      reserveParticipants: (loopId) => {
        const result = reserveReviewLoop({
          loopId,
          driver: 'chatgpt-web',
          cwd: canonicalCwd(input.cwd),
          participants: [{ driver: 'chatgpt-web', conversationId: input.conversationId }],
        })
        return result.ok ? { ok: true as const } : { ok: false as const, error: 'review-loop-active' }
      },
      releaseParticipants: (loopId) => {
        releaseReviewLoop(loopId)
      },
      discoverFrontendPreviews: () => discoverPreviewTargets(input.cwd),
      prepareFrontendEnvironment: async ({ loopId, previewId, signal, onStateChange }) => {
        if (capabilityInfo.capabilities.browser === 'off') throw new Error('browser-capability-off')
        const preview = await prepareAndStartPreview(input.cwd, { targetId: previewId }, { signal })
        try {
          const browserStartup = createVisualBrowser({ loopId, url: preview.url, signal, onStateChange })
          const processExit = preview.waitForExit?.()
          const outcome = processExit
            ? await Promise.race([
                browserStartup.then((browser) => ({ browser })),
                processExit.then((error) => ({ error })),
              ])
            : { browser: await browserStartup }
          if ('error' in outcome) {
            // Browser startup has its own bounded deadline. If it completes after the process already
            // exited, immediately tear down that late surface instead of leaking an orphan window.
            void browserStartup.then(
              (lateBrowser) => lateBrowser.dispose(),
              () => undefined
            )
            throw outcome.error
          }
          const browser = outcome.browser
          if (preview.running?.() === false) {
            await browser.dispose()
            throw await preview.waitForExit?.()
          }
          return { preview, browser }
        } catch (error) {
          await preview.dispose()
          if (error instanceof PreviewStartupError) throw error
          throw new PreviewStartupError(
            `Visual review browser failed: ${error instanceof Error ? error.message : String(error)}`,
            preview.diagnosticOutput?.() ?? ''
          )
        }
      },
      prepareAttachedFrontendEnvironment: ({ browserId, signal, onStateChange }) =>
        browserSession.createReviewSurface({ browserId, signal, onStateChange }),
      onChange: emitChange,
    })
    reviewLoopControllers.set(input.conversationId, controller)
    const created = createChatGptWebSession({
      conversationId: input.conversationId,
      cwd: input.cwd,
      gitBase: input.gitBase,
      pairingRequired: companionNeedsPairing(input.conversationId),
      capabilityFingerprint: capabilityInfo.fingerprint,
      capabilitySummary: {
        fingerprint: capabilityInfo.fingerprint,
        gitRead: capabilityInfo.capabilities.git === 'read',
        ghRead: capabilityInfo.capabilities.gh === 'read',
        conversation: capabilityInfo.capabilities.conversation,
        memory: capabilityInfo.capabilities.memory,
        browser: capabilityInfo.capabilities.browser,
        mcpRead: Object.values(capabilityInfo.capabilities.mcp).filter((scope) => scope === 'read').length,
        mcpWrite: Object.values(capabilityInfo.capabilities.mcp).filter((scope) => scope === 'write').length,
      },
      onPaired: (fingerprint) =>
        patchConvUiPrefs(input.conversationId, { chatGptWebPairedCapabilityFingerprint: fingerprint }),
      // The remote transcript keeps using the original key. Rebuild the same capability when this
      // conversation is re-armed; it remains inaccessible while no bridge is registered in the router.
      sessionKey,
      onChange: emitChange,
      onTurnCompleted: () => {
        // A completed Web turn without a new delivery releases only the Web reservation; a concurrent
        // Maestrly reservation remains owned by the local runner.
        releasePlanRevision(input.conversationId, 'chatgpt-web')
        try {
          hooks?.turnCompleted(input.conversationId)
        } catch {
          /* the alert is best-effort; observer failures never terminate the session */
        }
      },
      bridge: {
        deliver: async (delivery) => {
          if (!hooks) throw new Error('delivery-unavailable')
          if (delivery.destination === 'plan') {
            if (!delivery.planReviewId) throw new Error('plan-review-id-missing')
            await hooks.deliverPlan(input.conversationId, delivery.markdown, delivery.planReviewId, delivery.title)
          } else {
            await hooks.deliverChat(input.conversationId, delivery.markdown, delivery.title)
          }
        },
        planReview: planReviewController,
        projectContext: () => hooks?.projectContext(input.conversationId, input.cwd) ?? '',
        listSkills: () => hooks?.listSkills(input.cwd, input.conversationId) ?? [],
        readSkill: (name) => hooks?.readSkill(input.cwd, name) ?? null,
        ...(capabilityInfo.capabilities.conversation === 'read'
          ? {
              conversation: {
                getContext: (signal?: AbortSignal) => {
                  if (!hooks) throw new Error('conversation-context-unavailable')
                  return hooks.getConversationContext(input.conversationId, signal)
                },
                getRevision: (signal?: AbortSignal) => {
                  if (!hooks) throw new Error('conversation-context-unavailable')
                  return hooks.getConversationRevision(input.conversationId, signal)
                },
                search: (args: { query: string; limit?: number }, signal?: AbortSignal) => {
                  if (!hooks) throw new Error('conversation-context-unavailable')
                  return hooks.searchConversation(input.conversationId, args, signal)
                },
                read: (args: { around_seq: number; limit?: number }, signal?: AbortSignal) => {
                  if (!hooks) throw new Error('conversation-context-unavailable')
                  return hooks.readConversation(input.conversationId, args, signal)
                },
              },
            }
          : {}),
        memory: {
          status: async () => {
            if (!isWorkspaceMemoryEnabled(conversation.workspaceId)) {
              return {
                enabled: false,
                state: 'disabled',
                localAccess: localMemoryAllowed ? 'read' : 'off',
                documents: 0,
                instruction: 'Memory is disabled for this project.',
              }
            }
            await reconcileMemoryIndex(conversation.workspaceId, memoryRoots)
            const status = await getMemoryIndexStatus(conversation.workspaceId)
            const visibleDocuments = status.sharedDocuments + (localMemoryAllowed ? status.localDocuments : 0)
            return {
              enabled: true,
              state: status.state,
              localAccess: localMemoryAllowed ? 'read' : 'off',
              documents: visibleDocuments,
              sharedDocuments: status.sharedDocuments,
              ...(localMemoryAllowed ? { localDocuments: status.localDocuments } : {}),
              instruction: 'Use search_project_memory to retrieve relevant sources on demand.',
            }
          },
          search: async (memoryArgs: { query: string; limit?: number; repo?: string }) => {
            assertMemoryEnabled()
            const selectedRoots = memoryArgs.repo
              ? [
                  {
                    root: repositoryScope.resolveRepository(memoryArgs.repo).realWorktreePath,
                    linkName: repositoryScope.resolveRepository(memoryArgs.repo).linkName,
                  },
                ]
              : memoryRoots
            const hits = await retrieveHybridMemory({
              workspaceId: conversation.workspaceId,
              query: memoryArgs.query,
              roots: selectedRoots,
              limit: memoryArgs.limit ?? 5,
              maxChars: 8 * 1024,
              markUsed: localMemoryAllowed,
            })
            return hits
              .filter((hit) => hit.kind === 'shared' || localMemoryAllowed)
              .map((hit) => ({
                kind: hit.kind,
                id: hit.id,
                title: hit.title,
                type: hit.type,
                scope: hit.scope,
                tags: hit.tags,
                snippet: hit.content.slice(0, 4_000),
                ...(hit.kind === 'shared'
                  ? {
                      repo: hit.repo ? publicRepositoryId(hit.repo) : undefined,
                      path: hit.path,
                      heading: hit.heading,
                      startLine: hit.startLine,
                      endLine: hit.endLine,
                    }
                  : {}),
              }))
          },
          read: async (memoryArgs: { kind: 'local' | 'shared'; id: string; repo?: string; path?: string }) => {
            assertMemoryEnabled()
            if (memoryArgs.kind === 'local') {
              if (!localMemoryAllowed) throw new Error('memory-local-capability-off')
              const memory = getLocalMemory(conversation.workspaceId, memoryArgs.id)
              if (memory?.status !== 'active') throw new Error('memory-source-not-found')
              markLocalMemoriesUsed(conversation.workspaceId, [memory.id])
              return { ...memory, content: memory.content.slice(0, 64 * 1024) }
            }
            const repository = repositoryScope.resolveRepository(memoryArgs.repo)
            const discovery = await discoverSharedKnowledge(repository.realWorktreePath)
            const document = discovery.documents.find(
              (candidate) =>
                candidate.id === memoryArgs.id && (!memoryArgs.path || candidate.relativePath === memoryArgs.path)
            )
            if (!document?.eligibleForContext) throw new Error('memory-source-not-found')
            return {
              kind: 'shared',
              id: document.id,
              title: document.title,
              type: document.type,
              status: document.status,
              scope: document.scope,
              tags: document.tags,
              repo: repository.linkName || SINGLE_REPOSITORY_SELECTOR,
              path: document.relativePath,
              provenance: document.provenance,
              content: document.content.slice(0, 64 * 1024),
              truncated: document.content.length > 64 * 1024,
            }
          },
        },
        listChecks: () => listChecks(input.cwd),
        runCheck: (name, signal) => runCheck(input.cwd, name, signal),
        reviewLoop: controller,
        browserSession,
        projectEnvironment,
        browserCapability: capabilityInfo.capabilities.browser,
        repositoryScope,
        gitReadEnabled: capabilityInfo.capabilities.git === 'read',
        external: {
          listCapabilities: () => ({
            repositories: repositoryScope.repositories.map((repository) => ({
              id: repository.linkName || SINGLE_REPOSITORY_SELECTOR,
              name: repository.linkName || SINGLE_REPOSITORY_SELECTOR,
            })),
            git: capabilityInfo.capabilities.git,
            gh: capabilityInfo.capabilities.gh,
            conversation: capabilityInfo.capabilities.conversation,
            memory: capabilityInfo.capabilities.memory,
            mcpServers: remoteMcpServerCapabilities(capabilityInfo.capabilities, mcpServers),
          }),
          searchMcpTools: (args, signal) =>
            mcpGateway.searchTools(
              {
                query: typeof args.query === 'string' ? args.query : '',
                serverId: typeof args.server_id === 'string' ? args.server_id : undefined,
                limit: typeof args.limit === 'number' ? args.limit : undefined,
              },
              signal
            ),
          callMcpRead: (args, signal) =>
            mcpGateway.callReadTool(
              {
                serverId: typeof args.server_id === 'string' ? args.server_id : '',
                toolName: typeof args.tool_name === 'string' ? args.tool_name : '',
                arguments:
                  args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
                    ? (args.arguments as Record<string, unknown>)
                    : {},
              },
              signal
            ),
          callMcpWrite: (args, signal) =>
            mcpGateway.callWriteTool(
              {
                serverId: typeof args.server_id === 'string' ? args.server_id : '',
                toolName: typeof args.tool_name === 'string' ? args.tool_name : '',
                arguments:
                  args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
                    ? (args.arguments as Record<string, unknown>)
                    : {},
              },
              signal
            ),
          gitRead: (args, signal) => {
            if (capabilityInfo.capabilities.git !== 'read') throw new Error('git-read-disabled')
            return gitRead(repositoryScope, args as unknown as GitReadInput, signal)
          },
          ghRead: (args, signal) => {
            if (capabilityInfo.capabilities.gh !== 'read') throw new Error('gh-read-disabled')
            return ghRead(repositoryScope, args as unknown as GhReadInput, signal)
          },
          dispose: () => mcpGateway.close(),
        },
      },
      reviewLoopInfo: () => controller.info(),
    })
    sessions.set(input.conversationId, created)
    const sessionRouter = getRouter()
    sessionRouter.register(created.sessionKey, created.bridge)
    provisionalBrowser = null
    provisionalEnvironment = null
    // The session owns only the MCP bridge/tunnel here. The remote renderer is materialized by the
    // explicit companion-open action, so starting a session does not load chatgpt.com offscreen.
    if (!startIsCurrent(input.conversationId, epoch, managerEpoch)) {
      rollbackSession(input.conversationId, created, sessionRouter)
      return { ok: false, error: 'session-canceled' }
    }
    emitChange()
    return { ok: true }
  } catch (error) {
    const partial = sessions.get(input.conversationId)
    if (partial) {
      sessions.delete(input.conversationId)
      getRouter().unregister(partial.sessionKey)
      partial.end()
    }
    provisionalEnvironment?.stop()
    void provisionalBrowser?.dispose()
    reviewLoopControllers.get(input.conversationId)?.dispose()
    reviewLoopControllers.delete(input.conversationId)
    projectEnvironmentControllers.delete(input.conversationId)
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    releaseSessionStart(lease)
    await releaseTransport()
  }
}

/** End the session for ONE conversation (others continue on the same tunnel). */
export async function endSession(conversationId: string): Promise<void> {
  sessionEpochs.set(conversationId, (sessionEpochs.get(conversationId) ?? 0) + 1)
  // Review loop: cancel the active job BEFORE revoking remote routing (no orphan execution), then
  // clear all controller state (active + historical); a new session starts from scratch.
  reviewLoopControllers.get(conversationId)?.dispose()
  reviewLoopControllers.delete(conversationId)
  projectEnvironmentControllers.get(conversationId)?.stop()
  projectEnvironmentControllers.delete(conversationId)
  const session = sessions.get(conversationId)
  if (!session) {
    releaseCompanionPlacement(conversationId)
    companionWindows.close(conversationId)
    await releaseTransport()
    return
  }
  sessions.delete(conversationId)
  // Revoke remote routing first; subsequent concurrent calls immediately receive an invalid-key error.
  getRouter().unregister(session.sessionKey)
  session.end()
  releaseCompanionPlacement(conversationId)
  companionWindows.close(conversationId)
  emitChange()
  await releaseTransport()
  emitChange()
}

/** Global MCP update/remove/disable invalidates frozen snapshots deterministically. */
export async function invalidateMcpConfiguration(): Promise<void> {
  const activeConversationIds = [...sessions.keys()]
  await Promise.all(activeConversationIds.map((conversationId) => endSession(conversationId)))
}

/** Conversation lock: return the OWNING loopId if a loop is active (the service blocks manual sends/clears). */
export function reviewLoopLockFor(conversationId: string): string | null {
  return (
    lookupReviewLoopByConversation(conversationId)?.loopId ??
    reviewLoopControllers.get(conversationId)?.activeLoopId() ??
    null
  )
}

/** Lock of the local bootstrap turn; only its controller-owned internal turn may cross startSend. */
export function projectEnvironmentLockFor(conversationId: string): string | null {
  return projectEnvironmentControllers.get(conversationId)?.info()?.jobId ?? null
}

/** Renderer action is intentionally limited to showing/focusing the active visual surface. */
export function showVisualReviewPreview(conversationId: string): { ok: boolean; error?: string } {
  const controller = reviewLoopControllers.get(conversationId)
  if (controller?.info()?.visual?.managedPreview === false) floatingManager.detach(conversationId, 'browser')
  if (!controller?.showVisualPreview()) return { ok: false, error: 'visual-preview-not-active' }
  return { ok: true }
}

/** Stop the review loop (banner button): cancel the active job and block new rounds. */
export function stopReviewLoop(conversationId: string): void {
  reviewLoopControllers.get(conversationId)?.cancel('cancelled')
  emitChange()
}

async function materializeCompanionWindow(conversationId: string): Promise<{ ok: boolean; error?: string }> {
  if (shuttingDown) return { ok: false, error: 'shutdown' }
  if (storageResetting) return { ok: false, error: 'storage-resetting' }
  const epoch = sessionEpochs.get(conversationId) ?? 0
  const managerEpoch = lifecycleEpoch
  if (!sessionForConversation(conversationId)) return { ok: false, error: 'session-not-found' }
  try {
    await companionWindows.open(conversationId)
    if (
      shuttingDown ||
      storageResetting ||
      lifecycleEpoch !== managerEpoch ||
      (sessionEpochs.get(conversationId) ?? 0) !== epoch ||
      !sessionForConversation(conversationId)
    ) {
      return { ok: false, error: 'session-canceled' }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Recreates a companion renderer reclaimed while its slot was hidden. The active MCP session is the
 * authorization boundary: selecting an inactive ChatGPT tab must never materialize chatgpt.com.
 */
export async function restoreCompanionWindow(conversationId: string): Promise<{ ok: boolean; error?: string }> {
  return materializeCompanionWindow(conversationId)
}

export async function openCompanionWindow(conversationId: string): Promise<{ ok: boolean; error?: string }> {
  const result = await materializeCompanionWindow(conversationId)
  if (!result.ok) return result
  // The renderer chooses the drawer tab and opens the drawer for this conversation. No DOM/keyboard
  // automation is involved; this is only the explicit "Open ChatGPT" action from the companion UI.
  broadcast('chat:chatgpt-web:open', conversationId)
  return result
}

export async function resetCompanionStorage(): Promise<void> {
  if (storageResetPromise) return storageResetPromise
  if (shuttingDown) throw new Error('shutdown')
  // The renderer disables this action for active sessions, but the main process must enforce the same
  // boundary: clearing cookies while a key, bridge, probe or start is alive would leave the remote app
  // authorized against a different local lifecycle than the browser renderer.
  if (sessions.size > 0 || sessionStarts.size > 0 || probeTimer || transportConfigurationMutationPending()) {
    throw new Error('companion-busy')
  }

  storageResetting = true
  lifecycleEpoch++
  let reset!: Promise<void>
  reset = (async () => {
    try {
      // A transport stop may still be draining after the last lease disappeared. Wait for it before
      // destroying the partition so no in-flight tunnel callback observes half-reset browser state.
      await transportStarting?.catch(() => undefined)
      await releaseTransport()
      router = null
      await companionWindows.clearStorage()
      emitChange()
    } finally {
      storageResetting = false
      if (storageResetPromise === reset) storageResetPromise = null
    }
  })()
  storageResetPromise = reset
  return reset
}

export function companionPrompt(conversationId: string): string | null {
  const session = sessions.get(conversationId)
  if (!session) return null
  return buildCompanionPrompt({
    appName: getAppName(),
    sessionKey: session.sessionKey,
  })
}

/** Exposes the active capability only through the explicit per-conversation copy action. */
export function companionSessionKey(conversationId: string): string | null {
  return sessionForConversation(conversationId)?.sessionKey ?? null
}

export function status(): ChatGptWebStatus {
  const tunnelId = getTunnelId()
  const tunnelError = runtime?.getError() ?? runtimeAssetError
  return {
    binaryAvailable: !!tunnelClientBinPath(),
    configured: isConfigured(),
    tunnelId: tunnelId || null,
    apiKeyPresent: hasPlatformApiKey(),
    appName: getAppName(),
    tunnelState: runtime?.getState() ?? 'stopped',
    ...(tunnelError ? { tunnelError } : {}),
    probeActive: !!probeTimer,
    appRefreshRequired: appRefreshRequired(),
    sessions: [...sessions.values()].map((session) => ({
      ...session.info(),
      diagnostic: {
        bridge: {
          lastEvent: session.lastBridgeEvent(),
          lastToolCallAt: session.stats().lastToolCallAt,
          toolCalls: session.stats().toolCalls,
          deliveries: session.stats().deliveries,
        },
      },
    })),
  }
}

/** Read-only status refresh: verifies the managed component but never installs/downloads it. */
export async function refreshRuntimeAssetStatus(): Promise<ChatGptWebStatus> {
  try {
    await prepareTunnelClient(false)
    runtimeAssetError = null
  } catch (error) {
    runtimeAssetError = `component-required: ${error instanceof Error ? error.message : String(error)}`
  }
  return status()
}

/** Recent daemon logs (wizard diagnostics). */
export function tunnelLogs(): string[] {
  return runtime?.getLogs() ?? []
}

/** App shutdown: revoke sessions, close companion windows, and stop the transport. */
export async function disposeChatGptWeb(): Promise<void> {
  if (shuttingDown) {
    await storageResetPromise?.catch(() => undefined)
    await waitForTransportConfigurationMutations()
    await transportStarting?.catch(() => undefined)
    await waitForSessionStarts()
    await releaseTransport()
    return
  }
  shuttingDown = true
  lifecycleEpoch++
  // Shutdown: cancel ALL loops (and active jobs) and clear state before revoking sessions;
  // no orphan execution or resumed history after restart.
  for (const controller of reviewLoopControllers.values()) controller.dispose()
  reviewLoopControllers.clear()
  for (const controller of planReviewControllers.values()) controller.dispose()
  planReviewControllers.clear()
  for (const controller of projectEnvironmentControllers.values()) controller.stop()
  projectEnvironmentControllers.clear()
  for (const conversationId of sessions.keys()) releaseCompanionPlacement(conversationId)
  companionWindows.dispose()
  for (const session of sessions.values()) {
    getRouter().unregister(session.sessionKey)
    session.end()
  }
  sessions.clear()
  sessionEpochs.clear()
  if (probeTimer) clearTimeout(probeTimer)
  probeEpoch++
  probeTimer = null
  await storageResetPromise?.catch(() => undefined)
  await waitForTransportConfigurationMutations()
  await transportStarting?.catch(() => undefined)
  await waitForSessionStarts()
  await releaseTransport()
  router = null
  listeners.clear()
}
