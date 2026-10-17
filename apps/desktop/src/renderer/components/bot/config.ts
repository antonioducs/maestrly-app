import type { HostApi } from '../../../preload'
import type { BotActionName, BotPermissionCeiling } from '../../../shared/bot'

export type BotWorkspaceOption = Awaited<ReturnType<HostApi['listWorkspaces']>>[number]
export type BotProviderOption = Awaited<ReturnType<HostApi['chatExecutionProviders']>>[number]

export const BOT_ACTION_NAMES: readonly BotActionName[] = ['chats:read', 'chats:write', 'chats:control', 'chats:answer']

/** Offered in the order they widen, so the person reads the strictest choice first. */
export const BOT_PERMISSION_CEILING_NAMES: readonly BotPermissionCeiling[] = ['ask', 'auto', 'full']

/** What a bot the person just approved starts with: work is delegated to it, so nothing asks. */
export const SUGGESTED_BOT_PERMISSION_CEILING: BotPermissionCeiling = 'full'
