import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import type http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { buildPath, FLEET_INSTANCE_ROUTES } from '@maestrly/bot-fleet-protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseBotInstanceConfig } from '../../src/main/fleet/instance/config'
import {
  createInstanceControlServer,
  type InstanceEnvironment,
  InstanceEvents,
} from '../../src/main/fleet/instance/server'
import { type HostFilesEndpoint, httpHostFilesEndpoint, TransientFailure } from '../../src/main/host-transfers/endpoint'
import { HostTransferEngine, type HostTransferEngineDeps } from '../../src/main/host-transfers/engine'
import { HostFiles } from '../../src/main/remote-host/server/host-files'
import type { HostTransferState, HostTransferView } from '../../src/shared/host-transfers'
import { closeDb, freshDb, restartDb } from '../helpers/db'

const KiB = 1024
const MiB = 1024 * KiB
const HOST = 'direct/host'
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const token = randomBytes(32).toString('base64url')
const config = parseBotInstanceConfig({
  MAESTRLY_BOT_MODE: '1',
  MAESTRLY_BOT_CONTROL_TOKEN: token,
  MAESTRLY_BOT_CONTROL_HOST: '127.0.0.1',
  MAESTRLY_BOT_CONTROL_PORT: '0',
})!

type RawInit = Parameters<HostFilesEndpoint['raw']>[1]
/** What the test does to a raw call before (or instead of) sending it; returning a Response answers it. */
type Fault = (call: { key: string; init: RawInit; range: string | null; count: number }) => Promise<Response | void>

let base: string
let srv: string
let local: string
let downloads: string
let openDir: string
let server: http.Server
let real: HostFilesEndpoint
let fault: Fault | null
let calls: Array<{ key: string; range: string | null }>
const engines: HostTransferEngine[] = []

beforeEach(async () => {
  freshDb()
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'host-transfers-')))
  srv = path.join(base, 'srv')
  local = path.join(base, 'local')
  downloads = path.join(base, 'downloads')
  openDir = path.join(base, 'open')
  for (const dir of [srv, local]) mkdirSync(dir)
  const hostFiles = new HostFiles({ roots: () => [srv], readRoots: () => [], uploadsDir: path.join(base, 'uploads') })
  server = createInstanceControlServer(config, { events: new InstanceEvents() } as unknown as InstanceEnvironment, {
    hostFiles,
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  real = httpHostFilesEndpoint({
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    headers: () => ({ 'X-Maestrly-Fleet-Protocol': '1', Authorization: `Bearer ${token}` }),
    path: (key, params) => buildPath(FLEET_INSTANCE_ROUTES[key].path, params),
  })
  fault = null
  calls = []
})
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  closeDb()
  rmSync(base, { recursive: true, force: true })
})

/** The host's endpoint, with the test's fault applied to raw calls. */
const endpoint: HostFilesEndpoint = {
  json: (key, init) => real.json(key, init),
  async raw(key, init) {
    const range = init.headers.range ?? null
    calls.push({ key, range })
    const count = calls.filter((call) => call.key === key && call.range === range).length
    const answered = fault ? await fault({ key, init, range, count }) : undefined
    return answered ?? real.raw(key, init)
  },
}

function engine(overrides: Partial<HostTransferEngineDeps> = {}) {
  const emitted: HostTransferView[][] = []
  const opened: string[] = []
  const created = new HostTransferEngine({
    endpoint: () => endpoint,
    downloadsDir: () => downloads,
    openDir: () => openDir,
    openPath: async (file) => void opened.push(file),
    emit: (transfers) => emitted.push(transfers),
    backoffMs: () => 0,
    limits: { rangeBytes: MiB, chunkBytes: 512 * KiB },
    ...overrides,
  })
  engines.push(created)
  created.start()
  return { engine: created, emitted, opened }
}

