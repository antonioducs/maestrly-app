import path from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

type Listener = (...args: unknown[]) => void
const electron = vi.hoisted(() => {
  const fakeSession = () => {
    const listeners = new Map<string, Listener>()
    return { listeners, on: (name: string, listener: Listener) => listeners.set(name, listener) }
  }
  const app = {
    listeners: new Map<string, Listener>(),
    on: (name: string, listener: Listener) => app.listeners.set(name, listener),
    getPath: () => '',
  }
  return { fakeSession, app, defaultSession: fakeSession() }
})
vi.mock('electron', () => ({ app: electron.app, session: { defaultSession: electron.defaultSession } }))

import { availableDownloadPath, saveHeadlessDownloads } from '../../src/main/headless-downloads'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function download(filename: string, savePath = '') {
  const done: Listener[] = []
  return {
    getSavePath: () => savePath,
    getFilename: () => filename,
    setSavePath: vi.fn((value: string) => {
      savePath = value
    }),
    once: (_name: string, listener: Listener) => done.push(listener),
    finish: () => done.forEach((listener) => listener()),
  }
}

describe('downloads of a headless instance', () => {
  it('saves every download without a dialog, never over another file or running download', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'maestrly-downloads-'))
    dirs.push(dir)
    writeFileSync(path.join(dir, 'clip.mp4'), '')
    saveHeadlessDownloads(path.join(dir, 'Downloads'))
    const willDownload = electron.defaultSession.listeners.get('will-download')!
    const event = { preventDefault: vi.fn() }

    const first = download('video.mp4')
    willDownload(event, first)
    expect(first.setSavePath).toHaveBeenCalledWith(path.join(dir, 'Downloads', 'video.mp4'))
    const second = download('video.mp4')
    willDownload(event, second)
    expect(second.setSavePath).toHaveBeenCalledWith(path.join(dir, 'Downloads', 'video (1).mp4'))
    first.finish()
    const third = download('video.mp4')
    willDownload(event, third)
    expect(third.setSavePath).toHaveBeenCalledWith(path.join(dir, 'Downloads', 'video.mp4'))

    // A path chosen elsewhere stays; so does a session created later, which is watched too.
    const chosen = download('report.pdf', '/elsewhere/report.pdf')
    willDownload(event, chosen)
    expect(chosen.setSavePath).not.toHaveBeenCalled()
    const later = electron.fakeSession()
    electron.app.listeners.get('session-created')!(later)
    const fromBrowser = download('../../etc/passwd')
    later.listeners.get('will-download')!(event, fromBrowser)
    expect(fromBrowser.setSavePath).toHaveBeenCalledWith(path.join(dir, 'Downloads', '.._.._etc_passwd'))
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('cancels a download it cannot place instead of asking', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'maestrly-downloads-'))
    dirs.push(dir)
    const blocker = path.join(dir, 'not-a-directory')
    writeFileSync(blocker, '')
    const session = electron.fakeSession()
    saveHeadlessDownloads(path.join(blocker, 'Downloads'))
    electron.app.listeners.get('session-created')!(session)
    const event = { preventDefault: vi.fn() }
    const item = download('file.zip')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    session.listeners.get('will-download')!(event, item)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(item.setSavePath).not.toHaveBeenCalled()
  })

  it('makes names safe and keeps their extension when numbering', () => {
    const none = () => false
    expect(availableDownloadPath('/d', '', new Set(), none)).toBe(path.join('/d', 'download'))
    expect(availableDownloadPath('/d', '..', new Set(), none)).toBe(path.join('/d', 'download'))
    expect(availableDownloadPath('/d', 'a\u0000b\u001f.txt', new Set(), none)).toBe(path.join('/d', 'ab.txt'))
    expect(availableDownloadPath('/d', 'notes', new Set([path.join('/d', 'notes')]), none)).toBe(
      path.join('/d', 'notes (1)')
    )
    expect(path.basename(availableDownloadPath('/d', `${'x'.repeat(300)}.json`, new Set(), none))).toHaveLength(200)
  })
})
