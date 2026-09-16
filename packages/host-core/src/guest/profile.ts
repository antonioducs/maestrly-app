import { join } from 'node:path'
import { CONTROL_PORT_NAME, DESKTOP_PORT_NAME, EGRESS_PORT_NAME } from '@maestrly/host-protocol'

/** Extra private sockets created only for VMs bound to a bot. QGA/QMP remain separate. */
export interface BotChannelPaths {
  control: string
  egress: string
  /** Private media lane for the live desktop (RFB only). Older profiles omit it. */
  desktop?: string
}
export function botChannelPaths(directory: string): BotChannelPaths {
  const paths = { control: join(directory, 'bot-control.sock'), egress: join(directory, 'bot-egress.sock'), desktop: join(directory, 'bot-desktop.sock') }
  for (const path of Object.values(paths) as string[])
    if (Buffer.byteLength(path) > 100 || /[,\n\r]/.test(path)) throw new Error('Bot channel socket path is too long or unsafe')
  return paths
}
/** virtio-serial ports appended to the phase-one argument list; no NIC is introduced. */
export function botChannelArgs(paths: BotChannelPaths): string[] {
  return [
    '-chardev',
    `socket,path=${paths.control},server=on,wait=off,id=botctl0`,
    '-device',
    `virtserialport,chardev=botctl0,name=${CONTROL_PORT_NAME}`,
    '-chardev',
    `socket,path=${paths.egress},server=on,wait=off,id=botegress0`,
    '-device',
    `virtserialport,chardev=botegress0,name=${EGRESS_PORT_NAME}`,
    ...(paths.desktop
      ? ['-chardev', `socket,path=${paths.desktop},server=on,wait=off,id=botdesktop0`, '-device', `virtserialport,chardev=botdesktop0,name=${DESKTOP_PORT_NAME}`]
      : []),
  ]
}
