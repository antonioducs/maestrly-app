import { once } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  fleetInternalRunnerJobRequestSchema,
  fleetRunnerJobIdSchema,
  type FleetInternalRunnerJobRequest,
  type FleetRunnerJob,
  type FleetRunnerLink,
  type FleetRunnerSubmitResult,
} from '@maestrly/bot-fleet-protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOT_RUNNER_READ_RULES, BYOK_DEFAULT_RULESET, ruleEffect } from '../../src/main/chat/permission'
import { APP_TOOL_POLICY } from '../../src/main/chat/tool-policy'
import { RunnerJobRecords, type RunnerJobRecord } from '../../src/main/fleet/instance/runner-jobs/records'
import { RUNNER_FOLDER_STATE, RUNNER_JOB_FILES } from '../../src/main/fleet/instance/runner-jobs/shared'
import { BOT_RUNNER_TOOL_NAMES } from '../../src/main/mcp/tools/bot-runners'
import { registerBotModeTools } from '../../src/main/mcp/tools/bot-instance'
import { runnerJob, runnerRecord } from '../helpers/runner-jobs'

type Lane = { kind: 'routine'; runId: string } | { kind: 'thread'; runId: string; threadId: string; title: string }
type FakeBot = {
  gatewayConfigured: boolean
  gatewayConfig: { url: string; token: string } | null
  peerNames: Map<string, string>
  runnersEnabled?: boolean
  primaryConversationId: string
  runs: { byConversation: (id: string | undefined) => Lane | undefined }
  runnerRecords: () => RunnerJobRecords
}
const conversationBot = vi.hoisted(() => ({ bot: null as FakeBot | null, cwd: '' }))
vi.mock('../../src/main/fleet/instance', () => ({
  requestOwnerHelp: vi.fn(async () => 'help-id'),
  botRuntimeForConversation: (conversationId: string | undefined) =>
    ['primary', 'run-conversation', 'thread-conversation', 'stray'].includes(conversationId ?? '')
      ? conversationBot.bot
      : null,
}))
vi.mock('../../src/main/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/store')>()),
  getConversation: (id: string) =>
    ['primary', 'run-conversation', 'thread-conversation', 'stray'].includes(id)
      ? { id, cwd: conversationBot.cwd }
      : undefined,
}))

const servers: Server[] = []
const clients: Client[] = []
const roots: string[] = []
afterEach(async () => {
  for (const mcp of clients.splice(0)) await mcp.close()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  conversationBot.bot = null
})

const studio: FleetRunnerLink = {
  runnerId: 'rnr_studiostudiostudio01',
  name: 'Studio',
  online: true,
  capabilities: {
    protocol: 1,
    os: 'macos',
    arch: 'arm64',
    cpus: 12,
    memoryBytes: 32 * 1024 ** 3,
    executor: 'native',
    gpu: { vendor: 'apple', name: 'Apple M2 Max', memoryBytes: null },
    slots: 2,
  },
  busySlots: 1,
  lastSeenAt: '2026-10-29T10:00:00.000Z',
  linkedAt: '2026-10-01T10:00:00.000Z',
}
const tower: FleetRunnerLink = {
  runnerId: 'rnr_towertowertowertow1',
  name: 'Tower',
  online: false,
  capabilities: null,
  busySlots: 0,
  lastSeenAt: null,
  linkedAt: '2026-10-02T10:00:00.000Z',
}

type GatewayOptions = {
  runners?: FleetRunnerLink[]
  jobs?: FleetRunnerJob[]
  /** Answers a create; the record of the job, as the environment had it when the request came, is passed along. */
  create?: (
    request: FleetInternalRunnerJobRequest,
    recordBefore: RunnerJobRecord | null
  ) => FleetRunnerSubmitResult | 'fail'
  cancel?: (jobId: string) => FleetRunnerJob | 'missing'
}

