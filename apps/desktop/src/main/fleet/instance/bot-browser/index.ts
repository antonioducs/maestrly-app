import path from 'node:path'
import { app, session } from 'electron'
import { BROWSER_PARTITION } from '../../../drawer/browser'
import type { BotBrowserTarget } from '../environment'
import { BotChromium } from './bot-chromium'
import { spawnBotChromium, stopStaleChromium } from './process'

function log(message: string): void {
  console.error(JSON.stringify({ component: 'bot-browser', level: 'info', message }))
}

/**
 * A bot's own Chromium on its apps display, with the profile the display manager gave it. Its tabs to reopen are kept
 * beside the profile, so a move takes them along; its downloads go to the environment's Downloads folder, as the
 * built-in browser's do. On its first start it copies the site logins the bots shared until then.
 */
export function createBotChromium(target: BotBrowserTarget): BotChromium {
  const profile = target.display.env.MAESTRLY_BOT_BROWSER_PROFILE
  if (!profile) throw new Error(`The display of bot ${target.botId} has no browser profile.`)
  return new BotChromium({
    botId: target.botId,
    deps: {
      spawn: spawnBotChromium,
      now: Date.now,
      setTimeout,
      clearTimeout,
      log,
    },
    env: () => ({ ...target.display.env }),
    beforeStart: () => stopStaleChromium(profile),
    profile,
    savedTabsFile: path.join(path.dirname(profile), 'chromium-tabs.json'),
    downloads: app.getPath('downloads'),
    foregroundConversationId: target.foregroundConversationId,
    ownsConversation: target.ownsConversation,
    sharedCookies: () => session.fromPartition(BROWSER_PARTITION).cookies.get({}),
  })
}
