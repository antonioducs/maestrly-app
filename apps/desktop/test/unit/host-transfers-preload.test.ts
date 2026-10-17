import * as electron from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { transfersApi } from '../../src/preload/api-transfers'

afterEach(() => vi.restoreAllMocks())

describe('transfer queue preload', () => {
  it('takes the paths of dropped files from the files, and leaves out files without one', async () => {
    const invoke = vi.spyOn(electron.ipcRenderer, 'invoke').mockResolvedValue({ queued: [], skipped: [] })
    await transfersApi.transfersUploadFiles('direct/host', '/srv', [{ path: '/a.csv' }, { path: '' }] as never)
    expect(invoke).toHaveBeenCalledWith('transfers:upload-paths', 'direct/host', '/srv', ['/a.csv'])
  })

  it('asks for files or folders to upload, and downloads a folder by its path', async () => {
    const invoke = vi.spyOn(electron.ipcRenderer, 'invoke').mockResolvedValue({ queued: [], skipped: [] })
    await transfersApi.transfersUploadPick('direct/host', '/srv')
    expect(invoke).toHaveBeenLastCalledWith('transfers:upload-pick', 'direct/host', '/srv', 'files')
    await transfersApi.transfersUploadPick('direct/host', '/srv', 'folder')
    expect(invoke).toHaveBeenLastCalledWith('transfers:upload-pick', 'direct/host', '/srv', 'folder')
    await transfersApi.transfersDownloadFolder('direct/host', '/srv/site')
    expect(invoke).toHaveBeenLastCalledWith('transfers:download-folder', 'direct/host', '/srv/site')
  })

  it('follows the queue until the subscriber stops', () => {
    const on = vi.spyOn(electron.ipcRenderer, 'on')
    const off = vi.spyOn(electron.ipcRenderer, 'removeListener')
    const changed = vi.fn()
    const stop = transfersApi.onTransfersChanged(changed)
    const [channel, listener] = on.mock.calls.at(-1) as [string, (event: unknown, value: unknown) => void]
    expect(channel).toBe('transfers:changed')
    listener({}, [{ id: 't1' }])
    expect(changed).toHaveBeenCalledWith([{ id: 't1' }])
    stop()
    expect(off).toHaveBeenCalledWith('transfers:changed', listener)
  })
})
