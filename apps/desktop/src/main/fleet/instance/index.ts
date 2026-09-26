import type { BrowserWindow } from 'electron'
import { createInstanceControlServer } from './server'
import { parseBotInstanceConfig } from './config'
import { BotInstanceRuntime } from './runtime'

let runtime: BotInstanceRuntime | null = null
export function getBotInstanceRuntime(): BotInstanceRuntime | null {
  return runtime
}
export function getBotGatewayConfig(): { url: string; token: string } | null {
  return runtime?.gatewayConfig ?? null
}
export async function requestOwnerHelp(reason: string): Promise<string> {
  if (!runtime) throw new Error('Bot instance mode is not running.')
  return runtime.help.requestHelp(reason)
}
export async function startBotInstanceMode(
  window: BrowserWindow,
  floatBrowser: (conversationId: string) => void
): Promise<BotInstanceRuntime | null> {
  const config = parseBotInstanceConfig()
  if (!config) return null
  if (runtime) return runtime
  const instance = new BotInstanceRuntime(config, window, floatBrowser)
  await instance.start()
  const server = createInstanceControlServer(config, instance, instance.events)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.controlPort, config.controlHost, () => {
      server.off('error', reject)
      resolve()
    })
  })
  runtime = instance
  window.on('closed', async () => {
    server.close()
    await instance.dispose()
    if (runtime === instance) runtime = null
  })
  return instance
}