/** The gateway's internal API for one bot: its runners and jobs. */
async function fakeGateway(records: RunnerJobRecords, options: GatewayOptions = {}) {
  const created: Array<{ request: FleetInternalRunnerJobRequest; recordBefore: RunnerJobRecord | null }> = []
  const paths: string[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const url = request.url ?? ''
    paths.push(`${request.method} ${url}`)
    response.setHeader('content-type', 'application/json')
    const fail = (status: number, code: string, message: string) => {
      response.statusCode = status
      response.end(JSON.stringify({ code, message }))
    }
    if (request.method === 'GET' && url === '/internal/v1/runners')
      return response.end(JSON.stringify({ runners: options.runners ?? [] }))
    if (request.method === 'GET' && url === '/internal/v1/runner-jobs')
      return response.end(JSON.stringify({ jobs: options.jobs ?? [] }))
    if (request.method === 'POST' && url === '/internal/v1/runner-jobs') {
      const parsed = fleetInternalRunnerJobRequestSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString()))
      if (!parsed.success) return fail(400, 'INVALID_REQUEST', 'Invalid request')
      const recordBefore = await records.get(parsed.data.jobId)
      created.push({ request: parsed.data, recordBefore })
      const answer = options.create?.(parsed.data, recordBefore) ?? {
        ok: true,
        job: runnerJob(parsed.data.jobId, 'queued'),
        queuedAhead: 0,
      }
      if (answer === 'fail') return fail(503, 'INSTANCE_UNAVAILABLE', 'down')
      return response.end(JSON.stringify(answer))
    }
    const job = /^\/internal\/v1\/runner-jobs\/(job_[A-Za-z0-9_-]+)(\/cancel)?$/.exec(url)
    if (job && request.method === 'GET') {
      const found = (options.jobs ?? []).find((candidate) => candidate.jobId === job[1])
      return found ? response.end(JSON.stringify(found)) : fail(404, 'NOT_FOUND', 'Runner job not found')
    }
    if (job?.[2] && request.method === 'POST') {
      const answer = options.cancel?.(job[1]) ?? runnerJob(job[1], 'cancelled')
      return answer === 'missing'
        ? fail(404, 'NOT_FOUND', 'Runner job not found')
        : response.end(JSON.stringify(answer))
    }
    fail(404, 'NOT_FOUND', 'Route not found')
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, created, paths }
}

type World = { work: string; project: string; records: RunnerJobRecords }
function world(): World {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'runner-tools-')))
  roots.push(root)
  const work = path.join(root, 'work')
  const project = path.join(work, 'project')
  mkdirSync(project, { recursive: true })
  writeFileSync(path.join(project, 'input.txt'), 'input')
  conversationBot.cwd = work
  return { work, project, records: new RunnerJobRecords(path.join(root, 'bot', 'runner-jobs')) }
}

async function client(
  setup: World,
  gatewayUrl: string,
  options: { convId?: string; runnersEnabled?: boolean; gatewayConfigured?: boolean; lanes?: Record<string, Lane> } = {}
) {
  conversationBot.bot = {
    gatewayConfigured: options.gatewayConfigured ?? true,
    gatewayConfig: { url: gatewayUrl, token: 'secret' },
    peerNames: new Map(),
    runnersEnabled: options.runnersEnabled ?? true,
    primaryConversationId: 'primary',
    runs: { byConversation: (id) => (id ? options.lanes?.[id] : undefined) },
    runnerRecords: () => setup.records,
  }
  const server = new McpServer({ name: 'bot-tools', version: '1' })
  registerBotModeTools(
    { server, convId: options.convId ?? 'primary', locale: 'en', t: (() => '') as never },
    { MAESTRLY_BOT_MODE: '1' },
    () => false
  )
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const mcp = new Client({ name: 'test', version: '1' })
  await server.connect(serverTransport)
  await mcp.connect(clientTransport)
  clients.push(mcp)
  return mcp
}
const text = (result: unknown) => (result as { content: Array<{ text: string }> }).content[0].text
const json = (result: unknown) => JSON.parse(text(result)) as Record<string, any>
const isError = (result: unknown) => (result as { isError?: boolean }).isError === true
const submit = (mcp: Client, args: Record<string, unknown>, toolCallId?: string) =>
  mcp.callTool({
    name: 'runner_submit',
    arguments: { folder: 'project', command: 'make render', outputs: ['out/**'], ...args },
    ...(toolCallId ? { _meta: { toolCallId } } : {}),
  })

