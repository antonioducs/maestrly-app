import { createHash } from 'node:crypto'
import path from 'node:path'
import {
  FLEET_RUNNER_DEFAULT_EXCLUDES,
  FLEET_RUNNER_JOB_FINAL_STATES,
  FLEET_RUNNER_LIMITS,
  type FleetRunnerJob,
  type FleetRunnerLink,
  type FleetRunnerSubmitResult,
  fleetRunnerCacheSchema,
  fleetRunnerExecutorSchema,
  fleetRunnerJobIdSchema,
  fleetRunnerJobSpecSchema,
  fleetRunnerOsSchema,
} from '@maestrly/bot-fleet-protocol'
import { z } from 'zod'
import { gatewayRequest, keyForToolCall, type GatewayConfig } from '../../fleet/instance/gateway-client'
import { runnerLogFile } from '../../fleet/instance/runner-jobs/completion'
import { tailRunnerLog } from '../../fleet/instance/runner-jobs/log'
import type { RunnerJobConversation, RunnerJobRecord, RunnerJobRecords } from '../../fleet/instance/runner-jobs/records'
import type { BotRunConversations } from '../../fleet/instance/routine-runs'
import { realFs } from '../../real-fs'
import { getConversation } from '../../store'
import type { McpToolContext } from './context'
import { err, ok } from './context'

/**
 * The tools a fleet bot uses to send heavy jobs to the computers that run jobs for it.
 *
 * A job is a shell command, a folder of the bot's environment and the outputs to bring back. The environment writes the
 * job's record before the gateway hears of it, under an id derived from the tool call, so a call that is retried never
 * queues a second job. The result comes back to the conversation that submitted the job as a new message
 * (`BotRuntime.continueRunnerJob`); the bot does not wait for it.
 */
export const BOT_RUNNER_TOOL_NAMES = [
  'runner_list',
  'runner_submit',
  'runner_status',
  'runner_logs',
  'runner_cancel',
] as const

/** What these tools need of the bot of the conversation; the bot's runtime is that. */
export interface BotRunnerHost {
  readonly primaryConversationId: string | null
  readonly runs: Pick<BotRunConversations, 'byConversation'>
  runnerRecords(): RunnerJobRecords
}

type Gateway = () => GatewayConfig

const fs = realFs.promises
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
const NONE_LINKED =
  'No computer runs jobs for you yet. Your owner turns it on in Maestrly: on the computer that should run your jobs, ' +
  'Settings → Runner → Run jobs for bots, and then, in your Settings → Runners, Let this bot run jobs on this computer.'
/** The jobs of this conversation `runner_status` lists, newest first. */
const JOBS_LISTED_MAX = 20
/** Output files a job's description names; the rest are counted. */
const OUTPUT_FILES_LISTED_MAX = 50
const LOG_LINES_DEFAULT = 100
/** The most of a log `runner_logs` reads: 1,000 lines of ordinary width. */
const LOG_BYTES_MAX = 128 * 1024

const jobId = fleetRunnerJobIdSchema.describe('Job id from runner_submit or runner_status.')
const pathText = z.string().min(1).max(FLEET_RUNNER_LIMITS.pathMax)

const requires = z
  .object({
    gpu: z.boolean().optional().describe('true: only a runner with a GPU.'),
    executor: fleetRunnerExecutorSchema
      .optional()
      .describe(
        "container: in a Docker container (the default image is your own environment image). native: as the runner computer's user, with its installed tools and GPU APIs (macOS and Linux)."
      ),
    os: fleetRunnerOsSchema.optional(),
  })
  .describe('What the runner must have. Leave out what does not matter; runner_list shows what each runner has.')
const caches = z
  .array(fleetRunnerCacheSchema)
  .max(FLEET_RUNNER_LIMITS.listMax)
  .describe(
    'Named caches the runner keeps for you between jobs, at paths inside the folder: dependencies (node_modules, a ' +
      'virtualenv, a package cache) and model weights. They never travel, so the first job fills them and the next ones ' +
      'start with them. name: lowercase letters, digits, dots, dashes; path: relative to the folder.'
  )
const env = z
  .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), z.string())
  .describe('Environment variables of the command. Do not put secrets here that the command does not need.')