async function settled(target: HostTransferEngine, id: string, state: HostTransferState, timeout = 15_000) {
  const started = Date.now()
  for (;;) {
    const view = target.list().find((item) => item.id === id)
    if (view?.state === state) return view
    if (Date.now() - started > timeout)
      throw new Error(`Transfer ${id} is ${view?.state} (${view?.error}), not ${state}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** A call that hangs until its transfer is aborted, and says when it started. */
function hold() {
  let started!: () => void
  const reached = new Promise<void>((resolve) => {
    started = resolve
  })
  const wait = (init: RawInit) =>
    new Promise<never>((_resolve, reject) => {
      started()
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })
  return { reached, wait }
}

const csv = (size: number) => Buffer.from('id,name,amount\n1,alpha,10\n'.repeat(Math.ceil(size / 25))).subarray(0, size)

// The engine runs on every computer, but these tests drive it against a real host, which runs on Linux or macOS and
// takes POSIX paths only.
describe.skipIf(process.platform === 'win32')('host transfer engine', () => {
  it('downloads a file in verified ranges, and never replaces a file already there', async () => {
    const bytes = csv(2.5 * MiB)
    writeFileSync(path.join(srv, 'report.csv'), bytes)
    const { engine: queue } = engine()
    const first = await queue.download(HOST, path.join(srv, 'report.csv'))
    const done = await settled(queue, first, 'done')
    expect(done).toMatchObject({ doneBytes: bytes.length, sha256: sha(bytes) })
    expect(sha(readFileSync(path.join(downloads, 'report.csv')))).toBe(sha(bytes))
    expect(calls.filter((call) => call.key === 'hostFileContent')).toHaveLength(3)
    const second = await queue.download(HOST, path.join(srv, 'report.csv'))
    expect((await settled(queue, second, 'done')).localPath).toBe(path.join(downloads, 'report (1).csv'))
    expect(readdirSync(downloads).sort()).toEqual(['report (1).csv', 'report.csv'])
  })

  it('uploads a file in chunks, checked whole by the host', async () => {
    const bytes = randomBytes(1.3 * MiB)
    writeFileSync(path.join(local, 'data.bin'), bytes)
    const { engine: queue } = engine()
    const { queued, skipped } = await queue.upload(HOST, [path.join(local, 'data.bin'), local, 'relative'], srv)
    expect(skipped).toEqual(['local', 'relative'])
    const done = await settled(queue, queued[0], 'done')
    expect(done).toMatchObject({ remotePath: path.join(srv, 'data.bin'), sha256: sha(bytes) })
    expect(calls.filter((call) => call.key === 'hostFileUploadChunk')).toHaveLength(3)
    expect(sha(readFileSync(path.join(srv, 'data.bin')))).toBe(sha(bytes))
    expect(readdirSync(srv)).toEqual(['data.bin'])
  })

  it('pauses and resumes from the ranges left, and cancels an upload on the host', async () => {
    const bytes = csv(2.5 * MiB)
    writeFileSync(path.join(srv, 'report.csv'), bytes)
    const held = hold()
    // Ranges one at a time, so that pausing finds exactly the first one done.
    const { engine: queue } = engine({ limits: { rangeBytes: MiB, chunkBytes: 512 * KiB, rangesPerTransfer: 1 } })
    fault = async ({ init, range, count }) =>
      range === `bytes=${MiB}-${2 * MiB - 1}` && count === 1 ? held.wait(init) : undefined
    const id = await queue.download(HOST, path.join(srv, 'report.csv'))
    await held.reached
    queue.pause(id)
    expect((await settled(queue, id, 'paused')).doneBytes).toBe(MiB)
    queue.resume(id)
    await settled(queue, id, 'done')
    expect(calls.filter((call) => call.range === `bytes=0-${MiB - 1}`)).toHaveLength(1)
    expect(sha(readFileSync(path.join(downloads, 'report.csv')))).toBe(sha(bytes))

    const upload = randomBytes(MiB)
    writeFileSync(path.join(local, 'up.bin'), upload)
    const chunk = hold()
    fault = async ({ key, init }) => (key === 'hostFileUploadChunk' ? chunk.wait(init) : undefined)
    const { queued } = await queue.upload(HOST, [path.join(local, 'up.bin')], srv)
    await chunk.reached
    await queue.cancel(queued[0])
    expect((await settled(queue, queued[0], 'canceled')).state).toBe('canceled')
    expect(readdirSync(srv)).toEqual(['report.csv'])
    expect(readdirSync(path.join(base, 'uploads'))).toEqual([])
  })

  it('goes on after the app quits, fetching only the ranges left', async () => {
    const bytes = csv(2.5 * MiB)
    writeFileSync(path.join(srv, 'report.csv'), bytes)
    const held = hold()
    fault = async ({ init, range }) => (range === `bytes=${MiB}-${2 * MiB - 1}` ? held.wait(init) : undefined)
    const limits = { rangeBytes: MiB, chunkBytes: 512 * KiB, rangesPerTransfer: 1 }
    const first = engine({ limits })
    const id = await first.engine.download(HOST, path.join(srv, 'report.csv'))
    await held.reached
    await first.engine.stop()
    restartDb()
    fault = null
    calls = []
    const second = engine({ limits })
    await settled(second.engine, id, 'done')
    expect(calls.map((call) => call.range)).toEqual([
      `bytes=${MiB}-${2 * MiB - 1}`,
      `bytes=${2 * MiB}-${2.5 * MiB - 1}`,
    ])
    expect(sha(readFileSync(path.join(downloads, 'report.csv')))).toBe(sha(bytes))
  })

  it('waits for a host that cannot be reached, then goes on', async () => {
    writeFileSync(path.join(srv, 'a.txt'), 'hello')
    let failures = 0
    fault = async () => {
      if (failures++ < 2) throw new TransientFailure('offline')
    }
    const { engine: queue } = engine({ backoffMs: () => 300 })
    const id = await queue.download(HOST, path.join(srv, 'a.txt'))
    await settled(queue, id, 'waiting')
    await settled(queue, id, 'done')
    expect(failures).toBe(3)
  })

  it('stops when the file changes on the host, and starts over when asked', async () => {
    writeFileSync(path.join(srv, 'live.csv'), csv(2.5 * MiB))
    // The second range waits until the file has changed on the host.
    let release: (() => void) | null = null
    fault = async ({ range, count }) => {
      if (range === `bytes=${MiB}-${2 * MiB - 1}` && count === 1)
        await new Promise<void>((resolve) => (release = resolve))
    }
    const { engine: queue } = engine({ limits: { rangeBytes: MiB, chunkBytes: 512 * KiB, rangesPerTransfer: 1 } })
    const id = await queue.download(HOST, path.join(srv, 'live.csv'))
    while (!release) await new Promise((resolve) => setTimeout(resolve, 5))
    const updated = csv(3 * MiB)
    writeFileSync(path.join(srv, 'live.csv'), updated)
    ;(release as () => void)()
    expect((await settled(queue, id, 'failed')).error).toBe('changed')
    await queue.retry(id)
    const done = await settled(queue, id, 'done')
    expect(done.size).toBe(updated.length)
    expect(sha(readFileSync(path.join(downloads, 'live.csv')))).toBe(sha(updated))
  })

  it('fetches a corrupted range again, and fails when it never arrives intact', async () => {
    const bytes = randomBytes(1.5 * MiB)
    writeFileSync(path.join(srv, 'r.bin'), bytes)
    const corrupt =
      (always: boolean) =>
      async ({ init, count }: Parameters<Fault>[0]) => {
        if (init.headers.range !== `bytes=0-${MiB - 1}` || (!always && count > 1)) return
        const response = await real.raw('hostFileContent', init)
        const body = Buffer.from(await response.arrayBuffer())
        body[10] ^= 0xff
        return new Response(body, { status: response.status, headers: response.headers })
      }
    fault = corrupt(false)
    const { engine: queue } = engine()
    const once = await queue.download(HOST, path.join(srv, 'r.bin'))
    await settled(queue, once, 'done')
    expect(sha(readFileSync(path.join(downloads, 'r.bin')))).toBe(sha(bytes))
    calls = []
    fault = corrupt(true)
    const never = await queue.download(HOST, path.join(srv, 'r.bin'))
    expect((await settled(queue, never, 'failed')).error).toBe('verification-failed')
  })

  it('refuses a taken name until the person chooses to replace it', async () => {
    writeFileSync(path.join(srv, 'taken.txt'), 'old')
    writeFileSync(path.join(local, 'taken.txt'), 'new contents')
    const { engine: queue } = engine()
    const { queued } = await queue.upload(HOST, [path.join(local, 'taken.txt')], srv)
    expect((await settled(queue, queued[0], 'failed')).error).toBe('exists')
    await queue.retry(queued[0], { overwrite: true })
    await settled(queue, queued[0], 'done')
    expect(readFileSync(path.join(srv, 'taken.txt'), 'utf8')).toBe('new contents')
  })

  it('opens a file from a folder of its own once it is verified', async () => {
    writeFileSync(path.join(srv, 'doc.pdf'), '%PDF-1.7')
    const { engine: queue, opened } = engine()
    const id = await queue.download(HOST, path.join(srv, 'doc.pdf'), 'open')
    await settled(queue, id, 'done')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(opened).toEqual([path.join(openDir, id, 'doc.pdf')])
  })

  it('reports progress and speed while a transfer runs', async () => {
    writeFileSync(path.join(srv, 'p.bin'), randomBytes(2.5 * MiB))
    // The last range starts late and arrives slowly, in pieces, as over a slow link.
    fault = async ({ key, init, range }) => {
      if (range !== `bytes=${2 * MiB}-${2.5 * MiB - 1}`) return
      await new Promise((resolve) => setTimeout(resolve, 600))
      const response = await real.raw(key as 'hostFileContent', init)
      const body = Buffer.from(await response.arrayBuffer())
      let sent = 0
      const slow = new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise((resolve) => setTimeout(resolve, 60))
          controller.enqueue(body.subarray(sent, sent + 64 * KiB))
          sent += 64 * KiB
          if (sent >= body.length) controller.close()
        },
      })
      return new Response(slow, { status: response.status, headers: response.headers })
    }
    const { engine: queue, emitted } = engine({
      limits: { rangeBytes: MiB, chunkBytes: 512 * KiB, rangesPerTransfer: 1 },
    })
    const id = await queue.download(HOST, path.join(srv, 'p.bin'))
    await settled(queue, id, 'done')
    const mine = emitted
      .map((snapshot) => snapshot.find((item) => item.id === id))
      .filter(Boolean) as HostTransferView[]
    const done = mine.map((item) => item.doneBytes)
    expect(done).toEqual([...done].sort((a, b) => a - b))
    expect(mine.some((item) => item.state === 'running' && item.bytesPerSecond !== null)).toBe(true)
  })
  it('downloads into an explicit directory', async () => {
    const bytes = csv(300 * KiB)
    writeFileSync(path.join(srv, 'move.pkg'), bytes)
    const { engine: queue } = engine()
    const staging = path.join(base, 'staging')
    const id = await queue.download(HOST, path.join(srv, 'move.pkg'), 'save', { directory: staging })
    const done = await queue.whenSettled(id)
    expect(done).toMatchObject({ state: 'done', localPath: path.join(staging, 'move.pkg'), sha256: sha(bytes) })
    expect(existsSync(downloads) ? readdirSync(downloads) : []).toEqual([])
  })

  it('settles a finished upload and download, reporting progress meanwhile', async () => {
    const bytes = randomBytes(1.3 * MiB)
    writeFileSync(path.join(local, 'up.bin'), bytes)
    const { engine: queue } = engine()
    const { queued } = await queue.upload(HOST, [path.join(local, 'up.bin')], srv)
    const progress: number[] = []
    const uploaded = await queue.whenSettled(queued[0], (view) => progress.push(view.doneBytes))
    expect(uploaded).toMatchObject({ state: 'done', remotePath: path.join(srv, 'up.bin'), sha256: sha(bytes) })
    expect(progress.every((done) => done <= bytes.length)).toBe(true)
    // Already settled: answered at once.
    expect((await queue.whenSettled(queued[0])).state).toBe('done')
    const id = await queue.download(HOST, path.join(srv, 'up.bin'))
    expect((await queue.whenSettled(id)).state).toBe('done')
    await expect(queue.whenSettled('no-such-transfer')).rejects.toThrow(/Unknown transfer/)
  })

  it('settles a canceled transfer and rejects waiters when stopped', async () => {
    writeFileSync(path.join(local, 'a.bin'), randomBytes(MiB))
    writeFileSync(path.join(local, 'b.bin'), randomBytes(MiB))
    let reached!: () => void
    const started = new Promise<void>((resolve) => {
      reached = resolve
    })
    // Every chunk hangs until its transfer is aborted, including one sent after the abort.
    fault = async ({ key, init }) => {
      if (key !== 'hostFileUploadChunk') return undefined
      reached()
      return new Promise<never>((_resolve, reject) => {
        if (init.signal?.aborted) return reject(init.signal.reason)
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    }
    const { engine: queue } = engine({ limits: { rangeBytes: MiB, chunkBytes: 512 * KiB, activeTransfers: 1 } })
    const { queued } = await queue.upload(HOST, [path.join(local, 'a.bin'), path.join(local, 'b.bin')], srv)
    await started
    const canceled = queue.whenSettled(queued[0])
    await queue.cancel(queued[0])
    expect((await canceled).state).toBe('canceled')
    const waiting = queue.whenSettled(queued[1])
    await queue.stop()
    await expect(waiting).rejects.toThrow(/stopped/)
  })
})
