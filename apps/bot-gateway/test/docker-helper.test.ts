import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DockerEngineDriver, DockerStreamDemuxer, FakeDockerDriver, type HelperSpec } from '../src/docker.js'
import { GatewayError } from '../src/errors.js'
import { dockerSocketPath } from './docker-socket.js'

const dirs: string[] = []
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const frame = (stream: 1 | 2, text: string) => {
  const data = Buffer.from(text)
  const header = Buffer.alloc(8)
  header[0] = stream
  header.writeUInt32BE(data.length, 4)
  return Buffer.concat([header, data])
}

type Call = { method: string; url: string; type: string | undefined; body: Buffer }
type Behavior = {
  createStatus?: number
  startStatus?: number
  /** The log output in the chunks the engine writes; null keeps the answer open until the container is killed. */
  logs?: Buffer[] | null
  exitCode?: number
}

async function engine(behavior: Behavior) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-helper-'))
  dirs.push(dir)
  const socket = dockerSocketPath(dir)
  const calls: Call[] = []
  const open = new Set<http.ServerResponse>()
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const url = String(req.url)
    calls.push({ method: String(req.method), url, type: req.headers['content-type'], body: Buffer.concat(chunks) })
    if (url === '/version') return res.end(JSON.stringify({ ApiVersion: '1.45', Version: '28.0' }))
    if (url.endsWith('/containers/create')) {
      res.writeHead(behavior.createStatus ?? 201)
      return res.end(JSON.stringify(behavior.createStatus ? { message: 'No such image' } : { Id: 'helper1' }))
    }
    if (url.includes('/archive')) return res.end()
    if (url.endsWith('/start')) {
      res.writeHead(behavior.startStatus ?? 204)
      return res.end(behavior.startStatus ? JSON.stringify({ message: 'Synthetic start failure' }) : undefined)
    }
    if (url.includes('/logs')) {
      res.writeHead(200, { 'content-type': 'application/vnd.docker.multiplexed-stream' })
      if (behavior.logs === null) {
        open.add(res)
        return
      }
      for (const chunk of behavior.logs ?? []) {
        res.write(chunk)
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      return res.end()
    }
    if (url.endsWith('/kill')) {
      for (const pending of open) pending.end()
      open.clear()
      res.writeHead(204)
      return res.end()
    }
    if (url.includes('/wait')) return res.end(JSON.stringify({ StatusCode: behavior.exitCode ?? 0 }))
    res.writeHead(204)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const pending of open) pending.destroy()
        server.close(() => resolve())
      })
  )
  return { docker: new DockerEngineDriver(socket), calls }
}

function spec(overrides: Partial<HelperSpec> = {}): HelperSpec {
  return {
    image: 'maestrly/bot-instance:local',
    command: ['restic', 'backup', '--json'],
    user: '1000',
    env: ['RESTIC_REPOSITORY=s3:https://example.invalid/bucket'],
    network: 'maestrly-bots',
    mounts: [
      { type: 'volume', source: 'maestrly-env-work-home', target: '/home/bot', readOnly: true },
      { type: 'volume', source: 'maestrly-bots-backup-cache', target: '/cache', readOnly: false },
    ],
    files: [{ path: 'tmp/maestrly-backup/gateway.json', content: '{}', mode: 0o600 }],
    securityOpt: ['no-new-privileges:true'],
    capAdd: [],
    labels: { 'org.maestrly.fleet.helper': 'backup' },
    timeoutMs: 10_000,
    ...overrides,
  }
}
const order = (calls: Call[]) =>
  calls
    .filter((call) => call.url !== '/version')
    .map((call) => call.method + ' ' + call.url.replace('/v1.45', '').replace(/\?.*$/, ''))

