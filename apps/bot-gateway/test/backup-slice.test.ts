import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildBackupSlice, readBackupSlice } from '../src/backups/slice.js'
import { Store } from '../src/store.js'
import {
  at,
  botRecord,
  environmentRecord,
  environmentSecrets,
  gatewaySecrets,
  memoryRecord,
  routineRecord,
} from './backup-fixtures.js'

const dirs: string[] = []
const stores: Store[] = []
afterEach(() => {
  for (const store of stores.splice(0))
    try {
      store.close()
    } catch {}
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'backup-slice-'))
  dirs.push(dir)
  const store = new Store(dir)
  stores.push(store)
  store.insertEnvironment(environmentRecord('work', { name: 'Work, at home' }), environmentSecrets('work'))
  store.insertEnvironment(environmentRecord('home'), environmentSecrets('home'))
  store.insertBot(botRecord('ana', { talksTo: ['bea'] }), gatewaySecrets('ana'), { environmentId: 'work', slot: 1 })
  store.insertBot(botRecord('bea', { talksTo: ['ana'] }), gatewaySecrets('bea'), { environmentId: 'work', slot: 3 })
  store.insertBot(botRecord('cid'), gatewaySecrets('cid'), { environmentId: 'home' })
  store.saveRoutine(routineRecord('daily', 'ana'))
  store.saveRoutine(routineRecord('other', 'cid'))
  store.saveOwnerMemory(memoryRecord('own', 'work'))
  store.saveOwnerMemory(memoryRecord('global', null))
  store.saveOwnerMemory(memoryRecord('elsewhere', 'home'))
  return store
}
const database = {
  snapshot: '.config/maestrly-app/.maestrly-backup-staging/maestrly-agents.db',
  live: '.config/maestrly-app/maestrly-agents.db',
}
const build = (store: Store) =>
  buildBackupSlice({
    store,
    environmentId: 'work',
    server: { id: store.serverId(), name: 'Home server' },
    gatewayVersion: '1.2.3',
    now: at(7, 3),
    database,
    projects: null,
  })

describe("the gateway's part of a backup", () => {
  it('keeps the environment, its bots in their slots, routines and memories', () => {
    const store = setup()
    const slice = build(store)
    expect(slice.environment).toMatchObject({ id: 'work', name: 'Work, at home', kind: 'bots' })
    expect(slice.bots.map(({ bot, slot }) => [bot.id, slot, bot.talksTo])).toEqual([
      ['ana', 1, ['bea']],
      ['bea', 3, ['ana']],
    ])
    expect(slice.routines.map((routine) => routine.id)).toEqual(['daily'])
    expect(slice.ownerMemories.map((entry) => entry.id).sort()).toEqual(['global', 'own'])
    expect(slice.keyringPassword).toBe(store.environmentSecrets('work')!.keyringPassword)
    expect(slice.files).toEqual({ database, projects: null })
    expect(readBackupSlice(JSON.stringify(slice))).toEqual({ ok: true, slice })
  })

  it('leaves the tokens out', () => {
    const store = setup()
    const text = JSON.stringify(build(store))
    expect(text).not.toContain(store.environmentSecrets('work')!.controlToken)
    for (const botId of ['ana', 'bea']) expect(text).not.toContain(store.botSecrets(botId)!.gatewayToken)
  })

  it('refuses a newer format, broken text and paths that climb out', () => {
    const slice = build(setup())
    expect(readBackupSlice(JSON.stringify({ ...slice, format: 2 }))).toEqual({ ok: false, problem: 'format-newer' })
    expect(readBackupSlice('{"format":1')).toEqual({ ok: false, problem: 'invalid' })
    expect(readBackupSlice(JSON.stringify({ ...slice, environment: { ...slice.environment, id: 'Bad Id' } }))).toEqual({
      ok: false,
      problem: 'invalid',
    })
    for (const snapshot of ['../x', '/abs', 'a//b', 'a/./b'])
      expect(
        readBackupSlice(JSON.stringify({ ...slice, files: { ...slice.files, database: { ...database, snapshot } } }))
      ).toEqual({ ok: false, problem: 'invalid' })
  })

  it('refuses an environment that is not active', () => {
    const store = setup()
    store.archiveEnvironment('home')
    expect(() =>
      buildBackupSlice({
        store,
        environmentId: 'home',
        server: { id: 'x', name: 'x' },
        gatewayVersion: '1',
        now: at(7),
        database: null,
        projects: null,
      })
    ).toThrow('Environment not found')
  })
})
