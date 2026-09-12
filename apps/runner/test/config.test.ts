import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readConfig, writeConfig } from '../src/config.js'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))))

describe('runner config', () => {
  it('stores machine credentials in a private file independent of Electron', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'maestrly-runner-config-'))
    directories.push(directory)
    const file = path.join(directory, 'config.json')
    const value = {
      serverUrl: 'http://127.0.0.1:4310', organizationId: 'org', runnerId: 'runner', credential: 'x'.repeat(32),
      name: 'runner', isolationMode: 'native-sandbox' as const, containerImage: 'local', maxConcurrency: 1, repositories: [],
    }
    await writeConfig(value, file)
    expect(await readConfig(file)).toEqual(value)
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(await readFile(file, 'utf8')).not.toContain('electron')
  })
})
