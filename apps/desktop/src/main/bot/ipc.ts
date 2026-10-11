import { z } from 'zod'
import type { IpcRegistrar } from '../ipc-registrar'
import { botHost } from './host'

const key = z.string().min(1).max(191)

export function registerBotIpc(reg: IpcRegistrar): void {
  reg.mhandle('bot:management', (_event, id: unknown, state: unknown) =>
    botHost.setManagement(key.parse(id), z.enum(['active', 'paused']).parse(state))
  )
  // Releasing a chat for the person's own messages is theirs alone; no bot tool reaches this channel.
  reg.mhandle('bot:manual-chat', (_event, id: unknown, enabled: unknown) =>
    botHost.setManualChat(key.parse(id), z.boolean().parse(enabled))
  )
}
