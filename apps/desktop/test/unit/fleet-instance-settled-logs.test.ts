import { randomUUID } from 'node:crypto'
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import { InstanceInputQueue, settledLog, type QueuedInput } from '../../src/main/fleet/instance/queue'
import { InstanceTranscriptExtras } from '../../src/main/fleet/instance/transcript'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'fleet-settled-logs-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})
const key = () => randomUUID()
const lines = async (file: string) => (await readFile(file, 'utf8')).split('\n').filter((line) => line.trim())
async function queueAt(file: string) {
  const queue = new InstanceInputQueue(file, path.join(dir, 'attachments'))
  await queue.load()
  return queue
}
/** Enqueues, starts and maps an input: what a finished turn leaves in the queue. */
async function settle(queue: InstanceInputQueue, text: string, nativeMessageId: string) {
  const receipt = await queue.enqueue({ idempotencyKey: key(), source: 'owner', text })
  await queue.markStarted(receipt.inputId)
  await queue.mapNativeMessage(receipt.inputId, nativeMessageId)
  return receipt
}

describe('input queue settled log', () => {
  it('keeps only the inputs that can still change in the file each change rewrites', async () => {
    const file = path.join(dir, 'inputs.json')
    const queue = await queueAt(file)
    for (let index = 0; index < 50; index++) await settle(queue, 'Done ' + index, 'native-' + index)
    const waiting = await queue.enqueue({ idempotencyKey: key(), source: 'owner', text: 'Waiting' })
    expect(JSON.parse(await readFile(file, 'utf8')).items.map((item: QueuedInput) => item.id)).toEqual([
      waiting.inputId,
    ])
    expect((await stat(file)).size).toBeLessThan(1_000)
    expect(await lines(settledLog(file))).toHaveLength(50)
    const reopened = await queueAt(file)
    expect(reopened.all()).toEqual(queue.all())
    expect(reopened.list().map((item) => item.id)).toEqual([waiting.inputId])
    expect(reopened.transcriptInputs().forMessage('native-7')?.input.text).toBe('Done 7')
    expect(reopened.byItemId(queue.all()[3].itemId)?.nativeMessageId).toBe('native-3')
  })

  it('moves the settled inputs of a file from before the log on load', async () => {
    const file = path.join(dir, 'inputs.json')
    const record = (text: string, extra: Partial<QueuedInput>): QueuedInput => {
      const id = randomUUID()
      return {
        id,
        at: new Date().toISOString(),
        input: { idempotencyKey: key(), text, source: 'owner' },
        attachments: [],
        itemId: 'input:' + id,
        started: false,
        ...extra,
      }
    }
    const old = [
      record('Done', { started: true, nativeMessageId: 'native-1' }),
      record('Running', { started: true }),
      record('Queued', {}),
    ]
    await writeFile(file, JSON.stringify({ items: old }))
    const queue = await queueAt(file)
    expect(queue.all()).toEqual([old[0], old[1], old[2]])
    expect(JSON.parse(await readFile(file, 'utf8')).items).toEqual([old[1], old[2]])
    expect((await lines(settledLog(file))).map((line) => JSON.parse(line))).toEqual([old[0]])
    expect((await queueAt(file)).all()).toEqual(queue.all())
  })

  it('keeps an input as the file has it when a crash came between the log and the file', async () => {
    const file = path.join(dir, 'inputs.json')
    const queue = await queueAt(file)
    const receipt = await queue.enqueue({ idempotencyKey: key(), source: 'owner', text: 'Hello' })
    await queue.markStarted(receipt.inputId)
    const started = queue.all()[0]
    // Logged as settled; the file still has it started and unmapped.
    await appendFile(settledLog(file), '\n' + JSON.stringify({ ...started, nativeMessageId: 'native-user' }))
    const reopened = await queueAt(file)
    expect(reopened.all()).toEqual([started])
    await reopened.reconcile([{ id: 'native-user', at: Date.now(), text: 'Hello' }])
    const again = await queueAt(file)
    expect(again.all()).toEqual([{ ...started, nativeMessageId: 'native-user' }])
    expect(again.list()).toEqual([])
  })

  it('reads past a line a crash cut short and loses nothing after it', async () => {
    const file = path.join(dir, 'inputs.json')
    const queue = await queueAt(file)
    await settle(queue, 'First', 'native-1')
    await appendFile(settledLog(file), '\n{"id":"cut sh')
    await settle(queue, 'Second', 'native-2')
    const reopened = await queueAt(file)
    expect(reopened.all().map((item) => item.input.text)).toEqual(['First', 'Second'])
  })

  it('answers retries, deletions and matching as before for inputs in the log', async () => {
    const file = path.join(dir, 'inputs.json')
    const queue = await queueAt(file)
    const idempotencyKey = key()
    const first = await queue.enqueue({ idempotencyKey, source: 'owner', text: 'Hello' })
    await queue.markStarted(first.inputId)
    await queue.mapNativeMessage(first.inputId, 'native-hello')
    const reopened = await queueAt(file)
    expect(await reopened.enqueue({ idempotencyKey, source: 'owner', text: 'Hello again' })).toEqual({
      inputId: first.inputId,
      itemId: first.itemId,
      queued: false,
    })
    expect(await reopened.delete(first.inputId)).toBe('started')
    expect(await reopened.delete('missing')).toBe('missing')
    // A native message a settled input claimed is never given to another input.
    const second = await reopened.enqueue({ idempotencyKey: key(), source: 'owner', text: 'Hello' })
    await reopened.markStarted(second.inputId)
    await reopened.reconcile([{ id: 'native-hello', at: Date.now(), text: 'Hello' }])
    expect(reopened.list().map((item) => item.id)).toEqual([second.inputId])
  })
})

