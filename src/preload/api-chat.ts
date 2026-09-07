import { clipboard, ipcRenderer } from 'electron'
import type {
  ChatConfig,
  ChatConvTools,
  ChatGptWebStatus,
  ChatGptWebCapabilities,
  ChatGptWebCapabilitiesInfo,
  ChatImageInterpreter,
  ChatModelRef,
  ChatPermissionEvent,
  ChatRuntimeState,
  ChatProviderKind,
  ChatStreamEvent,
  ChatFileHit,
  ChatGeneratedImageResult,
  ChatAttachmentImageResult,
  ChatAttachmentInput,
  ChatToolImageResult,
  ChatUserPrompt,
  ChatProjectCommand,
  ChatSkillCommand,
  ChatSkillDetail,
  ChatSkillGroup,
  ChatSkillInfo,
  ChatSkillOverride,
  ChatSkillSearchHit,
  ChatSkillSelection,
  ChatSkillsState,
  ChatModelMeta,
  ChatMode,
  ChatReasoningEffort,
  ChatHistoryPage,
  ChatHistoryStats,
  ChatSearchHit,
  ChatSubscriptionAuthStatus,
  ChatSubscriptionFailoverEvent,
  ChatSubscriptionFailoverRoute,
  ChatSubscriptionLoginResult,
  ChatSubscriptionLogoutResult,
  ChatSubscriptionProviderKind,
  ChatSubscriptionUsage,
  CodexSubscriptionAuthStatus,
  CodexSubscriptionLoginResult,
  ReviewLoopInfo,
  ReviewLoopParticipantInfo,
  StartPairedReviewLoopInput,
  StartPairedReviewLoopResult,
  SubagentSessionChangedEvent,
  SubagentSessionOrigin,
  SubagentSessionSummary,
  SubagentTranscriptPage,
} from '../shared/chat'
import type { SubagentProfileModelMetaResult } from '../shared/subagent-profile-effort'
import type { StructuredAgentMentionDraft } from '../shared/chat-agent-mentions'
import type { MaestroLiveEvent, MaestroLivePostResult, MaestroLiveState } from '../shared/maestro-live'
import type { UnifiedUsageStats } from '../shared/usage'
import type {
  MaestroConfigPayload,
  MaestroConfigV1,
  MaestroStrategyProfileCatalog,
  MaestroStrategyProfileInput,
  MaestroStrategyProfileMutationResult,
} from '../shared/maestro'
import {
  MAESTRO_CONFIGURATOR_EVENT_CHANNEL,
  type MaestroConfiguratorEvent,
  type MaestroConfiguratorProfile,
  type MaestroConfiguratorSendInput,
  type MaestroConfiguratorSendResult,
  type MaestroConfiguratorState,
} from '../shared/maestro-configurator'
import type {
  ConversationSubagentProfileConfigPayload,
  ConversationSubagentProfileSaveResult,
  SubagentProfileCatalog,
  SubagentProfileConfigPayload,
  SubagentProfileModelCatalogResult,
  SubagentProfileRulesV1,
  SubagentProfileSaveResult,
} from '../shared/subagent-profiles'
import type { MaestroToStandardResult, StandardToMaestroResult } from '../shared/conversation-experience'

const SUBSCRIPTION_CHANNELS: Record<
  ChatSubscriptionProviderKind,
  { status: string; login: string; logout: string; changed: string }
> = {
  'codex-subscription': {
    status: 'chat:codex-subscription:status',
    login: 'chat:codex-subscription:login',
    logout: 'chat:codex-subscription:logout',
    changed: 'chat:codex-subscription:auth-changed',
  },
  'github-copilot-subscription': {
    status: 'chat:github-copilot-subscription:status',
    login: 'chat:github-copilot-subscription:login',
    logout: 'chat:github-copilot-subscription:logout',
    changed: 'chat:github-copilot-subscription:auth-changed',
  },
  'claude-subscription': {
    status: 'chat:claude-subscription:status',
    login: 'chat:claude-subscription:login',
    logout: 'chat:claude-subscription:logout',
    changed: 'chat:claude-subscription:auth-changed',
  },
  'grok-subscription': {
    status: 'chat:grok-subscription:status',
    login: 'chat:grok-subscription:login',
    logout: 'chat:grok-subscription:logout',
    changed: 'chat:grok-subscription:auth-changed',
  },
}

export type ChatGptWebStatusPayload = ChatGptWebStatus & { enabled: boolean }

export interface ChatGptWebTurnCompletedPayload {
  conversationId: string
}

function subscriptionStatus(
  provider: ChatSubscriptionProviderKind,
  refresh?: boolean,
  accountId?: string | null
): Promise<ChatSubscriptionAuthStatus> {
  return ipcRenderer.invoke(SUBSCRIPTION_CHANNELS[provider].status, {
    refresh: refresh === true,
    ...(accountId ? { accountId } : {}),
  })
}

