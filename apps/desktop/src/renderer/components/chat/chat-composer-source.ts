import type { FleetBot, FleetSelection } from '@maestrly/bot-fleet-protocol'
import type { HostApi } from '../../../preload'
import type { FleetConversationOps } from '../../../preload/api-fleet'
import type { ChatPermMode } from '../../../shared/chat'

type RemoteMethods = {
  [Op in keyof FleetConversationOps]: (
    ...args: Parameters<FleetConversationOps[Op]>
  ) => Promise<ReturnType<FleetConversationOps[Op]>>
}

/** Menu data for one primary conversation. Desktop callers use the local source by default. */
export interface ChatComposerSource extends RemoteMethods {
  bot?: {
    listSelections: typeof window.api.fleetListSelections
    updateSelection: (selection: FleetSelection | null) => Promise<FleetBot>
    ceiling: ChatPermMode
    setCeiling: (ceiling: ChatPermMode) => Promise<FleetBot>
    manage: (target: 'skills' | 'mcp') => Promise<void>
  }
}

export function localChatComposerSource(api: HostApi, conversationId: string): ChatComposerSource {
  return {
    chatConfig: () => api.chatConfig(),
    chatGetConvTools: () => api.chatGetConvTools(conversationId),
    chatSetConvTools: (patch) => api.chatSetConvTools(conversationId, patch),
    chatSubagentProfilesGetConversation: () => api.chatSubagentProfilesGetConversation(conversationId),
    chatSubagentProfilesSetConversationEnabled: (enabled) =>
      api.chatSubagentProfilesSetConversationEnabled(conversationId, enabled),
    chatSubagentsSetConversationEnabled: (enabled) => api.chatSubagentsSetConversationEnabled(conversationId, enabled),
    chatSkillsState: () => api.chatSkillsState(conversationId),
    chatSkillSetOverride: (name, state) => api.chatSkillSetOverride(conversationId, name, state),
    chatSkillResetOverrides: () => api.chatSkillResetOverrides(conversationId),
    chatSkillSetSelection: (selection) => api.chatSkillSetSelection(conversationId, selection),
    chatCommands: () => api.chatCommands(conversationId),
    chatCompact: () => api.chatCompact(conversationId),
    chatBackgroundCompactionRetry: () => api.chatRetryBackgroundCompaction(conversationId),
  }
}

/**
 * Depends only on the bot id and its ceiling, so callers can memoize it across the frequent `bot.updated` events;
 * the takeover state is read at call time.
 */
export function botChatComposerSource(
  bot: Pick<FleetBot, 'id' | 'ceiling'>,
  onOpenScreen: () => void,
  takeoverState: () => FleetBot['takeover']['state']
): ChatComposerSource {
  const call = window.api.fleetConversationCall
  const botId = bot.id
  return {
    chatConfig: () => call(botId, 'chatConfig'),
    chatGetConvTools: () => call(botId, 'chatGetConvTools'),
    chatSetConvTools: (patch) => call(botId, 'chatSetConvTools', patch),
    chatSubagentProfilesGetConversation: () => call(botId, 'chatSubagentProfilesGetConversation'),
    chatSubagentProfilesSetConversationEnabled: (enabled) =>
      call(botId, 'chatSubagentProfilesSetConversationEnabled', enabled),
    chatSubagentsSetConversationEnabled: (enabled) => call(botId, 'chatSubagentsSetConversationEnabled', enabled),
    chatSkillsState: () => call(botId, 'chatSkillsState'),
    chatSkillSetOverride: (name, state) => call(botId, 'chatSkillSetOverride', name, state),
    chatSkillResetOverrides: () => call(botId, 'chatSkillResetOverrides'),
    chatSkillSetSelection: (selection) => call(botId, 'chatSkillSetSelection', selection),
    chatCommands: () => call(botId, 'chatCommands'),
    chatCompact: () => call(botId, 'chatCompact'),
    chatBackgroundCompactionRetry: () => call(botId, 'chatBackgroundCompactionRetry'),
    bot: {
      listSelections: window.api.fleetListSelections,
      updateSelection: (selection) => window.api.fleetUpdateBot(botId, { selection }),
      ceiling: bot.ceiling,
      setCeiling: (ceiling) => window.api.fleetUpdateBot(botId, { ceiling }),
      manage: async (target) => {
        if (takeoverState() !== 'human') await window.api.fleetTakeover(botId)
        await window.api.fleetUiOpen(botId, { target })
        onOpenScreen()
      },
    },
  }
}
