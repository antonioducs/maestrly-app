import { createHash } from 'node:crypto'
import { FLEET_RUNNER_HEADERS } from '@maestrly/bot-fleet-protocol'
import { describe, expect, it } from 'vitest'
import { httpRunnerJobApi, RunnerApiError } from '../../src/main/runner/api'
import { JOB_ID, readZstdTar, zstdTar } from '../helpers/runner-core'

type Recorded = { url: string; method: string; headers: Record<string, string>; body: unknown }

function setup(answer: (request: Recorded) => Response | Promise<Response>) {
  const requests: Recorded[] = []
  const api = httpRunnerJobApi({
    origin: 'https://gateway.test',
    headers: () => ({ Authorization: 'Bearer device-token' }),
    fetch: (async (url: string, init: RequestInit) => {
      const request: Recorded = {
        url,
        method: init.method ?? 'GET',
        headers: init.headers as Record<string, string>,
        body: init.body,
      }
      requests.push(request)
      return answer(request)
    }) as typeof fetch,
  })
  return { api, requests }
}
const json = (value: unknown, status = 200) => Response.json(value, { status })
const failure = (status: number, code: string, message: string) => json({ code, message }, status)
const capabilities = {
  protocol: 1,
  os: 'linux' as const,
  arch: 'x64' as const,
  cpus: 4,
  memoryBytes: 1024,
  executor: 'native' as const,
  gpu: null,
  slots: 1,
}