function subscriptionLogin(
  provider: ChatSubscriptionProviderKind,
  accountId?: string | null
): Promise<ChatSubscriptionLoginResult> {
  return accountId
    ? ipcRenderer.invoke(SUBSCRIPTION_CHANNELS[provider].login, { accountId })
    : ipcRenderer.invoke(SUBSCRIPTION_CHANNELS[provider].login)
}

function subscriptionLogout(
  provider: ChatSubscriptionProviderKind,
  accountId?: string | null
): Promise<ChatSubscriptionLogoutResult> {
  return accountId
    ? ipcRenderer.invoke(SUBSCRIPTION_CHANNELS[provider].logout, { accountId })
    : ipcRenderer.invoke(SUBSCRIPTION_CHANNELS[provider].logout)
}

function onSubscriptionStatus(
  provider: ChatSubscriptionProviderKind,
  cb: (status: ChatSubscriptionAuthStatus) => void
): () => void {
  const listener = (_event: unknown, status: ChatSubscriptionAuthStatus) => cb(status)
  const channel = SUBSCRIPTION_CHANNELS[provider].changed
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

export const chatApi = {
  chatConfig: (): Promise<ChatConfig> => ipcRenderer.invoke('chat:config'),

  chatSubscriptionStatus: subscriptionStatus,

  chatSubscriptionUsage: (
    providerKind: ChatSubscriptionProviderKind,
    force?: boolean,
    accountId?: string | null
  ): Promise<ChatSubscriptionUsage> =>
    ipcRenderer.invoke('chat:subscription-usage', {
      providerKind,
      force: force === true,
      ...(accountId ? { accountId } : {}),
    }),
  chatSubscriptionLogin: subscriptionLogin,
  chatSubscriptionLogout: subscriptionLogout,
  onChatSubscriptionStatus: onSubscriptionStatus,

  chatCodexSubscriptionStatus: (refresh?: boolean): Promise<CodexSubscriptionAuthStatus> =>
    subscriptionStatus('codex-subscription', refresh),

  chatCodexSubscriptionLogin: (): Promise<CodexSubscriptionLoginResult> => subscriptionLogin('codex-subscription'),

  chatCodexSubscriptionLogout: (): Promise<{ ok: boolean; status?: CodexSubscriptionAuthStatus; error?: string }> =>
    subscriptionLogout('codex-subscription'),

  onChatCodexSubscriptionStatus: (cb: (status: CodexSubscriptionAuthStatus) => void): (() => void) =>
    onSubscriptionStatus('codex-subscription', cb),

  chatGptWebStatus: (): Promise<ChatGptWebStatusPayload> => ipcRenderer.invoke('chat:chatgpt-web:status'),
  /** Conversation-owned external access policy. Secrets and repository roots never cross the preload. */
  chatGptWebCapabilities: (conversationId: string): Promise<ChatGptWebCapabilitiesInfo> =>
    ipcRenderer.invoke('chat:chatgpt-web:capabilities:get', conversationId),
  chatGptWebSetCapabilities: (
    conversationId: string,
    capabilities: ChatGptWebCapabilities
  ): Promise<ChatGptWebCapabilitiesInfo> =>
    ipcRenderer.invoke('chat:chatgpt-web:capabilities:set', conversationId, capabilities),

  chatGptWebConfigure: (input: {
    apiKey?: string
    tunnelId?: string
    appName?: string
    enabled?: boolean
  }): Promise<ChatGptWebStatusPayload> => ipcRenderer.invoke('chat:chatgpt-web:configure', input),

  chatGptWebPrincipals: (
    apiKey?: string
  ): Promise<
    | { ok: true; organizations: Array<{ id: string; name: string }>; workspaces: Array<{ id: string; name: string }> }
    | { ok: false; error: string; status: number }
  > => ipcRenderer.invoke('chat:chatgpt-web:principals', apiKey),

  chatGptWebTunnels: (
    apiKey?: string
  ): Promise<
    { ok: true; tunnels: Array<{ id: string; name?: string; description?: string }> } | { ok: false; error: string }
  > => ipcRenderer.invoke('chat:chatgpt-web:tunnels', apiKey),

  chatGptWebCreateTunnel: (input: {
    name?: string
    description?: string
  }): Promise<{ ok: boolean; tunnelId?: string; error?: string }> =>
    ipcRenderer.invoke('chat:chatgpt-web:create-tunnel', input),

  chatGptWebCompanionStart: (
    conversationId: string
  ): Promise<{ ok: boolean; kickoff?: string | null; pairingRequired?: boolean; error?: string }> =>
    ipcRenderer.invoke('chat:chatgpt-web:companion-start', { conversationId }),

  chatGptWebCompanionEnd: (conversationId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('chat:chatgpt-web:companion-end', { conversationId }),

  chatGptWebChecks: (conversationId?: string): Promise<{ raw: string; detected: string[] }> =>
    ipcRenderer.invoke('chat:chatgpt-web:checks', conversationId),
  chatGptWebSetChecks: (raw: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('chat:chatgpt-web:set-checks', raw),

  chatGptWebProbeStart: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('chat:chatgpt-web:probe-start'),

  chatGptWebProbeStop: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('chat:chatgpt-web:probe-stop'),

  chatGptWebCompanionPrompt: (conversationId: string): Promise<{ ok: boolean; kickoff?: string | null }> =>
    ipcRenderer.invoke('chat:chatgpt-web:companion-prompt', { conversationId }),

  chatGptWebCompanionCopyPrompt: async (conversationId: string): Promise<{ ok: boolean; error?: string }> => {
    const result = (await ipcRenderer.invoke('chat:chatgpt-web:companion-prompt', { conversationId })) as {
      ok: boolean
      kickoff?: string | null
    }
    if (!result.ok || !result.kickoff) return { ok: false, error: 'session-not-found' }
    try {
      clipboard.writeText(result.kickoff)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  chatGptWebCompanionCopySessionKey: async (conversationId: string): Promise<{ ok: boolean; error?: string }> => {
    const result = (await ipcRenderer.invoke('chat:chatgpt-web:companion-session-key', { conversationId })) as {
      ok: boolean
      sessionKey?: string | null
    }
    if (!result.ok || !result.sessionKey) return { ok: false, error: 'session-not-found' }
    try {
      clipboard.writeText(result.sessionKey)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  chatGptWebCompanionOpen: (conversationId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('chat:chatgpt-web:companion-open', { conversationId }),

  chatGptWebReviewLoopStop: (conversationId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('chat:chatgpt-web:review-loop:stop', conversationId),

  chatGptWebReviewLoopShowPreview: (conversationId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('chat:chatgpt-web:review-loop:show-preview', conversationId),

  chatGptWebBrowserReset: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('chat:chatgpt-web:browser-reset'),

  chatGptWebLogs: (): Promise<string[]> => ipcRenderer.invoke('chat:chatgpt-web:logs'),
  /** Compatible regular Maestrly conversations sharing the executor's canonical checkout. */
  chatReviewLoopCompatible: (executorConversationId: string): Promise<ReviewLoopParticipantInfo[]> =>
    ipcRenderer.invoke('chat:review-loop:compatible', executorConversationId),
  chatReviewLoopStart: (input: StartPairedReviewLoopInput): Promise<StartPairedReviewLoopResult> =>
    ipcRenderer.invoke('chat:review-loop:start', input),
  chatReviewLoopStop: (conversationId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('chat:review-loop:stop', conversationId),
  chatReviewLoopStatus: (conversationId: string): Promise<ReviewLoopInfo | null> =>
    ipcRenderer.invoke('chat:review-loop:status', conversationId),
  chatReviewLoopStatuses: (): Promise<ReviewLoopInfo[]> => ipcRenderer.invoke('chat:review-loop:status'),
  onChatReviewLoopChanged: (cb: (loops: ReviewLoopInfo[]) => void): (() => void) => {
    const listener = (_event: unknown, loops: ReviewLoopInfo[]) => cb(loops)
    ipcRenderer.on('chat:review-loop:changed', listener)
    return () => ipcRenderer.removeListener('chat:review-loop:changed', listener)
  },
  onChatReviewLoopDelivery: (conversationId: string, cb: () => void): (() => void) => {
    const channel = `chat:review-loop:delivery:${conversationId}`
    const listener = () => cb()
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },

  onChatGptWebStatus: (cb: (status: ChatGptWebStatusPayload) => void): (() => void) => {
    const listener = (_event: unknown, status: ChatGptWebStatusPayload) => cb(status)
    ipcRenderer.on('chat:chatgpt-web:changed', listener)
    return () => ipcRenderer.removeListener('chat:chatgpt-web:changed', listener)
  },

  onChatGptWebOpen: (cb: (conversationId: string) => void): (() => void) => {
    const listener = (_event: unknown, conversationId: string) => cb(conversationId)
    ipcRenderer.on('chat:chatgpt-web:open', listener)
    return () => ipcRenderer.removeListener('chat:chatgpt-web:open', listener)
  },

  onChatGptWebDelivery: (conversationId: string, cb: () => void): (() => void) => {
    const channel = `chat:chatgpt-web:delivery:${conversationId}`
    const listener = () => cb()
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },

  onChatGptWebTurnCompleted: (cb: (payload: ChatGptWebTurnCompletedPayload) => void): (() => void) => {
    const listener = (_event: unknown, payload: ChatGptWebTurnCompletedPayload) => cb(payload)
    ipcRenderer.on('chat:chatgpt-web:turn-completed', listener)
    return () => ipcRenderer.removeListener('chat:chatgpt-web:turn-completed', listener)
  },

  chatAddProvider: (input: {
    name: string
    baseURL: string
    key?: string
    kind?: ChatProviderKind
  }): Promise<{ ok: boolean; id?: string; error?: string }> => ipcRenderer.invoke('chat:provider-add', input),

  chatUpdateProvider: (
    id: string,
    patch: { name?: string; baseURL?: string; kind?: ChatProviderKind }
  ): Promise<{ ok: boolean }> => ipcRenderer.invoke('chat:provider-update', id, patch),

  chatRemoveProvider: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('chat:provider-remove', id),

  chatSubscriptionAccountAdd: (input: {
    kind: ChatSubscriptionProviderKind
    label: string
  }): Promise<{ ok: boolean; accountId?: string; providerId?: string; error?: string }> =>
    ipcRenderer.invoke('chat:subscription-account:add', input),

  chatSubscriptionAccountRename: (accountId: string, label: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('chat:subscription-account:rename', accountId, label),

  chatSubscriptionAccountRemove: (accountId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('chat:subscription-account:remove', accountId),

  chatSubscriptionFailoverSetRoute: (input: {
    primaryProviderId: string
    enabled: boolean
    fallbackProviderIds: string[]
  }): Promise<{ ok: boolean; route?: ChatSubscriptionFailoverRoute; error?: string }> =>
    ipcRenderer.invoke('chat:subscription-failover:set-route', input),
  chatSubagentProfilesGetGlobal: (): Promise<SubagentProfileConfigPayload> =>
    ipcRenderer.invoke('chat:subagent-profiles:get-global'),
  chatSubagentProfilesSetGlobal: (rules: SubagentProfileRulesV1): Promise<SubagentProfileSaveResult> =>
    ipcRenderer.invoke('chat:subagent-profiles:set-global', rules),
  chatSubagentProfilesGetConversation: (conversationId: string): Promise<ConversationSubagentProfileConfigPayload> =>
    ipcRenderer.invoke('chat:subagent-profiles:get-conversation', conversationId),
  chatSubagentProfilesSetConversation: (
    conversationId: string,
    rules: SubagentProfileRulesV1 | null
  ): Promise<ConversationSubagentProfileSaveResult> =>
    ipcRenderer.invoke('chat:subagent-profiles:set-conversation', conversationId, rules),
  chatSubagentProfilesSetConversationEnabled: (
    conversationId: string,
    enabled: boolean
  ): Promise<ConversationSubagentProfileSaveResult> =>
    ipcRenderer.invoke('chat:subagent-profiles:set-conversation-enabled', conversationId, enabled),
  chatSubagentsSetConversationEnabled: (
    conversationId: string,
    enabled: boolean
  ): Promise<ConversationSubagentProfileSaveResult> =>
    ipcRenderer.invoke('chat:subagents:set-conversation-enabled', conversationId, enabled),
  chatSubagentProfilesCatalog: (conversationId?: string): Promise<SubagentProfileCatalog> =>
    ipcRenderer.invoke('chat:subagent-profiles:catalog', conversationId),
  chatSubagentProfilesModelCatalog: (providerId: string): Promise<SubagentProfileModelCatalogResult> =>
    ipcRenderer.invoke('chat:subagent-profiles:model-catalog', providerId),
  chatSubagentProfilesModelMeta: (providerId: string, modelId: string): Promise<SubagentProfileModelMetaResult> =>
    ipcRenderer.invoke('chat:subagent-profiles:model-meta', providerId, modelId),
  chatMaestroGetGlobal: (): Promise<MaestroConfigPayload> => ipcRenderer.invoke('chat:maestro:get-global'),
  chatMaestroSetGlobal: (
    config: MaestroConfigV1
  ): Promise<{ ok: boolean; value?: MaestroConfigPayload; errors?: MaestroConfigPayload['diagnostics'] }> =>
    ipcRenderer.invoke('chat:maestro:set-global', config),
  chatMaestroGetConversation: (conversationId: string): Promise<MaestroConfigPayload> =>
    ipcRenderer.invoke('chat:maestro:get-conversation', conversationId),
  chatMaestroSetConversation: (
    conversationId: string,
    config: MaestroConfigV1 | null
  ): Promise<{ ok: boolean; value?: MaestroConfigPayload; errors?: MaestroConfigPayload['diagnostics'] }> =>
    ipcRenderer.invoke('chat:maestro:set-conversation', conversationId, config),
  /** Ends Maestro orchestration for this idle conversation; history/configuration stay preserved. */
  chatMaestroConvertToStandard: (conversationId: string): Promise<MaestroToStandardResult> =>
    ipcRenderer.invoke('chat:maestro:convert-to-standard', conversationId),
  /** Starts Maestro orchestration for this idle conversation while preserving its Standard mode and history. */
  chatStandardConvertToMaestro: (conversationId: string): Promise<StandardToMaestroResult> =>
    ipcRenderer.invoke('chat:standard:convert-to-maestro', conversationId),
  chatMaestroStrategyProfilesList: (): Promise<MaestroStrategyProfileCatalog> =>
    ipcRenderer.invoke('chat:maestro:strategy-profiles:list'),
  chatMaestroStrategyProfilesCreate: (
    input: MaestroStrategyProfileInput
  ): Promise<MaestroStrategyProfileMutationResult> =>
    ipcRenderer.invoke('chat:maestro:strategy-profiles:create', input),
  chatMaestroStrategyProfilesUpdate: (
    id: string,
    input: MaestroStrategyProfileInput
  ): Promise<MaestroStrategyProfileMutationResult> =>
    ipcRenderer.invoke('chat:maestro:strategy-profiles:update', id, input),
  chatMaestroStrategyProfilesDelete: (id: string): Promise<{ ok: boolean; catalog: MaestroStrategyProfileCatalog }> =>
    ipcRenderer.invoke('chat:maestro:strategy-profiles:delete', id),
  chatMaestroConfiguratorState: (): Promise<MaestroConfiguratorState> =>
    ipcRenderer.invoke('chat:maestro-configurator:state'),
  chatMaestroConfiguratorSetProfile: (
    profile: MaestroConfiguratorProfile
  ): Promise<{ ok: true; profile: MaestroConfiguratorProfile } | { ok: false; errors: string[] }> =>
    ipcRenderer.invoke('chat:maestro-configurator:set-profile', profile),
  chatMaestroConfiguratorSend: (input: MaestroConfiguratorSendInput): Promise<MaestroConfiguratorSendResult> =>
    ipcRenderer.invoke('chat:maestro-configurator:send', input),
  chatMaestroConfiguratorCancel: (turnId?: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('chat:maestro-configurator:cancel', turnId),
  chatMaestroConfiguratorReset: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('chat:maestro-configurator:reset'),
  onChatMaestroConfiguratorEvent: (callback: (event: MaestroConfiguratorEvent) => void): (() => void) => {
    const listener = (_event: unknown, payload: MaestroConfiguratorEvent) => callback(payload)
    ipcRenderer.on(MAESTRO_CONFIGURATOR_EVENT_CHANNEL, listener)
    return () => ipcRenderer.removeListener(MAESTRO_CONFIGURATOR_EVENT_CHANNEL, listener)
  },

  chatModels: (providerId: string, force?: boolean, includeHidden?: boolean): Promise<string[]> =>
    ipcRenderer.invoke('chat:models', providerId, force, includeHidden),
  onChatModelsCatalogChanged: (callback: () => void): (() => void) => {
    const listener = () => callback()
    ipcRenderer.on('models:catalog-changed', listener)
    return () => ipcRenderer.removeListener('models:catalog-changed', listener)
  },

  chatHiddenModels: (): Promise<Record<string, string[]>> => ipcRenderer.invoke('chat:hidden-models:get'),

  chatSetHiddenModels: (providerId: string, hidden: string[]): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('chat:hidden-models:set', providerId, hidden),

  chatMcpAdd: (input: {
    name: string
    transport: 'http' | 'stdio'
    url?: string
    headers?: Record<string, string>
    command?: string
    args?: string[]
    env?: Record<string, string>
  }): Promise<{ ok: boolean; id?: string; error?: string }> => ipcRenderer.invoke('chat:mcp-add', input),

  chatMcpUpdate: (id: string, patch: { enabled?: boolean; name?: string }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('chat:mcp-update', id, patch),

  chatMcpRemove: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('chat:mcp-remove', id),

  chatSetAppTools: (enabled: boolean): Promise<{ ok: boolean }> => ipcRenderer.invoke('chat:set-app-tools', enabled),

  chatSetImageGen: (enabled: boolean): Promise<{ ok: boolean }> => ipcRenderer.invoke('chat:set-image-gen', enabled),

  chatSetBashFilters: (enabled: boolean): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('chat:set-bash-filters', enabled),

  chatSetOpenAIHarness: (enabled: boolean): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('chat:set-openai-harness', enabled),

  chatSetAstraHarness: (enabled: boolean): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('chat:set-astra-harness', enabled),

  chatGetPermMode: (conversationId: string): Promise<'full' | 'ask' | 'auto'> =>
    ipcRenderer.invoke('chat:get-perm-mode', conversationId),
  chatSetPermMode: (conversationId: string, mode: 'full' | 'ask' | 'auto'): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('chat:set-perm-mode', conversationId, mode),

  chatGetMode: (conversationId: string): Promise<ChatMode> =>
    ipcRenderer.invoke('chat:get-mode', conversationId),
  chatSetMode: (conversationId: string, mode: ChatMode): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('chat:set-mode', conversationId, mode),

  chatGetReasoning: (conversationId: string): Promise<ChatReasoningEffort> =>
    ipcRenderer.invoke('chat:get-reasoning', conversationId),
  chatSetReasoning: (conversationId: string, effort: ChatReasoningEffort): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('chat:set-reasoning', conversationId, effort),

  chatGetFastMode: (conversationId: string): Promise<boolean> =>
    ipcRenderer.invoke('chat:get-fast-mode', conversationId),
  chatSetFastMode: (conversationId: string, enabled: boolean): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('chat:set-fast-mode', conversationId, enabled),

  onChatModeChanged: (conversationId: string, cb: (mode: ChatMode) => void): (() => void) => {
    const channel = `chat:mode:${conversationId}`
    const listener = (_e: unknown, mode: ChatMode) => cb(mode)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },

  chatGetConvTools: (conversationId: string): Promise<ChatConvTools> =>
    ipcRenderer.invoke('chat:get-conv-tools', conversationId),
  chatSetConvTools: (
    conversationId: string,
    patch: { app?: boolean; mcpDisabled?: string[]; imageGen?: boolean }
  ): Promise<{ ok: boolean }> => ipcRenderer.invoke('chat:set-conv-tools', conversationId, patch),

  chatResend: (
    conversationId: string,
    fromMessageId: string,
    text: string,
    agentMentions?: StructuredAgentMentionDraft[]
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('chat:resend', { conversationId, fromMessageId, text, agentMentions }),
  chatAttachmentImage: (
    conversationId: string,
    messageId: string,
    partId: string
  ): Promise<ChatAttachmentImageResult> =>
    ipcRenderer.invoke('chat:attachment-image', { conversationId, messageId, partId }),

  chatRuntime: (conversationId: string): Promise<ChatRuntimeState> =>
    ipcRenderer.invoke('chat:runtime', conversationId),

  chatSteer: (
    conversationId: string,
    text: string,
    clientUserMessageId: string
  ): Promise<{ ok: boolean; accepted?: boolean; error?: string }> =>
    ipcRenderer.invoke('chat:steer', conversationId, text, clientUserMessageId),

  chatUpdateLiveReasoning: (
    conversationId: string,
    effort: ChatReasoningEffort
  ): Promise<{ ok: boolean; applied?: boolean; error?: string }> =>
    ipcRenderer.invoke('chat:update-live-reasoning', conversationId, effort),

  chatMaestroLivePost: (
    conversationId: string,
    runId: string,
    text: string,
    agentMentions?: StructuredAgentMentionDraft[]
  ): Promise<MaestroLivePostResult> =>
    ipcRenderer.invoke('chat:maestro-live:post', { conversationId, runId, text, agentMentions }),
  chatMaestroLiveSnapshot: (conversationId: string): Promise<MaestroLiveState | null> =>
    ipcRenderer.invoke('chat:maestro-live:snapshot', conversationId),
  chatMaestroLiveCancel: (conversationId: string, runId: string, messageId: string): Promise<boolean> =>
    ipcRenderer.invoke('chat:maestro-live:cancel', { conversationId, runId, messageId }),

  chatHistoryPage: (
    conversationId: string,
    opts?: { beforeSeq?: number; aroundSeq?: number; limit?: number }
  ): Promise<ChatHistoryPage> => ipcRenderer.invoke('chat:history:page', conversationId, opts),

  chatHistoryStats: (conversationId: string): Promise<ChatHistoryStats> =>
    ipcRenderer.invoke('chat:history:stats', conversationId),
  chatSubagentSessions: (
    conversationId: string,
    options?: { parentMessageId?: string; origin?: SubagentSessionOrigin; limit?: number }
  ): Promise<SubagentSessionSummary[]> => ipcRenderer.invoke('chat:subagents:list', conversationId, options),
  chatSubagentResolve: (
    conversationId: string,
    parentMessageId: string,
    toolCallId: string
  ): Promise<SubagentSessionSummary | null> =>
    ipcRenderer.invoke('chat:subagent:resolve', { conversationId, parentMessageId, toolCallId }),
  chatSubagentTranscript: (
    conversationId: string,
    sessionId: string,
    options?: { limit?: number }
  ): Promise<SubagentTranscriptPage | null> =>
    ipcRenderer.invoke('chat:subagent:transcript', conversationId, sessionId, options),

  usageStats: (opts?: { since?: number; until?: number; force?: boolean }): Promise<UnifiedUsageStats> =>
    ipcRenderer.invoke('usage:stats', opts),

  chatSend: (
    conversationId: string,
    text: string,
    attachments?: ChatAttachmentInput[],
    agentMentions?: StructuredAgentMentionDraft[]
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('chat:send', { conversationId, text, attachments, agentMentions }),

  chatSearchFiles: (conversationId: string, query: string): Promise<ChatFileHit[]> =>
    ipcRenderer.invoke('chat:search-files', conversationId, query),

  chatSearchMessages: (conversationId: string, query: string): Promise<ChatSearchHit[]> =>
    ipcRenderer.invoke('chat:search', conversationId, query),

  chatGeneratedImage: (conversationId: string, messageId: string, partId: string): Promise<ChatGeneratedImageResult> =>
    ipcRenderer.invoke('chat:generated-image', { conversationId, messageId, partId }),

  chatToolImage: (
    conversationId: string,
    messageId: string,
    toolPartId: string,
    imageId: string
  ): Promise<ChatToolImageResult> =>
    ipcRenderer.invoke('chat:tool-image', { conversationId, messageId, toolPartId, imageId }),

  chatCommands: (
    conversationId: string
  ): Promise<{ prompts: ChatUserPrompt[]; project: ChatProjectCommand[]; skills: ChatSkillCommand[] }> =>
    ipcRenderer.invoke('chat:commands', conversationId),

  chatSkills: (conversationId?: string): Promise<ChatSkillInfo[]> =>
    ipcRenderer.invoke('chat:skills:list', conversationId),

  chatSkillsState: (conversationId?: string): Promise<ChatSkillsState> =>
    ipcRenderer.invoke('chat:skills:state', conversationId),

  chatSkillRead: (name: string, conversationId?: string): Promise<ChatSkillDetail | null> =>
    ipcRenderer.invoke('chat:skills:read', name, conversationId),

  chatSkillSetEnabled: (name: string, enabled: boolean): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('chat:skills:set-enabled-global', name, enabled),

  chatSkillSetOverride: (
    conversationId: string,
    name: string,
    state: ChatSkillOverride | 'inherit'
  ): Promise<{ ok: boolean }> => ipcRenderer.invoke('chat:skills:set-override', conversationId, name, state),

  chatSkillResetOverrides: (conversationId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('chat:skills:reset-overrides', conversationId),

  chatSkillSetSelection: (
    conversationId: string,
    selection: ChatSkillSelection
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('chat:skills:set-selection', conversationId, selection),
  /** Global skill groups. */
  chatSkillGroups: (): Promise<ChatSkillGroup[]> => ipcRenderer.invoke('chat:skills:groups:list'),
  chatSkillGroupCreate: (input: {
    name: string
    description?: string
    skills?: string[]
  }): Promise<{ ok: boolean; error?: string; group?: ChatSkillGroup }> =>
    ipcRenderer.invoke('chat:skills:groups:create', input),
  chatSkillGroupUpdate: (
    id: string,
    patch: { name?: string; description?: string; skills?: string[] }
  ): Promise<{ ok: boolean; error?: string; group?: ChatSkillGroup }> =>
    ipcRenderer.invoke('chat:skills:groups:update', id, patch),
  chatSkillGroupRemove: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('chat:skills:groups:remove', id),

  chatSkillCreate: (input: {
    name: string
    description?: string
    scope?: 'global' | 'project'
    conversationId?: string
  }): Promise<{ ok: boolean; error?: string; name?: string; dir?: string }> =>
    ipcRenderer.invoke('chat:skills:create', input),

  chatSkillRemove: (name: string, conversationId?: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('chat:skills:remove', name, conversationId),

  chatSkillFromPrompt: (
    promptId: string,
    input?: { scope?: 'global' | 'project'; conversationId?: string }
  ): Promise<{ ok: boolean; error?: string; name?: string; dir?: string }> =>
    ipcRenderer.invoke('chat:skills:convert-prompt', promptId, input),

  chatSkillReveal: (name: string, conversationId?: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('chat:skills:reveal', name, conversationId),

  chatSkillSearch: (
    query: string,
    conversationId?: string
  ): Promise<{ ok: boolean; hits: ChatSkillSearchHit[]; error?: string }> =>
    ipcRenderer.invoke('chat:skills:search', query, conversationId),

  chatSkillInstall: (input: {
    slug: string
    scope?: 'global' | 'project'
    conversationId?: string
    overwrite?: boolean
  }): Promise<{ ok: boolean; error?: string; name?: string; dir?: string; available?: string[] }> =>
    ipcRenderer.invoke('chat:skills:install', input),

  chatModelMeta: (modelId: string, providerId?: string): Promise<ChatModelMeta | null> =>
    ipcRenderer.invoke('chat:model-meta', modelId, providerId),

  chatContextLimitGet: (
    providerId: string,
    modelId: string
  ): Promise<{
    limit: number | null
    providerWindow: number | null
    catalogWindow: number | null
    effective: number | null
  }> => ipcRenderer.invoke('chat:context-limit:get', providerId, modelId),
  chatContextLimitSet: (providerId: string, modelId: string, value: number | null): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('chat:context-limit:set', providerId, modelId, value),

  chatEnsureMicAccess: (): Promise<{ ok: boolean; status?: string }> => ipcRenderer.invoke('chat:ensure-mic-access'),

  chatTranscribe: (audio: Float32Array): Promise<{ text?: string; error?: string }> =>
    ipcRenderer.invoke('chat:transcribe', audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength)),

  chatPrompts: (): Promise<ChatUserPrompt[]> => ipcRenderer.invoke('chat:prompts'),

  chatPromptAdd: (input: {
    name: string
    description?: string
    content: string
  }): Promise<{ ok: boolean; id?: string; error?: string }> => ipcRenderer.invoke('chat:prompt-add', input),
  chatPromptUpdate: (
    id: string,
    patch: { name?: string; description?: string; content?: string }
  ): Promise<{ ok: boolean }> => ipcRenderer.invoke('chat:prompt-update', id, patch),
  chatPromptRemove: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('chat:prompt-remove', id),

  onChatReference: (
    conversationId: string,
    cb: (ref: { path: string; startLine?: number; endLine?: number }) => void
  ): (() => void) => {
    const channel = `chat:reference:${conversationId}`
    const listener = (_e: unknown, ref: { path: string; startLine?: number; endLine?: number }) => cb(ref)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },

  chatStop: (conversationId: string): void => ipcRenderer.send('chat:stop', conversationId),

  chatClear: (conversationId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('chat:clear', conversationId),

  chatCompact: (conversationId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('chat:compact', conversationId),

  chatSetKey: (providerId: string, key: string): Promise<{ ok: boolean; mode?: string; present?: boolean }> =>
    ipcRenderer.invoke('chat:key-set', providerId, key),

  chatClearKey: (providerId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('chat:key-clear', providerId),

  chatSetImageInterpreter: (
    value: ChatImageInterpreter | null
  ): Promise<{ ok: boolean; value: ChatImageInterpreter | null }> =>
    ipcRenderer.invoke('chat:image-interpreter:set', value),
  /** Sets the default provider, model, and optional reasoning for new conversations. */
  chatSetDefault: (sel: ChatModelRef & { reasoning?: string; fastMode?: boolean }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('chat:set-default', sel),

  chatSetSelection: (conversationId: string, sel: ChatModelRef): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('chat:set-selection', conversationId, sel),

  chatGetSelection: (conversationId: string): Promise<ChatModelRef | null> =>
    ipcRenderer.invoke('chat:get-selection', conversationId),

  chatPermissionRespond: (requestId: string, reply: 'once' | 'always' | 'reject', message?: string): void =>
    ipcRenderer.send('chat:permission-respond', requestId, reply, message),

  chatQuestionRespond: (toolCallId: string, answers: string[][]): void =>
    ipcRenderer.send('chat:question-respond', toolCallId, answers),

  onChatStream: (conversationId: string, cb: (ev: ChatStreamEvent | { kind: string }) => void): (() => void) => {
    const channel = `chat:delta:${conversationId}`
    const listener = (_e: unknown, ev: ChatStreamEvent) => cb(ev)
    ipcRenderer.on(channel, listener)
    ipcRenderer.send('chat:subscribe', conversationId)
    let active = true
    return () => {
      if (!active) return
      active = false
      ipcRenderer.removeListener(channel, listener)
      ipcRenderer.send('chat:unsubscribe', conversationId)
    }
  },
  onChatMaestroLive: (conversationId: string, cb: (event: MaestroLiveEvent) => void): (() => void) => {
    const channel = `chat:maestro-live:${conversationId}`
    const listener = (_event: unknown, payload: MaestroLiveEvent) => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  onChatSubagentSession: (conversationId: string, cb: (event: SubagentSessionChangedEvent) => void): (() => void) => {
    const channel = `chat:subagent-session:${conversationId}`
    const listener = (_event: unknown, payload: SubagentSessionChangedEvent) => cb(payload)
    ipcRenderer.on(channel, listener)
    ipcRenderer.send('chat:subscribe', conversationId)
    let active = true
    return () => {
      if (!active) return
      active = false
      ipcRenderer.removeListener(channel, listener)
      ipcRenderer.send('chat:unsubscribe', conversationId)
    }
  },

  onChatPermission: (conversationId: string, cb: (ev: ChatPermissionEvent) => void): (() => void) => {
    const channel = `chat:permission:${conversationId}`
    const listener = (_e: unknown, ev: ChatPermissionEvent) => cb(ev)
    ipcRenderer.on(channel, listener)
    ipcRenderer.send('chat:subscribe', conversationId)
    let active = true
    return () => {
      if (!active) return
      active = false
      ipcRenderer.removeListener(channel, listener)
      ipcRenderer.send('chat:unsubscribe', conversationId)
    }
  },

  onChatSubscriptionFailover: (
    conversationId: string,
    cb: (ev: ChatSubscriptionFailoverEvent) => void
  ): (() => void) => {
    const channel = `chat:subscription-failover:${conversationId}`
    const listener = (_e: unknown, ev: ChatSubscriptionFailoverEvent) => cb(ev)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
}
