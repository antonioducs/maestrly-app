import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { app, session, type Session } from 'electron'

const FILENAME_MAX = 200

/**
 * The Downloads folder of a headless instance. Bot and server containers have no XDG user-dirs file, and without one
 * Electron on Linux answers the home folder itself: downloads would land loose in it, and the environment's disk
 * figures would count the whole home folder as Downloads. That answer becomes `~/Downloads`; any other is kept.
 */
export function headlessDownloadsFolder(downloads: string, home: string): string {
  return path.resolve(downloads) === path.resolve(home) ? path.join(home, 'Downloads') : downloads
}

/**
 * Points the app's Downloads folder at `headlessDownloadsFolder` and creates it, before anything reads it: the
 * downloads without a dialog, the bots' Chromium and the disk figures then all use the same folder.
 */
export function applyHeadlessDownloadsFolder(): string {
  const folder = headlessDownloadsFolder(app.getPath('downloads'), app.getPath('home'))
  app.setPath('downloads', folder)
  try {
    mkdirSync(folder, { recursive: true })
  } catch (error) {
    // Each download creates it again, and cancels itself if it still cannot.
    console.error(
      JSON.stringify({
        component: 'downloads',
        level: 'error',
        message: `Could not create the Downloads folder: ${error instanceof Error ? error.message : String(error)}`,
      })
    )
  }
  return folder
}

/**
 * In bot and server mode nobody answers a native dialog on the display. A download without a save path makes Electron
 * open a "Save as" dialog that is modal to the window that started it, and on Linux that window then drops every click
 * and wheel event until the dialog is answered: on a bot environment's display such dialogs pile up, under the
 * environment's settings window or a bot's browser, and leave them unusable. Every download is saved straight to
 * `directory` instead, under a name that no other file or running download has.
 */
export function saveHeadlessDownloads(directory: string = app.getPath('downloads')): void {
  const running = new Set<string>()
  const watched = new WeakSet<Session>()
  const watch = (target: Session): void => {
    if (watched.has(target)) return
    watched.add(target)
    target.on('will-download', (event, item) => {
      if (item.getSavePath()) return
      try {
        mkdirSync(directory, { recursive: true })
        const file = availableDownloadPath(directory, item.getFilename(), running)
        running.add(file)
        item.once('done', () => running.delete(file))
        item.setSavePath(file)
      } catch (error) {
        // Without a path Electron would ask with a dialog: the download is cancelled instead.
        event.preventDefault()
        console.error(
          JSON.stringify({
            component: 'downloads',
            level: 'error',
            message: `Could not save a download: ${error instanceof Error ? error.message : String(error)}`,
          })
        )
      }
    })
  }
  watch(session.defaultSession)
  app.on('session-created', watch)
}

/** A file name of `directory` for a download: its own name made safe, numbered when that name is taken. */
export function availableDownloadPath(
  directory: string,
  filename: string,
  taken: ReadonlySet<string> = new Set(),
  exists: (file: string) => boolean = existsSync
): string {
  const name = safeFilename(filename)
  const extension = path.extname(name)
  const stem = name.slice(0, name.length - extension.length) || 'download'
  for (let index = 0; ; index++) {
    const file = path.join(directory, index === 0 ? name : `${stem} (${index})${extension}`)
    if (!taken.has(file) && !exists(file)) return file
  }
}

function safeFilename(filename: string): string {
  const printable = [...filename.replace(/[\\/]/g, '_')].filter((character) => {
    const code = character.charCodeAt(0)
    return code > 0x1f && code !== 0x7f
  })
  const cleaned = printable.join('').trim()
  const name = cleaned === '.' || cleaned === '..' ? '' : cleaned
  if (!name) return 'download'
  if (name.length <= FILENAME_MAX) return name
  const extension = path.extname(name).slice(0, 20)
  return name.slice(0, FILENAME_MAX - extension.length) + extension
}
