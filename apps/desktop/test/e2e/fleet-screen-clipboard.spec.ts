import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { test, expect, _electron as electron } from '@playwright/test'

// Exercise native Electron Edit commands against the real bridge on a focused canvas.
// The canvas consumes keys like noVNC; this catches regressions hidden by synthetic ClipboardEvents.
test('screen clipboard uses native paste/copy commands and leaves other editors alone', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maestrly-screen-clipboard-'))
  const source = await readFile(new URL('../../src/renderer/lib/fleet/screen-clipboard.ts', import.meta.url), 'utf8')
  const script = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const nativeSource = await readFile(new URL('../../src/main/fleet/client/screen-bridge.ts', import.meta.url), 'utf8')
  await writeFile(
    path.join(root, 'bridge.cjs'),
    ts.transpileModule(nativeSource, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText
  )
  await writeFile(
    path.join(root, 'preload.cjs'),
    `
    const { contextBridge, ipcRenderer } = require('electron')
    contextBridge.exposeInMainWorld('nativeRead', () => ipcRenderer.invoke('clipboard-test:read'))
    contextBridge.exposeInMainWorld('nativeWrite', (text) => ipcRenderer.invoke('clipboard-test:write', text))
  `
  )
  await writeFile(
    path.join(root, 'index.html'),
    '<div id="screen"><canvas tabindex="0"></canvas></div><textarea></textarea>'
  )
  await writeFile(
    path.join(root, 'main.cjs'),
    `
    const { app, BrowserWindow, Menu, ipcMain } = require('electron')
    const { FleetScreenBridge } = require('./bridge.cjs')
    app.setPath('userData', ${JSON.stringify(path.join(root, 'profile'))})
    app.whenReady().then(async () => {
      Menu.setApplicationMenu(Menu.buildFromTemplate([{role: 'editMenu'}]))
      const window = new BrowserWindow({webPreferences: {contextIsolation: true, preload: ${JSON.stringify(path.join(root, 'preload.cjs'))}}})
      const socket = Object.assign(new EventTarget(), {readyState: 1, close() {}, send() {}})
      const bridge = new FleetScreenBridge(() => ({ origin: 'https://fleet.example', call: async () => ({ path: '/v1/screen?ticket=test' }) }), () => socket)
      const { channelId } = await bridge.openScreen(window.webContents, 'bot', 'control')
      ipcMain.handle('clipboard-test:read', (event) => bridge.readClipboard(event.sender, channelId))
      ipcMain.handle('clipboard-test:write', (event, text) => bridge.writeClipboard(event.sender, channelId, text))
      window.loadFile(${JSON.stringify(path.join(root, 'index.html'))})
    })
  `
  )
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    app = await electron.launch({ args: [path.join(root, 'main.cjs')] })
    const page = await app.firstWindow()
    await page.evaluate(
      ({ script, isMac }) => {
        const exports: Record<string, (...args: any[]) => any> = {}
        new Function('exports', script)(exports)
        const container = document.querySelector<HTMLElement>('#screen')!
        const remote = Object.assign(new EventTarget(), {
          clipboardPasteFrom: (text: string) => {
            state.pasted.push(text)
          },
          sendKey: (sym: number, code: string, down?: boolean) => {
            state.keys.push([sym, code, down])
            if (code === 'KeyC')
              setTimeout(
                () => remote.dispatchEvent(new CustomEvent('clipboard', { detail: { text: 'copied from bot' } })),
                100
              )
          },
        })
        const state = { pasted: [] as string[], keys: [] as unknown[][], errors: [] as string[], detach: () => {} }
        ;(window as any).clipboardTest = state
        state.detach = exports.attachScreenClipboard(
          container,
          remote,
          (text: string) => (window as any).nativeWrite(text),
          isMac,
          (error: unknown) => {
            if (error) state.errors.push(String(error))
          },
          () => (window as any).nativeRead()
        )
        container.querySelector('canvas')!.addEventListener('keydown', (event) => {
          event.preventDefault()
          event.stopPropagation()
        })
      },
      { script, isMac: process.platform === 'darwin' }
    )
    await page.locator('canvas').focus()
    await app.evaluate(({ clipboard }) => clipboard.writeText('Olá\nfrom the host'))
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${modifier}+v`)
    await expect.poll(() => page.evaluate(() => (window as any).clipboardTest.pasted)).toEqual(['Olá\nfrom the host'])
    await app.evaluate(({ clipboard }) => clipboard.writeText('terminal paste'))
    await page.keyboard.press(`${modifier}+Shift+v`)
    await expect
      .poll(() => page.evaluate(() => (window as any).clipboardTest.pasted))
      .toEqual(['Olá\nfrom the host', 'terminal paste'])
    await expect
      .poll(() => page.evaluate(() => (window as any).clipboardTest.keys))
      .toContainEqual([0xffe1, 'ShiftLeft', true])
    await page.evaluate(() => {
      ;(window as any).clipboardTest.keys = []
    })
    // A later menu paste must not inherit Shift from the terminal shortcut.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.paste())
    await expect.poll(() => page.evaluate(() => (window as any).clipboardTest.pasted)).toHaveLength(3)
    expect(await page.evaluate(() => (window as any).clipboardTest.keys)).not.toContainEqual([
      0xffe1,
      'ShiftLeft',
      true,
    ])
    await page.keyboard.press(`${modifier}+c`)
    await page.locator('textarea').focus()
    await expect.poll(() => app!.evaluate(({ clipboard }) => clipboard.readText())).toBe('copied from bot')
    await page.locator('canvas').focus()
    await page.keyboard.press(`${modifier}+Shift+c`)
    await expect
      .poll(() => page.evaluate(() => (window as any).clipboardTest.keys))
      .toContainEqual([0xffe1, 'ShiftLeft', true])
    await page.locator('textarea').focus()
    await page.keyboard.press(`${modifier}+v`)
    await expect(page.locator('textarea')).toHaveValue('copied from bot')
    await page.locator('canvas').focus()
    // Menu commands must work even without a keyboard event.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.paste())
    await expect
      .poll(() => page.evaluate(() => (window as any).clipboardTest.pasted))
      .toEqual(['Olá\nfrom the host', 'terminal paste', 'terminal paste', 'copied from bot'])
    expect(await page.evaluate(() => (window as any).clipboardTest.errors)).toEqual([])
    await page.evaluate(() => (window as any).clipboardTest.detach())
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.paste())
    expect(await page.evaluate(() => (window as any).clipboardTest.pasted)).toHaveLength(4)
  } finally {
    await app?.close()
    await rm(root, { recursive: true, force: true })
  }
})