describe('runner job api', () => {
  it('reports the state with the device token and the protocol version', async () => {
    const { api, requests } = setup(() => json({ stop: [JOB_ID] }))
    expect(await api.report({ accepting: true, capabilities, jobs: ['job_AAAAAAAAAAAAAAAA0001'] })).toEqual({
      stop: [JOB_ID],
    })
    expect(requests[0]).toMatchObject({ url: 'https://gateway.test/v1/runner/state', method: 'PUT' })
    expect(requests[0]?.headers).toMatchObject({
      Authorization: 'Bearer device-token',
      'X-Maestrly-Fleet-Protocol': '1',
    })
    expect(JSON.parse(requests[0]?.body as string)).toMatchObject({
      accepting: true,
      jobs: ['job_AAAAAAAAAAAAAAAA0001'],
    })
  })

  it('accepts, moves on to finishing, and finishes a job', async () => {
    const { api, requests } = setup(() => new Response(null, { status: 204 }))
    await api.accept(JOB_ID)
    await api.progress(JOB_ID)
    await api.finish(JOB_ID, { exitCode: 2, error: { code: 'timeout', message: 'slow' } })
    expect(requests.map((request) => [request.method, request.url.replace('https://gateway.test', '')])).toEqual([
      ['POST', `/v1/runner-jobs/${JOB_ID}/accept`],
      ['POST', `/v1/runner-jobs/${JOB_ID}/progress`],
      ['POST', `/v1/runner-jobs/${JOB_ID}/finish`],
    ])
    expect(JSON.parse(requests[1]?.body as string)).toEqual({ state: 'finishing' })
    expect(JSON.parse(requests[2]?.body as string)).toEqual({
      exitCode: 2,
      error: { code: 'timeout', message: 'slow' },
    })
  })

  it('parses the manifest and refuses one that is not valid', async () => {
    const manifest = { jobId: JOB_ID, entries: [{ kind: 'directory', path: 'out', mode: 0o755 }], bytes: 0, skipped: 0 }
    expect(await setup(() => json(manifest)).api.manifest(JOB_ID)).toEqual(manifest)
    const bad = { ...manifest, entries: [{ kind: 'file', path: '../x', mode: 1, size: 1, sha256: 'a'.repeat(64) }] }
    await expect(setup(() => json(bad)).api.manifest(JOB_ID)).rejects.toMatchObject({ transient: false })
  })

  it('asks for blobs by digest and hands back the raw stream', async () => {
    const archive = await zstdTar([{ name: 'a'.repeat(64), content: 'blob' }])
    const { api, requests } = setup(() => new Response(new Uint8Array(archive)))
    const stream = await api.blobs(JOB_ID, ['a'.repeat(64)])
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk as Buffer)
    expect((await readZstdTar(Buffer.concat(chunks)))[0]?.content.toString()).toBe('blob')
    expect(requests[0]).toMatchObject({ method: 'POST', url: `https://gateway.test/v1/runner-jobs/${JOB_ID}/blobs` })
    expect(JSON.parse(requests[0]?.body as string)).toEqual({ digests: ['a'.repeat(64)] })
  })

  it('sends log bytes at their offset', async () => {
    const { api, requests } = setup(() => new Response(null, { status: 204 }))
    await api.log(JOB_ID, 1234, Buffer.from('hello'))
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: `https://gateway.test/v1/runner-jobs/${JOB_ID}/log?offset=1234`,
    })
    expect(Buffer.from(requests[0]?.body as Uint8Array).toString()).toBe('hello')
  })

  it('reads the upload status, puts chunks at offsets with their digest, and commits', async () => {
    const { api, requests } = setup((request) =>
      request.url.endsWith('/outputs') ? json({ received: 16 }) : new Response(null, { status: 204 })
    )
    expect(await api.outputsStatus(JOB_ID)).toEqual({ received: 16 })
    const bytes = Buffer.from('chunk')
    const sha = createHash('sha256').update(bytes).digest('hex')
    await api.outputChunk(JOB_ID, 16, bytes, sha)
    await api.outputCommit(JOB_ID, { bytes: 21, sha256: 'b'.repeat(64) })
    expect(requests[1]).toMatchObject({
      method: 'PUT',
      url: `https://gateway.test/v1/runner-jobs/${JOB_ID}/outputs/16`,
    })
    expect(requests[1]?.headers[FLEET_RUNNER_HEADERS.sha256]).toBe(sha)
    expect(requests[2]).toMatchObject({
      method: 'POST',
      url: `https://gateway.test/v1/runner-jobs/${JOB_ID}/outputs/commit`,
    })
    expect(JSON.parse(requests[2]?.body as string)).toEqual({ bytes: 21, sha256: 'b'.repeat(64) })
  })

  describe('errors', () => {
    const call = (response: () => Response | Promise<Response>) => setup(response).api.accept(JOB_ID)

    it('carry the status, the code and the message of the gateway', async () => {
      const error = await call(() => failure(403, 'FORBIDDEN', 'Not your job')).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(RunnerApiError)
      expect(error).toMatchObject({ status: 403, code: 'FORBIDDEN', message: 'Not your job', transient: false })
    })
    it('are transient for 5xx, 429 and an environment that is not there', async () => {
      await expect(call(() => failure(503, 'INSTANCE_UNAVAILABLE', 'down'))).rejects.toMatchObject({ transient: true })
      await expect(call(() => failure(500, 'INTERNAL', 'oops'))).rejects.toMatchObject({ transient: true })
      await expect(call(() => failure(429, 'RATE_LIMITED', 'slow down'))).rejects.toMatchObject({ transient: true })
      await expect(call(() => new Response('<html>', { status: 502 }))).rejects.toMatchObject({
        status: 502,
        code: 'INTERNAL',
        transient: true,
      })
    })
    it('are not transient for a conflict or a missing job', async () => {
      await expect(call(() => failure(409, 'CONFLICT', 'offset'))).rejects.toMatchObject({
        status: 409,
        transient: false,
      })
      await expect(call(() => failure(404, 'NOT_FOUND', 'gone'))).rejects.toMatchObject({
        status: 404,
        transient: false,
      })
    })
    it('are transient when the network fails', async () => {
      await expect(
        call(() => {
          throw new TypeError('fetch failed')
        })
      ).rejects.toMatchObject({ status: 0, code: 'NETWORK', transient: true })
    })
    it("are the signal's own when the caller aborted", async () => {
      const controller = new AbortController()
      const reason = new Error('cancelled')
      const { api } = setup(() => {
        controller.abort(reason)
        throw new Error('aborted')
      })
      await expect(api.manifest(JOB_ID, controller.signal)).rejects.toBe(reason)
    })
  })
})
