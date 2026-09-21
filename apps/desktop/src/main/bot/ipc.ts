import { z } from 'zod'
import type { IpcRegistrar } from '../ipc-registrar'
import { botHost } from './host'

const key = z.string().min(1).max(191)
const optionalKey = z.union([key, z.literal('')])
const ids = z
  .array(key)
  .max(200)
  .refine((value) => new Set(value).size === value.length, 'Duplicate identifiers are not allowed.')
/** How far this bot may go on its own; anything else the renderer sends is refused here. */
const ceiling = z.enum(['ask', 'auto', 'full'])
const setup = z
  .object({
    name: z.string().trim().min(1).max(160),
    clientId: z.string().trim().min(1).max(191).optional(),
    workspaceIds: ids.min(1),
    providerIds: ids.min(1),
    actions: z
      .array(z.enum(['chats:read', 'chats:write', 'chats:control', 'chats:answer']))
      .min(1)
      .max(4)
      .optional(),
    selections: z
      .array(z.object({ providerId: key, modelId: key }).strict())
      .min(1)
      .max(500)
      .optional(),
    permissionCeiling: ceiling.optional(),
  })
  .strict()
const server = z
  .object({
    enabled: z.boolean().optional(),
    host: z.string().trim().min(1).max(191).optional(),
    port: z.number().int().min(0).max(65_535).optional(),
    publicUrl: z.string().trim().max(2_048).optional(),
  })
  .strict()

export function registerBotIpc(reg: IpcRegistrar): void {
  reg.handle('bot:settings', () => botHost.settings())
  reg.mhandle('bot:connect', (_event, input: unknown) => botHost.connect(setup.parse(input)))
  reg.mhandle('bot:revoke', (_event, id: unknown) => botHost.revoke(key.parse(id)))
  reg.mhandle('bot:workspaces', (_event, id: unknown, workspaceIds: unknown) =>
    botHost.updateWorkspaces(key.parse(id), ids.parse(workspaceIds))
  )
  reg.mhandle('bot:permission-ceiling', (_event, id: unknown, value: unknown) =>
    botHost.setPermissionCeiling(key.parse(id), ceiling.parse(value))
  )
  reg.mhandle('bot:management', (_event, id: unknown, state: unknown) =>
    botHost.setManagement(key.parse(id), z.enum(['active', 'paused']).parse(state))
  )
  // Releasing a chat for the person's own messages is theirs alone; no bot tool reaches this channel.
  reg.mhandle('bot:manual-chat', (_event, id: unknown, enabled: unknown) =>
    botHost.setManualChat(key.parse(id), z.boolean().parse(enabled))
  )
  reg.mhandle('bot:refresh', () => botHost.refresh())
  reg.mhandle('bot:server', (_event, input: unknown) => botHost.configureServer(server.parse(input)))
  // Approving names the connection the bot may act as; refusing needs no connection at all.
  reg.mhandle('bot:authorize', (_event, id: unknown, approved: unknown, connectionId: unknown) => {
    const approve = z.boolean().parse(approved)
    return botHost.authorize(
      key.parse(id),
      approve,
      approve ? key.parse(connectionId) : optionalKey.parse(connectionId ?? '')
    )
  })
}