describe('helper containers', () => {
  it('creates, writes files, starts, streams the output and removes the container', async () => {
    const output = Buffer.concat([
      frame(1, '{"message_type":"status"}\n{"message_'),
      frame(2, 'warning: synthetic\n'),
      frame(1, 'type":"summary"}\nlast line'),
    ])
    // Cut inside the first header and inside a frame.
    const { docker, calls } = await engine({
      logs: [output.subarray(0, 3), output.subarray(3, 30), output.subarray(30)],
    })
    const lines: string[] = []
    const result = await docker.runHelper(spec({ onStdoutLine: (line) => lines.push(line) }))
    expect(result).toEqual({
      exitCode: 0,
      stdout: '{"message_type":"status"}\n{"message_type":"summary"}\nlast line',
      stderr: 'warning: synthetic\n',
      ending: 'exited',
    })
    expect(lines).toEqual(['{"message_type":"status"}', '{"message_type":"summary"}', 'last line'])
    expect(order(calls)).toEqual([
      'POST /containers/create',
      'PUT /containers/helper1/archive',
      'POST /containers/helper1/start',
      'GET /containers/helper1/logs',
      'POST /containers/helper1/wait',
      'DELETE /containers/helper1',
    ])
    const create = JSON.parse(calls.find((call) => call.url.endsWith('/containers/create'))!.body.toString())
    expect(create).toMatchObject({
      Image: 'maestrly/bot-instance:local',
      User: '1000',
      Entrypoint: ['restic'],
      Cmd: ['backup', '--json'],
      Env: ['RESTIC_REPOSITORY=s3:https://example.invalid/bucket'],
      Labels: { 'org.maestrly.fleet.helper': 'backup' },
      HostConfig: {
        NetworkMode: 'maestrly-bots',
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Mounts: [
          { Type: 'volume', Source: 'maestrly-env-work-home', Target: '/home/bot', ReadOnly: true },
          { Type: 'volume', Source: 'maestrly-bots-backup-cache', Target: '/cache', ReadOnly: false },
        ],
      },
    })
    expect(create.HostConfig.CapAdd).toBeUndefined()
    const archive = calls.find((call) => call.url.includes('/archive'))!
    expect(archive.url).toBe('/v1.45/containers/helper1/archive?path=%2F')
    expect(archive.type).toBe('application/x-tar')
    expect(archive.body.length % 512).toBe(0)
    expect(calls.find((call) => call.url.includes('/logs'))!.url).toContain('logs?follow=1&stdout=1&stderr=1')
    expect(calls.at(-1)!.url).toBe('/v1.45/containers/helper1?force=true')
  })

  it('skips the archive without files and returns the exit code', async () => {
    const { docker, calls } = await engine({ logs: [], exitCode: 12 })
    const result = await docker.runHelper(spec({ files: [], network: 'none' }))
    expect(result.exitCode).toBe(12)
    expect(order(calls)).not.toContain('PUT /containers/helper1/archive')
    expect(JSON.parse(calls.find((call) => call.url.endsWith('/containers/create'))!.body.toString())).toMatchObject({
      NetworkDisabled: true,
      HostConfig: { NetworkMode: 'none' },
    })
  })

  it('removes the container when it cannot start', async () => {
    const { docker, calls } = await engine({ startStatus: 500 })
    await expect(docker.runHelper(spec())).rejects.toMatchObject({ status: 500 })
    expect(order(calls).at(-1)).toBe('DELETE /containers/helper1')
  })

  it('kills and removes a helper that runs too long', async () => {
    const { docker, calls } = await engine({ logs: null, exitCode: 137 })
    const result = await docker.runHelper(spec({ timeoutMs: 100 }))
    expect(result).toMatchObject({ ending: 'timeout', exitCode: 137 })
    expect(order(calls)).toContain('POST /containers/helper1/kill')
    expect(order(calls).at(-1)).toBe('DELETE /containers/helper1')
  })

  it('kills and removes a cancelled helper', async () => {
    const { docker, calls } = await engine({ logs: null, exitCode: 137 })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    const result = await docker.runHelper(spec({ signal: controller.signal }))
    expect(result).toMatchObject({ ending: 'cancelled', exitCode: 137 })
    expect(order(calls)).toContain('POST /containers/helper1/kill')
    expect(order(calls).at(-1)).toBe('DELETE /containers/helper1')
  })

  it('reports a missing image', async () => {
    const { docker, calls } = await engine({ createStatus: 404 })
    const error = await docker.runHelper(spec()).catch((caught) => caught)
    expect(error).toBeInstanceOf(GatewayError)
    expect(error.code).toBe('IMAGE_MISSING')
    expect(order(calls)).toEqual(['POST /containers/create'])
  })

  it('splits streams when a header is cut between chunks', () => {
    const demuxer = new DockerStreamDemuxer()
    const raw = Buffer.concat([frame(1, 'out'), frame(2, 'err'), frame(1, 'more')])
    const parts = [
      ...demuxer.push(raw.subarray(0, 5)),
      ...demuxer.push(raw.subarray(5, 13)),
      ...demuxer.push(raw.subarray(13)),
    ]
    const joined = (stream: string) =>
      Buffer.concat(parts.filter((part) => part.stream === stream).map((part) => part.data)).toString()
    expect(joined('stdout')).toBe('outmore')
    expect(joined('stderr')).toBe('err')
  })
})

describe('fake helper containers', () => {
  it('records helpers, streams their lines and holds their volumes', async () => {
    const docker = new FakeDockerDriver()
    docker.setImage('maestrly/bot-instance:local', 'sha256:image')
    await docker.volumeCreate('maestrly-env-work-home')
    let release!: () => void
    docker.helperHandler = () =>
      new Promise((resolve) => {
        release = () => resolve({ exitCode: 3, stdout: 'one\ntwo\n', stderr: 'warn' })
      })
    const lines: string[] = []
    const running = docker.runHelper(spec({ onStdoutLine: (line) => lines.push(line) }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(docker.volumeRemove('maestrly-env-work-home')).rejects.toMatchObject({ status: 409 })
    release()
    expect(await running).toEqual({ exitCode: 3, stdout: 'one\ntwo\n', stderr: 'warn', ending: 'exited' })
    expect(lines).toEqual(['one', 'two'])
    expect(docker.helperRuns).toHaveLength(1)
    await docker.volumeRemove('maestrly-env-work-home')
    expect(await docker.volumeExists('maestrly-env-work-home')).toBe(false)
  })

  it('ends a cancelled helper', async () => {
    const docker = new FakeDockerDriver()
    docker.setImage('maestrly/bot-instance:local', 'sha256:image')
    docker.helperHandler = () => new Promise(() => undefined)
    const controller = new AbortController()
    const running = docker.runHelper(spec({ signal: controller.signal }))
    controller.abort()
    expect(await running).toMatchObject({ ending: 'cancelled', exitCode: 137 })
  })
})
