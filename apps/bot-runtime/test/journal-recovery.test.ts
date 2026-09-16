import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Journal } from '../src/control/journal.js'
import { temporary } from './helpers.js'

const intent = (turnId: string, requestId: string) => JSON.stringify({ kind: 'action.intent', data: { turnId, generation: 1, requestId, tool: 'browser_navigate' } })
const backups = async (state: string) => (await readdir(state)).filter((name) => name.startsWith('journal.jsonl.torn-'))

it('recovers a torn record completed by the next append, keeps the original and loads the complete record', async () => {
  const state = await temporary()
  // What a full disk leaves: the write of t0 stopped midway and the next record continued the line.
  const damaged = `${intent('t1', 'r1')}\n${intent('t0', 'r0').slice(0, 42)}${intent('t2', 'r2')}\n${intent('t3', 'r3')}\n`
  await writeFile(join(state, 'journal.jsonl'), damaged, { mode: 0o600 })
  const journal = new Journal(state)
  expect(journal.hasToolRequest('t1', 'r1')).toBe(true)
  expect(journal.hasToolRequest('t2', 'r2')).toBe(true)
  expect(journal.hasToolRequest('t3', 'r3')).toBe(true)
  // The torn record was never acknowledged; it is not resurrected.
  expect(journal.hasToolRequest('t0', 'r0')).toBe(false)
  const [kept] = await backups(state)
  expect(await readFile(join(state, kept), 'utf8')).toBe(damaged)
  const repaired = (await readFile(join(state, 'journal.jsonl'), 'utf8')).trim().split('\n')
  expect(repaired.map((line) => JSON.parse(line).data.requestId)).toEqual(['r1', 'r2', 'r3'])
  // The repaired journal keeps working and loads again without another repair.
  journal.append('action.intent', { turnId: 't4', generation: 1, requestId: 'r4', tool: 'browser_navigate' })
  const reopened = new Journal(state)
  expect(reopened.hasToolRequest('t4', 'r4')).toBe(true)
  expect(await backups(state)).toHaveLength(1)
})

it('any other malformed completed record stays fatal and leaves the journal untouched', async () => {
  const state = await temporary()
  const damaged = `${intent('t1', 'r1')}\n{"kind":"action.intent","data":{"turnId" "broken"}}\n${intent('t2', 'r2')}\n`
  await writeFile(join(state, 'journal.jsonl'), damaged, { mode: 0o600 })
  expect(() => new Journal(state)).toThrow(/JOURNAL_CORRUPT/)
  expect(await readFile(join(state, 'journal.jsonl'), 'utf8')).toBe(damaged)
  expect(await backups(state)).toEqual([])
})

it('a partial final record left by a crash is still dropped without a backup', async () => {
  const state = await temporary()
  await writeFile(join(state, 'journal.jsonl'), `${intent('t1', 'r1')}\n${intent('t2', 'r2').slice(0, 30)}`, { mode: 0o600 })
  const journal = new Journal(state)
  expect(journal.hasToolRequest('t1', 'r1')).toBe(true)
  expect(journal.hasToolRequest('t2', 'r2')).toBe(false)
  expect(await readFile(join(state, 'journal.jsonl'), 'utf8')).toBe(`${intent('t1', 'r1')}\n`)
  expect(await backups(state)).toEqual([])
})
