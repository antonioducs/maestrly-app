import type { BotRunConversations } from '../../src/main/fleet/instance/routine-runs'

/** The routine run conversations of a bot that has none, for runtimes built from their parts. */
export function noRunConversations(): BotRunConversations {
  return {
    list: () => [],
    get: () => undefined,
    byConversation: () => undefined,
    loaded: () => undefined,
    loadedLanes: () => [],
    lane: async () => null,
    unloadAll: () => {},
    idle: async () => {},
    load: async () => {},
  } as unknown as BotRunConversations
}
