import { FLEET_CONVERSATION_COMPUTER_LIMITS } from '@maestrly/bot-fleet-protocol'
import type { ConversationComputers } from '../../remote-host/server/computers'
import { serverComputers } from '../../remote-host/server/computers-registry'
import type { McpToolContext } from './context'
import { registerComputerTools } from './computer'

export const SERVER_COMPUTER_DESCRIPTION =
  "Use for desktop apps outside the Maestrly browser, on this conversation's own 1280x800 Linux computer, which the owner can watch and control. It starts on first use and is given back after a minute without use. Prefer browser_* for websites. Coordinates are screen pixels from the last computer_screenshot."

/**
 * The tools a workspaces host gives its conversations' agents: `computer_*` on the conversation's own computer, which
 * the first call starts. Nothing without computers (a bot, a desktop, a host without the display programs).
 */
export function registerServerModeTools(
  ctx: McpToolContext,
  computers: Pick<ConversationComputers, 'open' | 'computer' | 'controlled'> | null = serverComputers()
): void {
  if (!computers) return
  registerComputerTools(ctx, {
    description: SERVER_COMPUTER_DESCRIPTION,
    prepare: async (conversationId) => {
      const opened = await computers.open(conversationId, 'agent')
      if (!opened.ok) {
        if (opened.reason === 'busy')
          throw new Error(
            `All ${FLEET_CONVERSATION_COMPUTER_LIMITS.slots} computers of this server are in use by: ${opened.holders.join(', ')}. Try again once one is given back.`
          )
        throw new Error('This server has no computers.')
      }
      const display = computers.computer(conversationId)
      if (!display) throw new Error("This conversation's computer stopped. Try again.")
      if (!display.browserArea) throw new Error('A bot display always has a tile.')
      const notes: string[] = []
      if (opened.started)
        notes.push(
          `Started this conversation's computer on display ${opened.display}. Programs you start from a shell show on it while it runs; in this turn, run them with DISPLAY=${opened.display}.`
        )
      if (computers.controlled(conversationId))
        notes.push('The owner is controlling this computer too: their input and yours may interleave.')
      return {
        screen: {
          display: display.display,
          width: display.width,
          height: display.height,
          windowArea: display.browserArea,
        },
        notes,
      }
    },
  })
}