const SUBMIT_DESCRIPTION =
  'Send a heavy job to another computer that runs jobs for you, instead of running it in this environment, whose CPU and ' +
  'memory you share with your browser, your other conversations and the other bots. Use it for work expected to take ' +
  'minutes of CPU or a lot of memory: video renders, model inference, large builds and test suites, batch processing. ' +
  'Call runner_list first to see which runners you have and what each one offers. The job runs `command` with /bin/sh ' +
  'in a copy of `folder` on the runner; when it ends, the files matching `outputs`, and the log, are written back into ' +
  'the same folder here. Keep the command self-contained: install what it needs inside it, and use paths relative to the ' +
  "folder, because the runner is another computer where this environment's absolute paths do not exist. Declare every " +
  'file you want back in `outputs` (globs relative to the folder): nothing else returns, and files the job did not ' +
  'change are not sent back. Put dependencies and model weights in named `caches`, so the next job starts with them. ' +
  'The upload skips ' +
  FLEET_RUNNER_DEFAULT_EXCLUDES.join(', ') +
  ' unless you set `exclude`. The call returns at once with a job id, and the job waits in a queue until a matching ' +
  'runner has a free slot. Then end your turn: the result (state, exit code, output files, end of the log) arrives in ' +
  'this conversation as a new message when the job ends, so do not wait or poll. It follows your approval ceiling: ' +
  'your owner may have to approve it.'

/** A runner in the compact shape the bot reads. */
function runnerView(link: FleetRunnerLink) {
  const capabilities = link.capabilities
  const base = { runnerId: link.runnerId, name: link.name, online: link.online, lastSeenAt: link.lastSeenAt }
  if (!capabilities)
    return { ...base, busySlots: link.busySlots, capabilities: 'unknown: this runner has not reported what it has yet' }
  const gib = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10
  return {
    ...base,
    executor: capabilities.executor,
    os: capabilities.os,
    arch: capabilities.arch,
    cpus: capabilities.cpus,
    memoryGiB: gib(capabilities.memoryBytes),
    gpu: capabilities.gpu
      ? {
          name: capabilities.gpu.name,
          vendor: capabilities.gpu.vendor,
          ...(capabilities.gpu.memoryBytes ? { memoryGiB: gib(capabilities.gpu.memoryBytes) } : {}),
        }
      : null,
    slots: capabilities.slots,
    busySlots: link.busySlots,
    freeSlots: Math.max(0, capabilities.slots - link.busySlots),
  }
}

const isFinal = (job: FleetRunnerJob | null): boolean => !!job && FLEET_RUNNER_JOB_FINAL_STATES.includes(job.state)

/** A job as the bot reads it: what the gateway reports, merged with what this environment kept. */
function jobView(
  record: RunnerJobRecord | null,
  job: FleetRunnerJob | null,
  extra: { state?: string; conversation?: string } = {}
) {
  const files = record?.outputs?.files ?? []
  return {
    jobId: job?.jobId ?? record?.jobId,
    state: job?.state ?? extra.state ?? 'unknown',
    runner: job?.runnerId ? { runnerId: job.runnerId, name: job.runnerName } : null,
    ...(job
      ? {
          exitCode: job.exitCode,
          error: job.error,
          cancelRequested: job.cancelRequested,
          createdAt: job.createdAt,
          startedAt: job.startedAt,
          endedAt: job.endedAt,
        }
      : {}),
    ...(record
      ? {
          folder: record.folder,
          command: record.spec.command.length > 200 ? `${record.spec.command.slice(0, 200)}…` : record.spec.command,
          outputGlobs: record.spec.outputs,
          ...(record.outputs
            ? {
                outputFiles: files.slice(0, OUTPUT_FILES_LISTED_MAX),
                outputFileCount: files.length,
                outputBytes: record.outputs.bytes,
              }
            : {}),
          ...(extra.conversation ? { submittedFrom: extra.conversation } : {}),
        }
      : {}),
  }
}

const RESULT_NOTE =
  'The result arrives in the conversation that submitted the job as a new message when it ends, whatever way it ends. ' +
  'End your turn instead of waiting; runner_status and runner_logs show the job meanwhile.'

