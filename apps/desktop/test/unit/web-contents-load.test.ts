import { describe, expect, it, vi } from 'vitest'
import { settleLoad, startLoad } from '../../src/main/web-contents-load'

/** The error Electron rejects `loadURL`/`loadFile` with. */
function loadError(code: string, errno: number): Error {
  const url = 'file:///opt/Maestrly App/resources/app.asar/out/renderer/index.html?tkn=secret'
  return Object.assign(new Error(`${code} (${errno}) loading '${url}'`), { code, errno, url })
}

describe('web contents loads', () => {
  it('reports a finished load', async () => {
    const log = vi.fn()
    await expect(settleLoad('main-window', Promise.resolve(), log)).resolves.toBe(true)
    expect(log).not.toHaveBeenCalled()
  })

  it('reports a failed load by its net error, without the URL', async () => {
    const log = vi.fn()
    await expect(settleLoad('main-window', Promise.reject(loadError('ERR_FAILED', -2)), log)).resolves.toBe(false)
    expect(log).toHaveBeenCalledOnce()
    const line = log.mock.calls[0][0] as string
    expect(JSON.parse(line)).toMatchObject({ label: 'main-window', error: 'ERR_FAILED (-2)' })
    expect(line).not.toMatch(/secret|app\.asar/)
  })

  it('stays quiet when a newer navigation replaced the load', async () => {
    const log = vi.fn()
    await expect(settleLoad('vscode', Promise.reject(loadError('ERR_ABORTED', -3)), log)).resolves.toBe(false)
    expect(log).not.toHaveBeenCalled()
  })

  it('leaves no unhandled rejection behind a load nobody waits for', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const log = vi.fn()
      startLoad('panel:terminal', Promise.reject(loadError('ERR_FAILED', -2)), log)
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(log).toHaveBeenCalledOnce()
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})