describe('transcript extras settled log', () => {
  const system = (id: string): FleetTranscriptItem => ({
    kind: 'system',
    id,
    at: new Date().toISOString(),
    code: 'restarted',
    text: null,
    durationMs: null,
  })
  const permission = (id: string, state: 'pending' | 'approved'): FleetTranscriptItem => ({
    kind: 'permission',
    id: 'perm:' + id,
    at: '2026-09-27T10:00:00.000Z',
    requestId: id,
    title: 'Run ls',
    detail: null,
    tool: null,
    state,
    resolvedAt: state === 'pending' ? null : '2026-09-27T10:00:01.000Z',
  })

  it('keeps only pending interactions in the file and every item across a restart', async () => {
    const file = path.join(dir, 'transcript.json')
    const extras = new InstanceTranscriptExtras(file, () => {})
    await extras.load()
    for (let index = 0; index < 30; index++) await extras.upsert(system('system:' + index))
    await extras.upsert(permission('a', 'pending'))
    await extras.upsert(permission('b', 'pending'))
    expect(JSON.parse(await readFile(file, 'utf8')).map((item: FleetTranscriptItem) => item.id)).toEqual([
      'perm:a',
      'perm:b',
    ])
    await extras.upsert(permission('a', 'approved'))
    expect(JSON.parse(await readFile(file, 'utf8')).map((item: FleetTranscriptItem) => item.id)).toEqual(['perm:b'])
    expect(await lines(settledLog(file))).toHaveLength(31)
    const reopened = new InstanceTranscriptExtras(file, () => {})
    await reopened.load()
    expect(reopened.list()).toEqual(extras.list())
    expect(reopened.list().find((item) => item.id === 'perm:a')).toMatchObject({ state: 'approved' })
    // A settled item written again keeps its place; the last version wins.
    await reopened.upsert({ ...system('system:3'), text: 'Updated' })
    const again = new InstanceTranscriptExtras(file, () => {})
    await again.load()
    expect(again.list()).toEqual(reopened.list())
    expect(again.list()[3]).toMatchObject({ id: 'system:3', text: 'Updated' })
  })

  it('moves the settled items of a file from before the log, and keeps a file version over the log', async () => {
    const file = path.join(dir, 'transcript.json')
    await writeFile(
      file,
      JSON.stringify([system('system:old'), permission('p', 'pending'), permission('q', 'approved')])
    )
    const extras = new InstanceTranscriptExtras(file, () => {})
    await extras.load()
    expect(extras.list().map((item) => item.id)).toEqual(['system:old', 'perm:q', 'perm:p'])
    expect(JSON.parse(await readFile(file, 'utf8')).map((item: FleetTranscriptItem) => item.id)).toEqual(['perm:p'])
    // A crash after logging it settled, before the file dropped it: the file still has it pending.
    await appendFile(settledLog(file), '\n' + JSON.stringify(permission('p', 'approved')))
    const reopened = new InstanceTranscriptExtras(file, () => {})
    await reopened.load()
    expect(reopened.list().find((item) => item.id === 'perm:p')).toMatchObject({ state: 'pending' })
    expect(reopened.list()).toHaveLength(3)
  })
})