/** Registers the runner tools of a bot conversation; `gateway` resolves the bot's own gateway access at each call. */
export function registerBotRunnerTools(ctx: McpToolContext, gateway: Gateway, bot: () => BotRunnerHost | null): void {
  const hostOrThrow = (): BotRunnerHost => {
    const host = bot()
    if (!host) throw new Error('This conversation does not belong to a bot.')
    return host
  }
  const linked = async () => (await gatewayRequest(gateway(), 'runners')).runners
  /** Where the result goes back to: this conversation, which must be one the bot can continue. */
  const laneOf = (host: BotRunnerHost): RunnerJobConversation | null => {
    if (ctx.convId === host.primaryConversationId) return { kind: 'primary' }
    const lane = host.runs.byConversation(ctx.convId)
    if (lane?.kind === 'routine') return { kind: 'run', runId: lane.runId }
    if (lane?.kind === 'thread') return { kind: 'thread', threadId: lane.threadId, title: lane.title }
    return null
  }
  /** The real path of a folder of this environment, relative to the conversation's working folder when it is not absolute. */
  const resolveFolder = async (value: string): Promise<string> => {
    const base = getConversation(ctx.convId)?.cwd
    if (!path.isAbsolute(value) && !base)
      throw new Error(
        'This conversation has no working folder to resolve a relative folder against. Pass an absolute path.'
      )
    const wanted = path.isAbsolute(value) ? value : path.resolve(base!, value)
    let real: string
    try {
      real = await fs.realpath(wanted)
    } catch {
      throw new Error(
        `The folder ${wanted} does not exist. Create it first, or pass the folder that holds the job's inputs.`
      )
    }
    if (!(await fs.stat(real)).isDirectory())
      throw new Error(`${real} is not a folder. Pass the folder that holds the job's inputs.`)
    if (real === path.parse(real).root) throw new Error('Pass the project folder, not the root of the file system.')
    return real
  }
  /** The gateway's jobs by id; null when it does not answer. */
  const gatewayJobs = async (): Promise<Map<string, FleetRunnerJob> | null> => {
    try {
      return new Map((await gatewayRequest(gateway(), 'runnerJobsList')).jobs.map((job) => [job.jobId, job]))
    } catch {
      return null
    }
  }
  const submittedFrom = (record: RunnerJobRecord) =>
    record.conversationId === ctx.convId ? 'this conversation' : 'another conversation of yours'

  ctx.server.registerTool(
    'runner_list',
    {
      description:
        "The computers that run jobs for you: each one's runnerId, name, whether it is online now, executor " +
        '(container or native), OS, architecture, CPUs, memory, GPU, slots (jobs it runs at once) and how many are busy, ' +
        'and how many of your jobs are queued. Call it before runner_submit to pick a runner that fits the job. A runner ' +
        'is another computer: its tools and files are not the ones of this environment.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const runners = (await linked()).map(runnerView)
        if (!runners.length) return ok(JSON.stringify({ runners, note: NONE_LINKED }))
        const jobs = await gatewayJobs()
        const queuedJobs = jobs ? [...jobs.values()].filter((job) => job.state === 'queued').length : null
        return ok(JSON.stringify({ runners, queuedJobs }))
      } catch (error) {
        return err(messageOf(error))
      }
    }
  )

  ctx.server.registerTool(
    'runner_submit',
    {
      description: SUBMIT_DESCRIPTION,
      inputSchema: {
        folder: pathText.describe(
          'The folder of this environment the job takes its inputs from and brings its outputs back to: absolute, or ' +
            "relative to this conversation's working folder. It must exist."
        ),
        command: z
          .string()
          .min(1)
          .describe(
            'Shell command run with /bin/sh -c in a copy of the folder, with a relative working directory. ' +
              'Self-contained: install dependencies inside it, use relative paths, write results under the outputs you declare.'
          ),
        outputs: z
          .array(pathText)
          .min(1)
          .max(FLEET_RUNNER_LIMITS.listMax)
          .describe('Globs, relative to the folder, of the files to bring back, such as "out/**" or "render.mp4".'),
        runner: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe(
            'A runnerId or name from runner_list to run on only that one; omit to let any matching runner take it.'
          ),
        requires: requires.optional(),
        image: z
          .string()
          .min(1)
          .max(FLEET_RUNNER_LIMITS.imageMax)
          .optional()
          .describe(
            "Container runners only: the Docker image to run in; omit for the default (your environment's image)."
          ),
        env: env.optional(),
        caches: caches.optional(),
        exclude: z
          .array(pathText)
          .max(FLEET_RUNNER_LIMITS.listMax)
          .optional()
          .describe(
            'Paths or globs, relative to the folder, left out of the upload. Replaces the defaults (' +
              FLEET_RUNNER_DEFAULT_EXCLUDES.join(', ') +
              ').'
          ),
        timeoutMinutes: z
          .number()
          .int()
          .min(1)
          .max(FLEET_RUNNER_LIMITS.timeoutMinutesMax)
          .optional()
          .describe(
            `How long the command may run before it is stopped; default ${FLEET_RUNNER_LIMITS.timeoutMinutesDefault}.`
          ),
        queueTimeoutMinutes: z
          .number()
          .int()
          .min(0)
          .max(FLEET_RUNNER_LIMITS.queueMinutesMax)
          .optional()
          .describe(
            `How long the job may wait for a runner before it expires; default ${FLEET_RUNNER_LIMITS.queueMinutesDefault}.`
          ),
      },
      annotations: { readOnlyHint: false },
    },
    async (input, extra) => {
      try {
        const host = hostOrThrow()
        const lane = laneOf(host)
        if (!lane)
          return err('Jobs can only be submitted from your own conversations: the result has to come back to one.')
        // The same tool call always names the same job, so a call that is retried finds its record instead of queueing again.
        const id =
          'job_' +
          createHash('sha256')
            .update(`${ctx.convId}\0${keyForToolCall(extra)}`)
            .digest('base64url')
            .slice(0, 32)
        const records = host.runnerRecords()
        const existing = await records.get(id)
        if (existing?.job)
          return ok(
            JSON.stringify({
              ...jobView(existing, existing.job),
              alreadySubmitted: true,
              note: isFinal(existing.job) ? 'This job already ended.' : RESULT_NOTE,
            })
          )
        const folder = await resolveFolder(input.folder)
        const parsed = fleetRunnerJobSpecSchema.safeParse({
          folder,
          command: input.command,
          outputs: input.outputs,
          exclude: input.exclude,
          caches: input.caches,
          env: input.env,
          image: input.image,
          timeoutMinutes: input.timeoutMinutes,
          queueTimeoutMinutes: input.queueTimeoutMinutes,
        })
        if (!parsed.success)
          return err(
            'The job is not valid: ' +
              parsed.error.issues.map((issue) => `${issue.path.join('.') || 'job'}: ${issue.message}`).join('; ')
          )
        let runnerId: string | undefined
        if (input.runner) {
          const links = await linked()
          const wanted = input.runner.trim().toLowerCase()
          const match =
            links.find((link) => link.runnerId === input.runner) ??
            links.find((link) => link.name.toLowerCase() === wanted)
          if (!match)
            return err(
              `None of your runners is "${input.runner}". ` +
                (links.length
                  ? `Yours: ${links.map((link) => `${link.name} (${link.runnerId})`).join(', ')}.`
                  : NONE_LINKED)
            )
          runnerId = match.runnerId
        }
        // The record comes first: the gateway tells the environment where the job stands as soon as it is queued.
        const spec = existing?.spec ?? parsed.data
        if (!existing)
          await records.create({
            jobId: id,
            conversationId: ctx.convId,
            conversation: lane,
            folder,
            spec,
            createdAt: new Date().toISOString(),
            job: null,
            outputs: null,
            continued: false,
          })
        let result: FleetRunnerSubmitResult
        try {
          result = await gatewayRequest(gateway(), 'runnerJobCreate', {
            jobId: id,
            spec,
            requires: input.requires ?? {},
            ...(runnerId ? { runnerId } : {}),
          })
        } catch (error) {
          // The record stays: if the gateway did queue the job, its states land on it.
          return err(
            `${messageOf(error)} The job (${id}) may or may not be queued. Call runner_status: if it lists ${id}, it is submitted; if it says not_submitted, call runner_submit again.`
          )
        }
        if (!result.ok) {
          await records.remove(id).catch(() => undefined)
          const { code, message } = result.error
          const shown =
            code === 'runner_unmatched' || code === 'runner_not_linked'
              ? await linked()
                  .then((links) => ` Your runners: ${JSON.stringify(links.map(runnerView))}`)
                  .catch(() => '')
              : ''
          return err(`${code}: ${message}${shown}`)
        }
        // The state the gateway pushed meanwhile is the newer one.
        const stored = await records
          .update(id, (current) => (current.job ? current : { ...current, job: result.job }))
          .catch(() => null)
        const job = stored?.job ?? result.job
        return ok(
          JSON.stringify({
            ...jobView(stored ?? null, job),
            jobId: id,
            queuedAhead: result.queuedAhead,
            note: RESULT_NOTE,
          })
        )
      } catch (error) {
        return err(messageOf(error))
      }
    }
  )

  ctx.server.registerTool(
    'runner_status',
    {
      description:
        'Where a runner job stands: its state (queued, assigned, running, finishing, succeeded, failed, cancelled, ' +
        'expired or lost), runner, exit code, error, times, folder and the output files that came back. With jobId, one ' +
        'job; without it, the jobs submitted from this conversation, newest first. A job that ended continues its ' +
        'conversation by itself, so this is for checking a job on request, not for waiting. If a submit failed on the way, ' +
        'it tells whether the job exists (not_submitted when it does not).',
      inputSchema: { jobId: jobId.optional() },
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      try {
        const records = hostOrThrow().runnerRecords()
        if (input.jobId) {
          const record = await records.get(input.jobId)
          let job: FleetRunnerJob | null = record?.job ?? null
          let state: string | undefined
          let gatewayError: string | undefined
          if (!isFinal(job)) {
            if (record && !record.job) {
              // A submit that got no answer: the gateway's list tells whether the job exists.
              const jobs = await gatewayJobs()
              job = jobs?.get(record.jobId) ?? null
              if (!job) state = jobs ? 'not_submitted' : 'unknown'
            } else {
              try {
                job = await gatewayRequest(gateway(), 'runnerJobGet', undefined, { jobId: input.jobId })
              } catch (error) {
                gatewayError = messageOf(error)
                if (!record) return err(gatewayError)
              }
            }
          }
          return ok(
            JSON.stringify({
              ...jobView(record, job, {
                ...(state ? { state } : {}),
                ...(record ? { conversation: submittedFrom(record) } : {}),
              }),
              ...(gatewayError ? { gatewayError: `${gatewayError} The state is the last the environment heard.` } : {}),
            })
          )
        }
        const mine = (await records.list())
          .filter((record) => record.conversationId === ctx.convId)
          .slice(0, JOBS_LISTED_MAX)
        const refresh = mine.some((record) => !isFinal(record.job)) ? await gatewayJobs() : null
        const jobs = mine.map((record) => {
          const fresh = isFinal(record.job) ? null : (refresh?.get(record.jobId) ?? null)
          const job = fresh ?? record.job
          const state = job ? undefined : refresh ? 'not_submitted' : 'unknown'
          return jobView(record, job, state ? { state } : {})
        })
        return ok(
          JSON.stringify(
            jobs.length
              ? {
                  jobs,
                  ...(mine.some((record) => !isFinal(record.job)) && !refresh
                    ? { note: 'The gateway did not answer: states are the last the environment heard.' }
                    : {}),
                }
              : { jobs, note: 'No job was submitted from this conversation.' }
          )
        )
      } catch (error) {
        return err(messageOf(error))
      }
    }
  )

  ctx.server.registerTool(
    'runner_logs',
    {
      description:
        "The end of a runner job's log, from the copy this environment keeps while the job runs and after it ended: what " +
        'the command printed. Use it to see why a job failed or how far it got.',
      inputSchema: {
        jobId,
        lines: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe(`How many of the last lines to read; default ${LOG_LINES_DEFAULT}.`),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      try {
        const records = hostOrThrow().runnerRecords()
        const record = await records.get(input.jobId)
        if (!record) return err('No job with this id was submitted from this environment. runner_status lists yours.')
        const log = await tailRunnerLog(
          await runnerLogFile(records, record),
          input.lines ?? LOG_LINES_DEFAULT,
          LOG_BYTES_MAX
        )
        const state = record.job?.state ?? 'not_submitted'
        return ok(
          log
            ? `Job ${record.jobId} (${state}), the end of its log:\n${log}`
            : `Job ${record.jobId} (${state}) has no log yet: the runner sends it once the command prints.`
        )
      } catch (error) {
        return err(messageOf(error))
      }
    }
  )

  ctx.server.registerTool(
    'runner_cancel',
    {
      description:
        'Stop a runner job. A queued job ends at once; one that runs is stopped by its runner, which takes a moment. ' +
        'The conversation that submitted the job still receives a message when it ends, as for any other job.',
      inputSchema: { jobId },
      annotations: { readOnlyHint: false },
    },
    async (input) => {
      try {
        const job = await gatewayRequest(gateway(), 'runnerJobCancelOwn', undefined, { jobId: input.jobId })
        return ok(
          JSON.stringify({
            jobId: job.jobId,
            state: job.state,
            cancelRequested: job.cancelRequested,
            note: isFinal(job)
              ? 'The job ended.'
              : 'Cancellation requested: the runner stops the job, and a message tells this conversation when it ended.',
          })
        )
      } catch (error) {
        return err(messageOf(error))
      }
    }
  )
}
