import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { browserPagePreloadPath, registerBrowserPagePreload } from '../../src/main/drawer/browser-page-preload'

const APP_PATH = path.resolve(__dirname, '../..')
const PRELOAD = browserPagePreloadPath(APP_PATH)

interface FakePage {
  window: Record<string, unknown> & { chrome?: Record<string, unknown> }
  context: vm.Context
}

/** Runs the shipped preload as a sandboxed preload would: `require('electron')` is its only module. */
function runPreload(executeJavaScript: (code: string) => Promise<unknown>): void {
  vm.runInNewContext(fs.readFileSync(PRELOAD, 'utf8'), {
    require: (id: string) => {
      if (id !== 'electron') throw new Error(`a sandboxed preload cannot load ${id}`)
      return { webFrame: { executeJavaScript } }
    },
  })
}

/** A page's main world with the navigation timing Chromium reports for a document loaded over HTTP/2. */
function pageWith(chrome?: Record<string, unknown>): FakePage {
  const navigation = {
    type: 'navigate',
    nextHopProtocol: 'h2',
    startTime: 0,
    requestStart: 40,
    responseStart: 120,
    domContentLoadedEventEnd: 300,
    loadEventEnd: 450,
  }
  const window: FakePage['window'] = chrome ? { chrome } : {}
  const performance = {
    timeOrigin: 1_700_000_000_000,
    now: () => 500,
    getEntriesByType: (type: string) => (type === 'navigation' ? [navigation] : []),
    getEntriesByName: (name: string) => (name === 'first-paint' ? [{ startTime: 200 }] : []),
  }
  return { window, context: vm.createContext({ window, performance }) }
}

function injectInto(page: FakePage): void {
  let script = ''
  runPreload((code) => {
    script = code
    return Promise.resolve()
  })
  expect(script).not.toBe('')
  vm.runInContext(script, page.context)
}

describe('drawer browser page preload', () => {
  it('ships where the app looks for it', () => {
    expect(fs.existsSync(PRELOAD)).toBe(true)
    expect(path.relative(APP_PATH, PRELOAD)).toBe(path.join('resources', 'browser-page-preload.cjs'))
  })

  it('finds the resource when the app is launched from its bundled entry', () => {
    expect(browserPagePreloadPath(path.join(APP_PATH, 'out', 'main'))).toBe(PRELOAD)
  })

  it('falls back to the app path when no folder has the resource', () => {
    const elsewhere = path.join(APP_PATH, 'no-such-folder')
    expect(browserPagePreloadPath(elsewhere)).toBe(path.join(elsewhere, 'resources', 'browser-page-preload.cjs'))
  })

  it('hands one script to the page main world', () => {
    const executeJavaScript = vi.fn().mockResolvedValue(undefined)
    runPreload(executeJavaScript)
    expect(executeJavaScript).toHaveBeenCalledTimes(1)
  })

  it('gives a page without window.chrome the members Chrome has', () => {
    const page = pageWith()
    injectInto(page)
    expect(Object.keys(page.window.chrome!)).toEqual(['loadTimes', 'csi', 'app'])
  })

  it('fills the members of the empty window.chrome Electron starts with, in place', () => {
    const electronChrome = {}
    const page = pageWith(electronChrome)
    injectInto(page)
    expect(page.window.chrome).toBe(electronChrome)
    expect(Object.keys(electronChrome)).toEqual(['loadTimes', 'csi', 'app'])
  })

  it('reports the page navigation timing in loadTimes and csi', () => {
    const page = pageWith()
    injectInto(page)
    const chrome = page.window.chrome as { loadTimes(): Record<string, unknown>; csi(): Record<string, unknown> }
    expect(chrome.loadTimes()).toMatchObject({
      requestTime: 1_700_000_000.04,
      commitLoadTime: 1_700_000_000.12,
      finishLoadTime: 1_700_000_000.45,
      firstPaintTime: 1_700_000_000.2,
      navigationType: 'Other',
      wasFetchedViaSpdy: true,
      npnNegotiatedProtocol: 'h2',
      connectionInfo: 'h2',
    })
    expect(chrome.csi()).toEqual({
      startE: 1_700_000_000_000,
      onloadT: 1_700_000_000_450,
      pageT: 500,
      tran: 15,
    })
  })

  it('describes the page as not an installed app', () => {
    const page = pageWith()
    injectInto(page)
    const app = page.window.chrome!.app as {
      isInstalled: boolean
      getIsInstalled(): boolean
      getDetails(): unknown
      runningState(): string
    }
    expect(app.isInstalled).toBe(false)
    expect(app.getIsInstalled()).toBe(false)
    expect(app.getDetails()).toBeNull()
    expect(app.runningState()).toBe('cannot_run')
  })

  it('leaves the members that a page already has', () => {
    const csi = (): string => 'own'
    const page = pageWith({ csi })
    injectInto(page)
    expect(page.window.chrome!.csi).toBe(csi)
    expect(typeof page.window.chrome!.loadTimes).toBe('function')
  })

  it('does not stop the page from loading when the frame refuses the script', async () => {
    expect(() => runPreload(() => Promise.reject(new Error('frame gone')))).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})

describe('registerBrowserPagePreload', () => {
  it('runs the preload in every frame of the session', () => {
    const registerPreloadScript = vi.fn()
    registerBrowserPagePreload({ registerPreloadScript } as never, APP_PATH)
    expect(registerPreloadScript).toHaveBeenCalledWith({ type: 'frame', filePath: PRELOAD })
  })
})
