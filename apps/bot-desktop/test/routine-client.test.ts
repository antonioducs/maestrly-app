import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { BotJournal } from '../src/main/bot-journal'
import { RoutineClient, validateRoutineCall } from '../src/main/routine-client'
import { HostRequestError } from '../src/main/host-client'

const hostId = 'd9a02e5b-0c12-4411-9393-b5106ecff181'
const stamp = new Date().toISOString()
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
async function file() {
  const directory = await mkdtemp(join(tmpdir(), 'routine-client-'))
  directories.push(directory)
  return join(directory, 'journal.json')
}
const routine = {
  id: 'r-1',
  hostId,
  spec: {
    name: 'Resumo de segunda',
    request: 'Prepare o resumo',
    target: { kind: 'bot' as const, id: 'bot-1' },
    schedule: { kind: 'weekly' as const, daysOfWeek: [1], hour: 9, minute: 0, timeZone: 'America/Sao_Paulo' },
    misfirePolicy: 'skip' as const,
    queueDeadlineMs: 3_600_000,
    ceiling: { activeMs: 1_800_000, maxTools: 80, permissionMode: 'ask' as const },
    resourceIds: [],
  },
  status: 'active' as const,
  fingerprint: 'a'.repeat(64),
  targetVersion: 'b'.repeat(64),
  targetName: 'Assistente',
  watermarkUtc: stamp,
  createdAt: stamp,
  updatedAt: stamp,
  revision: 0,
}
const details = { routine, active: null, recent: [] }

it('refuses anything outside the routine namespace', () => {
  expect(() => validateRoutineCall({ method: 'team.list', params: {} })).toThrow(/Invalid routine request/)
  expect(() => validateRoutineCall({ method: 'routine.list', params: {}, extra: 1 })).toThrow(/Invalid routine request/)
  // A schedule the Host would never accept is refused before it reaches the wire.
  expect(() => validateRoutineCall({ method: 'routine.preview', params: { spec: { ...routine.spec, schedule: { kind: 'cron', expression: '* * * * *' } } } })).toThrow()
  expect(validateRoutineCall({ method: 'routine.list', params: {} }).method).toBe('routine.list')
})

it('validates the result against the shared schema before the renderer sees it', async () => {
  const client = new RoutineClient(new BotJournal(await file()), async () => ({ routine: { ...routine, status: 'weird' }, active: null, recent: [] }))
  client.connected(hostId)
  await expect(client.call({ method: 'routine.inspect', params: { routineId: 'r-1' } })).rejects.toThrow()
})

it('never journals a preview: nothing the person did not confirm is durable', async () => {
  const path = await file()
  const client = new RoutineClient(new BotJournal(path), async () => ({
    previewId: 'p-1',
    fingerprint: 'c'.repeat(64),
    hostId,
    spec: routine.spec,
    targetName: 'Assistente',
    targetVersion: 'b'.repeat(64),
    occurrences: [],
    effectiveCeiling: routine.spec.ceiling,
    permissionSummary: [],
    warnings: [],
    feasible: true,
    expiresAt: stamp,
  }))
  client.connected(hostId)
  await client.call({ method: 'routine.preview', params: { spec: routine.spec } })
  expect(await client.unresolved()).toEqual([])
  await expect(readFile(path, 'utf8')).rejects.toThrow()
})

it('journals an activation and looks it up after a lost reply, never activating twice', async () => {
  const path = await file()
  const sent: string[] = []
  const asked: string[] = []
  let drop = true
  const client = new RoutineClient(new BotJournal(path), async (method, params) => {
    if (method === 'routine.activate') {
      sent.push(String(params.previewId))
      if (drop) throw new Error('connection dropped')
      return details
    }
    asked.push(String(params.idempotencyKey))
    return { id: 'op-1', kind: 'routine.activate', routineId: 'r-1', status: 'succeeded', createdAt: stamp, updatedAt: stamp }
  })
  client.connected(hostId)
  const key = randomUUID()
  await expect(
    client.call({ method: 'routine.activate', params: { previewId: 'p-1', fingerprint: 'c'.repeat(64), idempotencyKey: key, confirmSchedule: true } })
  ).rejects.toThrow()
  expect((await client.unresolved()).length).toBe(1)
  drop = false
  const recovery = await client.recover()
  expect(recovery).toEqual({ recovered: 1, unresolved: 0 })
  // The activation was consulted, not repeated.
  expect(asked).toEqual([key])
  expect(sent).toEqual(['p-1'])
})

it('forgets the key when the Host refused the activation outright', async () => {
  const client = new RoutineClient(new BotJournal(await file()), async () => {
    throw new HostRequestError('Esta confirmação expirou', 'ROUTINE_PREVIEW_EXPIRED')
  })
  client.connected(hostId)
  await expect(
    client.call({ method: 'routine.activate', params: { previewId: 'p-1', fingerprint: 'c'.repeat(64), idempotencyKey: randomUUID(), confirmSchedule: true } })
  ).rejects.toThrow(/expirou/)
  // A refusal is definitive: the person previews again instead of the app retrying.
  expect(await client.unresolved()).toEqual([])
})

it('refuses to work before the Host identity is known', async () => {
  const client = new RoutineClient(new BotJournal(await file()), async () => details)
  await expect(client.call({ method: 'routine.list', params: {} })).rejects.toThrow(/Conecte-se/)
})
