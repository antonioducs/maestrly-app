import './floating-strip'
import { contextBridge } from 'electron'
import { localDataApi } from './api-local-data'
import { appApi } from './api-app'
import { chatApi } from './api-chat'
import { conversationMigrationApi } from './api-conversation-migration'
import { drawerApi } from './api-drawer'
import { memoryApi } from './api-memory'
import { notesApi } from './api-notes'
import { planApi } from './api-plan'
import { popupApi } from './api-popup'
import { ptyApi } from './api-pty'
import { performanceApi } from './api-performance'
import { runtimeAssetsApi } from './api-runtime-assets'
import { projectSetupApi } from './api-project-setup'
import { reviewApi } from './api-review'
import { settingsApi } from './api-settings'
import { soundApi } from './api-sound'
import { workspaceApi } from './api-workspace'
import { platformApi } from './api-platform'

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
export type * from './api-workspace'
export type * from './api-platform'

const api = {
  ...ptyApi,
  ...performanceApi,
  ...runtimeAssetsApi,
  ...workspaceApi,
  ...conversationMigrationApi,
  ...projectSetupApi,
  ...memoryApi,
  ...notesApi,
  ...drawerApi,
  ...popupApi,
  ...planApi,
  ...appApi,
  ...localDataApi,
  ...reviewApi,
  ...settingsApi,
  ...soundApi,
  ...chatApi,
  ...platformApi,
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
