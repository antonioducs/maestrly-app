import { BrowserWindow, type IpcMainInvokeEvent, Notification } from 'electron'
import { tMain } from '../i18n'
import type { IpcRegistrar } from '../ipc-registrar'
import { isRemoteUiTarget } from '../remote-ui-targets'
import { focusMainWindow, getMainWebContents, safeWindowSend } from '../window-ipc'
import type { PeerPairingPromptView } from '../../shared/peer'
import { onPeerOverviewChanged, onPeerPairingRequested, peerController } from './service'

const MAX_TEXT = 512
const shown = new Set<Notification>()

/** A string argument of a bounded length, from this computer's own window only. */
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_TEXT) throw new Error('Invalid argument')
  return value
}

/** Settings → Computers is this computer's: another computer that uses it never reaches these channels. */
function local(event: IpcMainInvokeEvent): void {
  if (isRemoteUiTarget(event.sender)) throw new Error('This action is not available on a remote host.')
}

function mainWindow(): BrowserWindow | null {
  const contents = getMainWebContents()
  return contents ? BrowserWindow.fromWebContents(contents) : null
}

/** Whether the owner looks at this computer's window now, where the pairing dialog shows the code. */
function attended(): boolean {
  const window = mainWindow()
  return !!window && !window.isDestroyed() && window.isVisible() && window.isFocused() && !window.isMinimized()
}

/** Tells an owner looking elsewhere that another computer asks to pair; the code itself shows in the window only. */
function notifyPairing(prompt: PeerPairingPromptView): void {
  if (attended() || !Notification.isSupported()) return
  const t = tMain('main')
  const notification = new Notification({
    title: t('peer.pairingNotice.title', { name: prompt.name }),
    body: t('peer.pairingNotice.body'),
  })
  shown.add(notification)
  notification.once('close', () => shown.delete(notification))
  notification.once('click', () => {
    shown.delete(notification)
    focusMainWindow()
  })
  notification.show()
}

/**
 * Settings → Computers and the pairing dialogs of this computer's window: whether it shares itself, its name, the
 * computers it paired with, and pairing in both roles. What they show is pushed on `peer:changed`, to this
 * computer's main window only, since it carries the pairing code.
 */
export function registerPeerIpc(reg: IpcRegistrar): void {
  const controller = peerController()
  onPeerOverviewChanged(() => safeWindowSend(mainWindow(), 'peer:changed', controller.overview()))
  onPeerPairingRequested(notifyPairing)

  reg.handle('peer:overview', (event) => {
    local(event)
    return controller.overview()
  })
  reg.mhandle('peer:set-hosting', (event, on: unknown) => {
    local(event)
    if (typeof on !== 'boolean') throw new Error('Invalid argument')
    return controller.setHosting(on)
  })
  reg.mhandle('peer:rename', (event, name: unknown) => {
    local(event)
    return controller.rename(text(name))
  })
  reg.mhandle('peer:remove', (event, deviceId: unknown) => {
    local(event)
    return controller.remove(text(deviceId))
  })
  reg.mhandle('peer:disconnect', (event, deviceId: unknown) => {
    local(event)
    controller.disconnect(text(deviceId))
  })
  reg.mhandle('peer:connect-start', (event, address: unknown) => {
    local(event)
    return controller.connectStart(text(address))
  })
  reg.mhandle('peer:connect-code', (event, pairingId: unknown, code: unknown) => {
    local(event)
    return controller.connectCode(text(pairingId), text(code))
  })
  reg.mhandle('peer:connect-cancel', (event, pairingId: unknown) => {
    local(event)
    controller.connectCancel(text(pairingId))
  })
  reg.mhandle('peer:prompt-cancel', (event, pairingId: unknown) => {
    local(event)
    controller.cancelPrompt(text(pairingId))
  })
  reg.mhandle('peer:prompt-dismiss', (event, pairingId: unknown) => {
    local(event)
    controller.dismissPrompt(text(pairingId))
  })
}
