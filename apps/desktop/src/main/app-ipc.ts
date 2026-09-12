import { app, dialog, shell } from 'electron'
import { getChannelInfo, getInstanceId } from './channel'

import { tMain } from './i18n'
import type { IpcRegistrar } from './ipc-registrar'
import { getOpenTargets, openExternal, type OpenTarget } from './open-external'
import { getConversation, getWorkspace } from './store'

export function registerAppIpc(reg: IpcRegistrar): void {
  reg.handle('open:targets', () => getOpenTargets())
  reg.mhandle('open:external', async (_e, scope: 'conv' | 'workspace', id: string, target: OpenTarget) => {
    const dir = scope === 'conv' ? getConversation(id)?.cwd : getWorkspace(id)?.path
    const res = dir
      ? await openExternal(dir, target)
      : { ok: false, error: tMain('main')('dialog.convWorkspaceNotFound') }

    if (!res.ok)
      dialog.showErrorBox(tMain('main')('dialog.cannotOpenTitle'), res.error ?? tMain('main')('dialog.unknownError'))
    return res
  })

  reg.mhandle('open:url', (_e, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) void shell.openExternal(url)
  })

  reg.handle('app:info', () => {
    const info = getChannelInfo()
    return {
      channel: info.channel,
      instanceId: getInstanceId(),
      productName: info.productName,
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      hideChannelBadge: !app.isPackaged && info.channel === 'dev' && process.env.AGENTS_HIDE_CHANNEL_BADGE === '1',
    }
  })
}
