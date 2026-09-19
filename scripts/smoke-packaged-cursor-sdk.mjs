#!/usr/bin/env node
// Run the shipped SDK and SQLite implementation in the actual Electron runtime.
import { _electron as electron } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export async function smoke({ executablePath, authenticated = false } = {}) {
  if (authenticated && (process.env.MAESTRLY_CURSOR_LIVE_SMOKE !== '1' || !process.env.CURSOR_API_KEY)) {
    throw new Error('Live smoke requires MAESTRLY_CURSOR_LIVE_SMOKE=1 and an explicit CURSOR_API_KEY')
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const target =
    process.platform === 'darwin'
      ? `mac-${process.arch}/Maestrly App.app/Contents/MacOS/Maestrly App`
      : process.platform === 'win32'
        ? `${process.arch === 'x64' ? 'win-unpacked' : `win-${process.arch}-unpacked`}/Maestrly App.exe`
        : `${process.arch === 'x64' ? 'linux-unpacked' : `linux-${process.arch}-unpacked`}/maestrly-app`
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'maestrly-cursor-smoke-'))
  let app
  const deadline = setTimeout(() => app?.process().kill('SIGKILL'), 180000)
  deadline.unref()
  try {
    app = await electron.launch({
      executablePath: path.resolve(executablePath ?? path.join(root, 'apps/desktop/dist', target)),
      args: process.platform === 'darwin' ? ['--use-mock-keychain'] : [],
      timeout: 120000,
      env: {
        ...process.env,
        AGENTS_E2E: '1',
        AGENTS_USERDATA: path.join(temporary, 'profile'),
        AGENTS_LOCALE: 'en',
        ELECTRON_RENDERER_URL: '',
        CURSOR_API_KEY: authenticated ? process.env.CURSOR_API_KEY : '',
      },
    })
    const result = await app.evaluate(
      async ({ app }, { temporary, authenticated }) => {
        if (!app.isPackaged) throw new Error('Smoke requires a packaged application')
        const path = process.getBuiltinModule('node:path')
        const { createRequire } = process.getBuiltinModule('node:module')
        const packagedRequire = createRequire(path.join(app.getAppPath(), 'package.json'))
        // Absolute packaged resolution prevents fallback to checkout dependencies.
        const sdk = packagedRequire('./node_modules/@cursor/sdk/dist/cjs/index.js')
        if (typeof sdk.Agent.create !== 'function') throw new Error('SDK agent export missing')
        if (process.platform === 'win32' && process.arch === 'arm64') return { unsupported: true }
        const { SqliteLocalAgentStore } = packagedRequire('./node_modules/@cursor/sdk/dist/cjs/sqlite.js')
        const options = { stateRoot: path.join(temporary, 'sdk-state'), workspaceRef: temporary }
        let store = await SqliteLocalAgentStore.open(options)
        try {
          await store.agents.create({
            agent: { agentId: 'offline-smoke', cwd: temporary, status: 'idle', createdAt: 1, updatedAt: 1 },
          })
        } finally {
          await store.dispose()
        }
        store = await SqliteLocalAgentStore.open(options)
        try {
          const record = await store.agents.get({ agentId: 'offline-smoke' })
          if (record?.agentId !== 'offline-smoke') throw new Error('SDK SQLite record did not survive reopen')
        } finally {
          await store.dispose()
        }
        const helper = path.join(
          process.resourcesPath,
          'app.asar.unpacked/node_modules/@cursor',
          `sdk-${process.platform}-${process.arch}`,
          'bin',
          process.platform === 'win32' ? 'rg.exe' : 'rg'
        )
        const version = process.getBuiltinModule('node:child_process').execFileSync(helper, ['--version'], {
          encoding: 'utf8',
          timeout: 10000,
        })
        if (!version.includes('ripgrep')) throw new Error('Packaged rg did not execute')
        if (authenticated) {
          const models = await sdk.Cursor.models.list({ apiKey: process.env.CURSOR_API_KEY })
          if (!models.length) throw new Error('Authenticated SDK returned no models')
        }
        return { persisted: true, nativeHelper: true, authenticated }
      },
      { temporary, authenticated }
    )
    if (!result.unsupported) assert.equal(result.persisted && result.nativeHelper, true)
    console.log('[cursor-sdk-smoke]', JSON.stringify(result))
  } finally {
    await app?.close().catch(() => undefined)
    clearTimeout(deadline)
    rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await smoke({ executablePath: process.argv[2] })
}