let setup: World
beforeEach(() => {
  setup = world()
})

// The bot environment runs in a Linux container: the folders of its jobs are POSIX paths.
describe.skipIf(process.platform === 'win32')('runner tools of a fleet bot', () => {
  it('are offered only when the gateway sends jobs, with reads marked as reads and changes asking', async () => {
    const gateway = await fakeGateway(setup.records)
    const without = await client(setup, gateway.url, { runnersEnabled: false })
    expect((await without.listTools()).tools.filter((tool) => tool.name.startsWith('runner_'))).toEqual([])

    const mcp = await client(setup, gateway.url)
    const tools = (await mcp.listTools()).tools.filter((tool) => tool.name.startsWith('runner_'))
    expect(tools.map((tool) => tool.name)).toEqual([...BOT_RUNNER_TOOL_NAMES])
    for (const tool of tools) {
      const policy = APP_TOOL_POLICY[tool.name as keyof typeof APP_TOOL_POLICY]
      expect(policy, tool.name).toBeDefined()
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(policy.readOnly)
      // Reads never prompt in a bot container; submitting and cancelling pass the bot's own ceiling.
      expect(ruleEffect('mcp', tool.name, BYOK_DEFAULT_RULESET, BOT_RUNNER_READ_RULES), tool.name).toBe(
        policy.readOnly ? 'allow' : 'ask'
      )
    }
    const submitTool = tools.find((tool) => tool.name === 'runner_submit')!
    expect(submitTool.description).toContain('end your turn')
    expect(submitTool.description).toContain('named `caches`')
    expect(submitTool.description).toContain('self-contained')
    expect(tools.find((tool) => tool.name === 'runner_status')!.description).toContain(
      'status shows what it uses on its runner, and runner_logs shows its output so far'
    )
    expect(submitTool.inputSchema.required).toEqual(expect.arrayContaining(['folder', 'command', 'outputs']))
  })

  it('is not offered without a gateway', async () => {
    const mcp = await client(setup, 'http://127.0.0.1:1', { gatewayConfigured: false })
    expect((await mcp.listTools()).tools.some((tool) => tool.name.startsWith('runner_'))).toBe(false)
  })

  it('lists the runners in a compact shape, with the jobs waiting', async () => {
    const gateway = await fakeGateway(setup.records, {
      runners: [studio, tower],
      jobs: [runnerJob('job_AAAAAAAAAAAAAAAA0001', 'queued'), runnerJob('job_AAAAAAAAAAAAAAAA0002', 'running')],
    })
    const mcp = await client(setup, gateway.url)
    expect(json(await mcp.callTool({ name: 'runner_list', arguments: {} }))).toEqual({
      runners: [
        {
          runnerId: studio.runnerId,
          name: 'Studio',
          online: true,
          lastSeenAt: studio.lastSeenAt,
          executor: 'native',
          os: 'macos',
          arch: 'arm64',
          cpus: 12,
          memoryGiB: 32,
          gpu: { name: 'Apple M2 Max', vendor: 'apple' },
          slots: 2,
          busySlots: 1,
          freeSlots: 1,
        },
        {
          runnerId: tower.runnerId,
          name: 'Tower',
          online: false,
          lastSeenAt: null,
          busySlots: 0,
          capabilities: expect.stringContaining('unknown'),
        },
      ],
      queuedJobs: 1,
    })
  })

  it('tells the bot how to get a runner when none is linked', async () => {
    const gateway = await fakeGateway(setup.records)
    const mcp = await client(setup, gateway.url)
    const listed = json(await mcp.callTool({ name: 'runner_list', arguments: {} }))
    expect(listed.runners).toEqual([])
    expect(listed.note).toContain('Run jobs for bots')
  })

  describe('runner_submit', () => {
    it('writes the job record before the gateway hears of it, resolves a relative folder and answers at once', async () => {
      const gateway = await fakeGateway(setup.records, {
        create: (request) => ({
          ok: true,
          job: runnerJob(request.jobId, 'queued', { runnerId: null, runnerName: null }),
          queuedAhead: 2,
        }),
      })
      const mcp = await client(setup, gateway.url)
      const result = await submit(
        mcp,
        {
          env: { MODE: 'fast' },
          caches: [{ name: 'node', path: 'node_modules' }],
          requires: { gpu: true },
          timeoutMinutes: 30,
        },
        'call-1'
      )
      expect(isError(result)).toBe(false)
      expect(gateway.created).toHaveLength(1)
      const { request, recordBefore } = gateway.created[0]
      expect(fleetRunnerJobIdSchema.safeParse(request.jobId).success).toBe(true)
      expect(request.spec).toMatchObject({
        folder: setup.project,
        command: 'make render',
        outputs: ['out/**'],
        env: { MODE: 'fast' },
        caches: [{ name: 'node', path: 'node_modules' }],
        timeoutMinutes: 30,
      })
      expect(request.requires).toEqual({ gpu: true })
      expect(request.runnerId).toBeUndefined()
      // The record was there, with no state yet, when the gateway was asked.
      expect(recordBefore).toMatchObject({
        jobId: request.jobId,
        conversationId: 'primary',
        conversation: { kind: 'primary' },
        folder: setup.project,
        job: null,
        outputs: null,
        continued: false,
      })
      expect(json(result)).toMatchObject({
        jobId: request.jobId,
        state: 'queued',
        queuedAhead: 2,
        runner: null,
        folder: setup.project,
      })
      expect(json(result).note).toContain('End your turn')
      expect((await setup.records.get(request.jobId))?.job?.state).toBe('queued')
    })

    it('derives the job id from the tool call, so a call that is retried never queues twice', async () => {
      const gateway = await fakeGateway(setup.records)
      const mcp = await client(setup, gateway.url)
      const first = json(await submit(mcp, {}, 'call-1'))
      const again = json(await submit(mcp, {}, 'call-1'))
      expect(gateway.created).toHaveLength(1)
      expect(again).toMatchObject({ jobId: first.jobId, state: 'queued', alreadySubmitted: true })
      expect(await setup.records.list()).toHaveLength(1)

      const other = json(await submit(mcp, {}, 'call-2'))
      expect(other.jobId).not.toBe(first.jobId)
      expect(gateway.created).toHaveLength(2)
      expect(await setup.records.list()).toHaveLength(2)

      // Without a tool call id there is nothing to derive it from.
      const a = json(await submit(mcp, {}))
      const b = json(await submit(mcp, {}))
      expect(a.jobId).not.toBe(b.jobId)
    })

    it('says that a job that already ended ended', async () => {
      const gateway = await fakeGateway(setup.records, {
        create: (request) => ({ ok: true, job: runnerJob(request.jobId, 'queued'), queuedAhead: 0 }),
      })
      const mcp = await client(setup, gateway.url)
      const first = json(await submit(mcp, {}, 'call-1'))
      await setup.records.update(first.jobId, (record) => ({
        ...record,
        job: runnerJob(first.jobId, 'succeeded', { exitCode: 0 }),
      }))
      const again = json(await submit(mcp, {}, 'call-1'))
      expect(again).toMatchObject({ state: 'succeeded', alreadySubmitted: true, note: 'This job already ended.' })
      expect(gateway.created).toHaveLength(1)
    })

    it('refuses a folder that is missing, is a file, or is the root, before anything is written or sent', async () => {
      const gateway = await fakeGateway(setup.records)
      const mcp = await client(setup, gateway.url)
      writeFileSync(path.join(setup.work, 'file.txt'), 'x')
      const missing = await submit(mcp, { folder: 'nope' })
      expect(isError(missing)).toBe(true)
      expect(text(missing)).toContain('does not exist')
      const file = await submit(mcp, { folder: 'file.txt' })
      expect(text(file)).toContain('is not a folder')
      const root = await submit(mcp, { folder: '/' })
      expect(text(root)).toContain('not the root')
      const absolute = await submit(mcp, { folder: setup.project })
      expect(isError(absolute)).toBe(false)
      expect(gateway.created).toHaveLength(1)
      expect(await setup.records.list()).toHaveLength(1)
    })

    it('refuses a job its schema refuses, before anything is written or sent', async () => {
      const gateway = await fakeGateway(setup.records)
      const mcp = await client(setup, gateway.url)
      for (const bad of [
        { outputs: [] },
        { outputs: ['../escape'] },
        { env: { 'not a name': 'x' } },
        { caches: [{ name: 'Bad Name', path: 'x' }] },
        { caches: [{ name: 'ok', path: '../up' }] },
        { timeoutMinutes: 0 },
        { command: '' },
      ])
        expect(isError(await submit(mcp, bad)), JSON.stringify(bad)).toBe(true)
      expect(gateway.created).toEqual([])
      expect(await setup.records.list()).toEqual([])
    })

    it('resolves a runner named by its name or id', async () => {
      const gateway = await fakeGateway(setup.records, { runners: [studio, tower] })
      const mcp = await client(setup, gateway.url)
      await submit(mcp, { runner: 'studio' }, 'call-1')
      await submit(mcp, { runner: tower.runnerId }, 'call-2')
      expect(gateway.created.map((item) => item.request.runnerId)).toEqual([studio.runnerId, tower.runnerId])

      const unknown = await submit(mcp, { runner: 'Laptop' }, 'call-3')
      expect(isError(unknown)).toBe(true)
      expect(text(unknown)).toContain('Studio')
      expect(text(unknown)).toContain('Tower')
      expect(gateway.created).toHaveLength(2)
      expect(await setup.records.list()).toHaveLength(2)
    })

    it('removes the record when the gateway refuses, and lists the runners for runner_unmatched', async () => {
      const gateway = await fakeGateway(setup.records, {
        runners: [studio],
        create: () => ({
          ok: false,
          error: { code: 'runner_unmatched', message: 'None of your runners can run this job: "Studio" is macOS.' },
        }),
      })
      const mcp = await client(setup, gateway.url)
      const refused = await submit(mcp, { requires: { os: 'linux' } }, 'call-1')
      expect(isError(refused)).toBe(true)
      expect(text(refused)).toContain('runner_unmatched: None of your runners can run this job')
      expect(text(refused)).toContain('Your runners: ')
      expect(text(refused)).toContain('"name":"Studio"')
      expect(text(refused)).toContain('"executor":"native"')
      // The gateway knows nothing of the job, so the environment keeps nothing either.
      expect(gateway.created[0].recordBefore).not.toBeNull()
      expect(await setup.records.list()).toEqual([])
    })

    it('does not list the runners for other refusals', async () => {
      const gateway = await fakeGateway(setup.records, {
        runners: [studio],
        create: () => ({ ok: false, error: { code: 'runner_busy', message: 'You already have 20 jobs.' } }),
      })
      const mcp = await client(setup, gateway.url)
      const refused = await submit(mcp, {}, 'call-1')
      expect(text(refused)).toBe('runner_busy: You already have 20 jobs.')
      expect(gateway.paths).not.toContain('GET /internal/v1/runners')
      expect(await setup.records.list()).toEqual([])
    })

    it('keeps the record when the gateway does not answer, and a retry of the same call reuses it', async () => {
      let attempt = 0
      const gateway = await fakeGateway(setup.records, {
        create: () => (++attempt === 1 ? 'fail' : (undefined as never)),
      })
      const mcp = await client(setup, gateway.url)
      const failed = await submit(mcp, {}, 'call-1')
      expect(isError(failed)).toBe(true)
      const records = await setup.records.list()
      expect(records).toHaveLength(1)
      expect(records[0].job).toBeNull()
      expect(text(failed)).toContain(records[0].jobId)
      expect(text(failed)).toContain('runner_status')

      // The bot asks: the gateway does not know the job.
      const status = json(await mcp.callTool({ name: 'runner_status', arguments: { jobId: records[0].jobId } }))
      expect(status).toMatchObject({ jobId: records[0].jobId, state: 'not_submitted' })

      const retried = await submit(mcp, {}, 'call-1')
      expect(isError(retried)).toBe(false)
      expect(gateway.created.map((item) => item.request.jobId)).toEqual([records[0].jobId, records[0].jobId])
      expect(json(retried).jobId).toBe(records[0].jobId)
      expect(await setup.records.list()).toHaveLength(1)
    })

    it('records the conversation a routine run or a thread submitted from', async () => {
      const gateway = await fakeGateway(setup.records)
      const lanes: Record<string, Lane> = {
        'run-conversation': { kind: 'routine', runId: 'run-1' },
        'thread-conversation': { kind: 'thread', runId: 'thread-1', threadId: 'thread-1', title: 'Plan the render' },
      }
      const fromRun = await client(setup, gateway.url, { convId: 'run-conversation', lanes })
      const run = json(await submit(fromRun, {}, 'call-1'))
      const fromThread = await client(setup, gateway.url, { convId: 'thread-conversation', lanes })
      const thread = json(await submit(fromThread, {}, 'call-1'))
      expect(run.jobId).not.toBe(thread.jobId)
      expect(await setup.records.get(run.jobId)).toMatchObject({
        conversationId: 'run-conversation',
        conversation: { kind: 'run', runId: 'run-1' },
      })
      expect(await setup.records.get(thread.jobId)).toMatchObject({
        conversationId: 'thread-conversation',
        conversation: { kind: 'thread', threadId: 'thread-1', title: 'Plan the render' },
      })
      // A conversation that is neither cannot hear of the result.
      const stray = await client(setup, gateway.url, { convId: 'stray', lanes })
      const refused = await submit(stray, {}, 'call-1')
      expect(isError(refused)).toBe(true)
      expect(text(refused)).toContain('your own conversations')
      expect(gateway.created).toHaveLength(2)
    })
  })

  describe('runner_status', () => {
    const seed = async (
      jobId: string,
      conversationId: string,
      job: FleetRunnerJob | null,
      extra: Partial<RunnerJobRecord> = {}
    ) =>
      setup.records.create(
        runnerRecord(setup.project, {
          jobId,
          conversationId,
          job,
          createdAt: `2026-10-29T10:0${jobId.slice(-1)}:00.000Z`,
          ...extra,
        })
      )

    it('merges the gateway state of one job with what the environment kept', async () => {
      const id = 'job_AAAAAAAAAAAAAAAA0001'
      await seed(id, 'primary', runnerJob(id, 'running'), {
        outputs: { files: [{ path: 'out/a.mp4', size: 12 }], bytes: 12, sha256: 'a'.repeat(64) },
      })
      const gateway = await fakeGateway(setup.records, {
        jobs: [runnerJob(id, 'finishing', { startedAt: '2026-10-29T10:01:00.000Z' })],
      })
      const mcp = await client(setup, gateway.url)
      expect(json(await mcp.callTool({ name: 'runner_status', arguments: { jobId: id } }))).toMatchObject({
        jobId: id,
        state: 'finishing',
        runner: { runnerId: 'rnr_AAAAAAAAAAAAAAAA0001', name: 'Studio' },
        folder: setup.project,
        command: 'true',
        outputGlobs: ['out/**'],
        outputFiles: [{ path: 'out/a.mp4', size: 12 }],
        outputFileCount: 1,
        submittedFrom: 'this conversation',
      })
    })

    it('shows what a running job uses on its runner, in words, and nothing for a job that ended', async () => {
      const [running, queued, ended] = [1, 2, 3].map((n) => `job_AAAAAAAAAAAAAAAA000${n}`)
      const usage = {
        cpuPercent: 349.6,
        memoryBytes: Math.round(2.14 * 1024 ** 3),
        peakMemoryBytes: Math.round(3.4 * 1024 ** 3),
        processes: 4,
        at: '2026-10-29T10:05:00.000Z',
      }
      await seed(running, 'primary', runnerJob(running, 'running'))
      await seed(queued, 'primary', runnerJob(queued, 'queued'))
      await seed(ended, 'primary', runnerJob(ended, 'succeeded', { exitCode: 0, usage }))
      const gateway = await fakeGateway(setup.records, {
        jobs: [runnerJob(running, 'running', { usage }), runnerJob(queued, 'queued'), runnerJob(ended, 'succeeded')],
      })
      const mcp = await client(setup, gateway.url)
      const expected = {
        cpu: '350% of one CPU',
        memory: '2.1 GiB (peak 3.4 GiB)',
        processes: 4,
        sampledAt: '2026-10-29T10:05:00.000Z',
      }
      expect(json(await mcp.callTool({ name: 'runner_status', arguments: { jobId: running } })).usage).toEqual(expected)
      const listed = json(await mcp.callTool({ name: 'runner_status', arguments: {} }))
      const byId = new Map(listed.jobs.map((job: { jobId: string }) => [job.jobId, job]))
      expect(byId.get(running)).toMatchObject({ state: 'running', usage: expected })
      // Nothing is made up for a job that has not been sampled, and nothing is left over from before it ended.
      expect(byId.get(queued)).not.toHaveProperty('usage')
      expect(byId.get(ended)).toMatchObject({ state: 'succeeded' })
      expect(byId.get(ended)).not.toHaveProperty('usage')
    })

    it('answers from the record when the gateway cannot, and fails for a job nobody knows', async () => {
      const id = 'job_AAAAAAAAAAAAAAAA0001'
      await seed(id, 'primary', runnerJob(id, 'running'))
      const gateway = await fakeGateway(setup.records, { jobs: [] })
      const mcp = await client(setup, gateway.url)
      const stale = json(await mcp.callTool({ name: 'runner_status', arguments: { jobId: id } }))
      expect(stale.state).toBe('running')
      expect(stale.gatewayError).toContain('Runner job not found')
      const unknown = await mcp.callTool({ name: 'runner_status', arguments: { jobId: 'job_AAAAAAAAAAAAAAAA0009' } })
      expect(isError(unknown)).toBe(true)
      expect(text(unknown)).toContain('runner_status')
    })

    it('lists the jobs of this conversation only, newest first, refreshing the ones that have not ended', async () => {
      const [a, b, c, d] = [1, 2, 3, 4].map((n) => `job_AAAAAAAAAAAAAAAA000${n}`)
      await seed(a, 'primary', runnerJob(a, 'queued'))
      await seed(b, 'primary', runnerJob(b, 'succeeded', { exitCode: 0 }))
      await seed(c, 'run-conversation', runnerJob(c, 'running'))
      await seed(d, 'primary', null)
      const gateway = await fakeGateway(setup.records, {
        // The gateway's word counts for a job that has not ended, never for one that has.
        jobs: [runnerJob(a, 'running'), runnerJob(b, 'failed'), runnerJob(c, 'failed')],
      })
      const mcp = await client(setup, gateway.url)
      const listed = json(await mcp.callTool({ name: 'runner_status', arguments: {} }))
      expect(listed.jobs.map((job: { jobId: string; state: string }) => [job.jobId, job.state])).toEqual([
        [d, 'not_submitted'],
        [b, 'succeeded'],
        [a, 'running'],
      ])
    })

    it('says so when this conversation submitted nothing, and when the gateway did not answer', async () => {
      const gateway = await fakeGateway(setup.records)
      const mcp = await client(setup, gateway.url)
      expect(json(await mcp.callTool({ name: 'runner_status', arguments: {} }))).toEqual({
        jobs: [],
        note: 'No job was submitted from this conversation.',
      })
      const id = 'job_AAAAAAAAAAAAAAAA0001'
      await seed(id, 'primary', runnerJob(id, 'running'))
      const offline = await client(setup, 'http://127.0.0.1:1')
      const listed = json(await offline.callTool({ name: 'runner_status', arguments: {} }))
      expect(listed.jobs[0].state).toBe('running')
      expect(listed.note).toContain('did not answer')
    })
  })

  describe('runner_logs', () => {
    const id = 'job_AAAAAAAAAAAAAAAA0001'
    const lines = (count: number, prefix = 'line') =>
      Array.from({ length: count }, (_, n) => `${prefix} ${n + 1}`).join('\n') + '\n'

    it("reads the end of the environment's copy of the log", async () => {
      await setup.records.create(runnerRecord(setup.project, { jobId: id, job: runnerJob(id, 'running') }))
      writeFileSync(path.join(setup.records.dir(id), RUNNER_JOB_FILES.log), lines(300))
      const gateway = await fakeGateway(setup.records)
      const mcp = await client(setup, gateway.url)
      const few = text(await mcp.callTool({ name: 'runner_logs', arguments: { jobId: id, lines: 3 } }))
      expect(few).toContain('(running)')
      expect(few.endsWith('line 298\nline 299\nline 300')).toBe(true)
      expect(few).not.toContain('line 297')
      const normal = text(await mcp.callTool({ name: 'runner_logs', arguments: { jobId: id } }))
      expect(normal).toContain('line 201\n')
      expect(normal).not.toContain('line 200\n')
      expect(isError(await mcp.callTool({ name: 'runner_logs', arguments: { jobId: id, lines: 1001 } }))).toBe(true)
    })

    it("prefers the runner's own copy once the job ended and it holds more", async () => {
      await setup.records.create(runnerRecord(setup.project, { jobId: id, job: runnerJob(id, 'failed') }))
      writeFileSync(path.join(setup.records.dir(id), RUNNER_JOB_FILES.log), lines(5, 'ours'))
      mkdirSync(path.join(setup.project, RUNNER_FOLDER_STATE), { recursive: true })
      writeFileSync(path.join(setup.project, RUNNER_FOLDER_STATE, `${id}.log`), lines(8, 'theirs'))
      const gateway = await fakeGateway(setup.records)
      const mcp = await client(setup, gateway.url)
      const log = text(await mcp.callTool({ name: 'runner_logs', arguments: { jobId: id, lines: 2 } }))
      expect(log.endsWith('theirs 7\ntheirs 8')).toBe(true)
    })

    it('says when there is no log yet, and refuses a job that is not in the records', async () => {
      await setup.records.create(runnerRecord(setup.project, { jobId: id, job: null }))
      const gateway = await fakeGateway(setup.records)
      const mcp = await client(setup, gateway.url)
      expect(text(await mcp.callTool({ name: 'runner_logs', arguments: { jobId: id } }))).toContain('has no log yet')
      const unknown = await mcp.callTool({ name: 'runner_logs', arguments: { jobId: 'job_AAAAAAAAAAAAAAAA0009' } })
      expect(isError(unknown)).toBe(true)
    })
  })

  describe('runner_cancel', () => {
    const id = 'job_AAAAAAAAAAAAAAAA0001'

    it('cancels through the gateway and reports the job', async () => {
      const gateway = await fakeGateway(setup.records, {
        cancel: (jobId) => runnerJob(jobId, 'running', { cancelRequested: true }),
      })
      const mcp = await client(setup, gateway.url)
      const running = json(await mcp.callTool({ name: 'runner_cancel', arguments: { jobId: id } }))
      expect(running).toMatchObject({ jobId: id, state: 'running', cancelRequested: true })
      expect(running.note).toContain('Cancellation requested')
      expect(gateway.paths).toContain(`POST /internal/v1/runner-jobs/${id}/cancel`)

      const queued = await fakeGateway(setup.records)
      const ended = json(
        await (await client(setup, queued.url)).callTool({ name: 'runner_cancel', arguments: { jobId: id } })
      )
      expect(ended).toMatchObject({ state: 'cancelled', note: 'The job ended.' })
    })

    it('explains a job the gateway does not know', async () => {
      const gateway = await fakeGateway(setup.records, { cancel: () => 'missing' })
      const mcp = await client(setup, gateway.url)
      const missing = await mcp.callTool({ name: 'runner_cancel', arguments: { jobId: id } })
      expect(isError(missing)).toBe(true)
      expect(text(missing)).toContain('Runner job not found')
      expect(text(missing)).toContain('runner_status')
    })
  })
})
