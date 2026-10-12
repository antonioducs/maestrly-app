import { fleetEnvironmentSettings } from './api-fleet-environment-settings'
import './floating-strip'
import { contextBridge } from 'electron'
import { appApi } from './api-app'
import { chatLocalApi } from './api-chat'
import { chatWindowApi } from './api-chat-window'
import { drawerApi } from './api-drawer'
import { popupApi } from './api-popup'
import { performanceApi } from './api-performance'
import { settingsApi } from './api-settings'
import { soundApi } from './api-sound'
import { updateApi } from './api-update'
import { fleetApi } from './api-fleet'
import { fleetInstallerApi } from './api-fleet-installer'
import { hostsApi } from './api-hosts'
import { localHostApi } from './host-api'
import { artifactsApi } from './api-artifacts'
import { transfersApi } from './api-transfers'

export type * from '../shared/chat-window'

export type {
  ConversationBranchInfo,
  ConversationBranchRepoInfo,
  GitHeadState,
} from '../shared/conversation-branch'

export type { FloatTab } from '../shared/tool-tabs'

export type { ShortcutBinding, ShortcutsConfig, ShortcutOs, EffectiveShortcuts } from '../shared/shortcuts'
export type { SupportedLocale } from '../shared/locale'
export type {
  ConversationExperience,
  ChatBehavior,
  MaestroToStandardError,
  MaestroToStandardResult,
  StandardToMaestroError,
  StandardToMaestroResult,
} from '../shared/conversation-experience'
export type * from '../shared/maestro'
export type * from '../shared/maestro-live'
export type * from '../shared/maestro-configurator'
export type { SoundSettings, SoundVoice } from '../shared/sound'
export type { SoundPlayRequest, SoundPlayAck, SoundPlaybackFailure } from '../shared/sound-playback'

export type {
  ChatConfig,
  ChatMessage,
  ChatModelRef,
  ChatPermissionEvent,
  ChatRuntimeState,
  ChatStreamEvent,
  MessagePart,
  ToolState,
  ChatRole,
  ChatUsage,
  ChatSubagentUsage,
  ChatProviderInfo,
  ChatProviderPreset,
  ChatProviderKind,
  ChatPermissionRequest,
  ChatPermMode,
  ChatConvTools,
  ChatMode,
  ChatFileHit,
  ChatGeneratedImageResult,
  ChatToolImageResult,
  ChatUserPrompt,
  ChatProjectCommand,
  ChatSlashCommand,
  ChatModelMeta,
  ChatReasoningEffort,
  ChatHistoryPage,
  ChatHistoryStats,
  ChatSearchHit,
  ChatSubscriptionProviderKind,
  ChatSubscriptionAuthState,
  ChatSubscriptionAuthStatus,
  ChatSubscriptionUsage,
  ChatSubscriptionUsageWindow,
  ChatSubscriptionUsageWindowKind,
  ChatSubscriptionFailoverRoute,
  ChatSubscriptionLoginResult,
  ChatSubscriptionLogoutResult,
  CodexSubscriptionAuthState,
  CodexSubscriptionAuthStatus,
  CodexSubscriptionLoginResult,
  ChatGptWebStatus,
  ChatGptWebSessionInfo,
  ChatGptWebSessionState,
  ChatGptWebTunnelState,
  ReviewLoopInfo,
  ReviewLoopParticipantInfo,
  StartPairedReviewLoopInput,
  StartPairedReviewLoopResult,
  McpServerInfo,
  PermissionReply,
} from '../shared/chat'
export type { ChatGptWebStatusPayload } from './api-chat'

export type { UnifiedUsageStats, UsageModelRow, UsageSource } from '../shared/usage'
export type * from '../shared/local-conversation'
export type * from '../shared/performance'
export type * from '../shared/conversation-migration'
export type * from '../shared/subagent-profile-effort'
export type * from '../shared/subagent-profiles'
export type * from '../shared/runtime-assets'

export type * from './api-local-data'
export type * from './api-app'
export type * from './api-chat'
export type * from './api-conversation-migration'
export type * from './api-drawer'
export type * from './api-memory'
export type * from './api-notes'
export type * from './api-plan'
export type * from './api-popup'
export type * from './api-pty'
export type * from './api-performance'
export type * from './api-project-setup'
export type * from './api-runtime-assets'
export type * from './api-review'
export type * from './api-settings'
export type * from './api-sound'
export type * from './api-update'
export type * from './api-workspace'
export type * from './api-fleet'
export type * from './api-fleet-installer'
export type * from './api-hosts'
export type * from './api-host-fs'
export type * from './api-artifacts'
export type * from './api-transfers'

/** This computer's app, window and devices: never routed to another host. */
const localApi = {
  ...appApi,
  ...performanceApi,
  ...drawerApi,
  ...popupApi,
  ...settingsApi,
  ...soundApi,
  ...updateApi,
  ...chatLocalApi,
  ...chatWindowApi,
  ...fleetApi,
  fleetEnvironmentSettings,
  ...fleetInstallerApi,
  ...hostsApi,
  ...artifactsApi,
  ...transfersApi,
}
const api = { ...localHostApi, ...localApi }

contextBridge.exposeInMainWorld('api', api)

export type LocalApi = typeof localApi
/** What the renderer sees on `window.api`: a host's backend is reached with `hostApi(hostId)` instead. */
export type RendererApi = LocalApi
export type { HostApi } from './host-api'
export type Api = typeof api
