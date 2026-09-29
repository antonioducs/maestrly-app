import { app } from 'electron'
import { z } from 'zod'
import type { IpcRegistrar } from '../../ipc-registrar'
import { fleetInstallerService, type FleetInstallerService } from './service'

const hostName = /^[A-Za-z0-9.-]{1,253}$/
const ipv6 = /^\[?[0-9A-Fa-f:.]+\]?$/
const host = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => hostName.test(value) || (value.includes(':') && ipv6.test(value)), 'Invalid server address')
const port = z.number().int().min(1).max(65535)
const deviceName = z.string().trim().min(1).max(80)
const target = z.object({ host, port, username: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/) }).strict()
const credentials = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('password'), password: z.string().min(1).max(1024) }).strict(),
  z
    .object({
      kind: z.literal('key'),
      privateKey: z.string().min(1).max(16384),
      passphrase: z.string().max(1024).nullable(),
    })
    .strict(),
])
export const installLocalInput = z.object({ deviceName, allowPrivateNetwork: z.boolean() }).strict()
export const installRemoteInput = z
  .object({ target, credentials, deviceName, allowPrivateNetwork: z.boolean() })
  .strict()
const removeConfirmation = z.object({ confirm: z.literal('remove') }).strict()

/** The bot server installer's channels; every renderer input is validated here before the service sees it. */
export function registerFleetInstallerIpc(
  reg: IpcRegistrar,
  service: Pick<
    FleetInstallerService,
    | 'status'
    | 'checkLocal'
    | 'installLocal'
    | 'installRemote'
    | 'update'
    | 'updateBots'
    | 'setPrivateNetwork'
    | 'disconnect'
    | 'remove'
    | 'cancel'
    | 'start'
    | 'stop'
  > = fleetInstallerService
): void {
  reg.handle('fleet:installer:status', () => service.status())
  reg.handle('fleet:installer:checkLocal', () => service.checkLocal())
  reg.mhandle('fleet:installer:installLocal', (_event, input: unknown) =>
    service.installLocal(installLocalInput.parse(input))
  )
  reg.mhandle('fleet:installer:installRemote', (_event, input: unknown) =>
    service.installRemote(installRemoteInput.parse(input))
  )
  reg.mhandle('fleet:installer:update', () => service.update())
  reg.mhandle('fleet:installer:updateBots', () => service.updateBots())
  reg.mhandle('fleet:installer:setPrivateNetwork', (_event, allow: unknown) =>
    service.setPrivateNetwork(z.boolean().parse(allow))
  )
  reg.mhandle('fleet:installer:disconnect', () => service.disconnect())
  reg.mhandle('fleet:installer:remove', (_event, confirmation: unknown) => {
    removeConfirmation.parse(confirmation)
    return service.remove()
  })
  reg.mhandle('fleet:installer:cancel', () => service.cancel())
  if (process.env.MAESTRLY_BOT_MODE !== '1') {
    // Before the fleet client starts, so that its first connection finds the tunnel to a VPS listening.
    void service.start().catch((error: unknown) => console.warn('[bot-server] tunnel start failed:', error))
    app.once('will-quit', () => void service.stop())
  }
}
