import { BrowserWindow, Notification, shell, type WebContents } from 'electron'
import type { FleetDownloadFileKey } from '../../../shared/fleet-downloads'
import type { FleetServerId } from '../../../shared/fleet-servers'
import { tMain } from '../../i18n'
import { focusMainWindow } from '../../window-ipc'
import type { FleetSettledDownload } from './active-downloads'
import { fleetDownloadPath } from './download-history'

const keyOf = (file: FleetDownloadFileKey) => file.serverId + '\n' + file.botId + '\n' + file.fileId
/** The files each window shows, as it last reported them. */
const attended = new Map<WebContents, Set<string>>()
// Electron drops a notification's click handler once nothing references it.
const shown = new Set<Notification>()

/** Replaces what a window shows; a reloaded or closed window forgets its old list. */
export function setAttendedFleetFiles(contents: WebContents, files: FleetDownloadFileKey[]): void {
  if (!attended.has(contents)) {
    contents.once('destroyed', () => attended.delete(contents))
    // A reload keeps the WebContents but not its cards; the new page reports its own once they mount.
    contents.on('did-navigate', () => attended.get(contents)?.clear())
  }
  attended.set(contents, new Set(files.map(keyOf)))
}

/** The owner already sees the file's card: a window in front shows it. */
function isAttended(file: FleetDownloadFileKey): boolean {
  const key = keyOf(file)
  for (const [contents, keys] of attended) {
    if (contents.isDestroyed() || !keys.has(key)) continue
    const window = BrowserWindow.fromWebContents(contents)
    if (window && !window.isDestroyed() && window.isFocused() && window.isVisible() && !window.isMinimized())
      return true
  }
  return false
}

/** A system notification for a bot file that finished while the owner was elsewhere; clicking it shows the file. */
export function noticeFleetDownload(
  serverId: FleetServerId,
  download: FleetSettledDownload,
  botName: string | null
): void {
  if (isAttended({ serverId, botId: download.botId, fileId: download.fileId }) || !Notification.isSupported()) return
  const t = tMain('fleet')
  const name = download.name ?? t('files.notice.unknownFile')
  const notification = new Notification({
    title: t(download.outcome === 'saved' ? 'files.notice.saved' : 'files.notice.failed'),
    body: botName ? t('files.notice.fromBot', { name, bot: botName }) : name,
  })
  shown.add(notification)
  notification.once('close', () => shown.delete(notification))
  notification.once('click', () => {
    shown.delete(notification)
    if (download.outcome === 'failed') {
      focusMainWindow()
      return
    }
    // The receipt resolves the path again: the file may have been moved or deleted since.
    void fleetDownloadPath(download.receipt).then(
      (path) => shell.showItemInFolder(path),
      () => focusMainWindow()
    )
  })
  notification.show()
}
