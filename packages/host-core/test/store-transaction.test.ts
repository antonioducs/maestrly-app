import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { HostStore } from '../src/persistence/store.js'

it.skipIf(process.platform === 'win32')('nested transactions run as savepoints: inner work commits with the outer one, an inner failure rolls back only itself', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'store-tx-')))
  const store = new HostStore(dir)
  try {
    const put = (key: string) => store.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(key, 'v')
    const has = (key: string) => !!store.db.prepare('SELECT 1 FROM metadata WHERE key=?').get(key)
    store.transaction(() => {
      put('outer')
      store.transaction(() => put('inner'))
      expect(() =>
        store.transaction(() => {
          put('failed')
          throw new Error('inner failure')
        })
      ).toThrow('inner failure')
    })
    expect([has('outer'), has('inner'), has('failed')]).toEqual([true, true, false])
    expect(() =>
      store.transaction(() => {
        put('all')
        store.transaction(() => put('nested'))
        throw new Error('outer failure')
      })
    ).toThrow('outer failure')
    expect([has('all'), has('nested')]).toEqual([false, false])
    // Nothing is left open: the connection keeps working.
    store.transaction(() => put('after'))
    expect(has('after')).toBe(true)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
