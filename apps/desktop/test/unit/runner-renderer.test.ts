import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { FleetRunnerJob, FleetRunnerJobLogPage, FleetRunnerLinkView } from '@maestrly/bot-fleet-protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resources } from '../../src/shared/i18n/resources'
import {
  GIB,
  type RunnerAccessView,
  type RunnerHistoryItem,
  type RunnerJobItem,
  type RunnerStatus,
} from '../../src/shared/runner'
import type { FleetServerId } from '../../src/shared/fleet-servers'

// The texts come back as their keys, with the values they are given, so that what each place says is what is asserted.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
    i18n: { language: 'en' },
  }),
}))
import {
  bytesToGb,
  dockerNoticeKey,
  gbToBytes,
  jobDuration,
  RUNNER_OS_NAMES,
  RUNNER_SLOT_CHOICES,
} from '../../src/renderer/lib/runner'
import {
  BotRunnersView,
  type BotRunnersViewProps,
  newestJobs,
} from '../../src/renderer/components/fleet/BotRunnersSection'
import { RunnerLogPane } from '../../src/renderer/components/fleet/RunnerLogDialog'
import {
  applyRunnerLogPage,
  EMPTY_RUNNER_LOG,
  fitRunnerLog,
  followRunnerLog,
  RUNNER_LOG_MAX_CHARS,
  RUNNER_LOG_POLL_MS,
  runnerLogPath,
  type RunnerLogCursor,
  type RunnerLogState,
} from '../../src/renderer/lib/runner-log'
import { RunnerSettingsView, type RunnerSettingsViewProps } from '../../src/renderer/components/settings/RunnerSection'

const SERVER = 'aaaaaaaa-0000-4000-8000-000000000001' as FleetServerId
const NOW = '2026-10-29T10:00:00.000Z'
const t = (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key)

/** The markup with its quotes back, so that the values a text was given can be read in it. */
const plain = (html: string) => html.replaceAll('&quot;', '"').replaceAll('&#x27;', "'")

beforeEach(() => {
  vi.stubGlobal('window', { api: { platformInfo: { os: 'linux' }, openExternalUrl: vi.fn() } })
})

const status = (patch: Partial<RunnerStatus> = {}): RunnerStatus => ({
  available: true,
  config: {
    enabled: true,
    executor: 'native',
    slots: 2,
    jobCpus: null,
    jobMemoryBytes: null,
    gpu: false,
    storageDir: null,
    blobCapBytes: 50 * GIB,
  },
  nativeAllowed: true,
  capabilities: null,
  detectedGpu: null,
  docker: null,
  storage: { dir: '/data/runner', bots: [], blobBytes: 0, cacheBytes: 0 },
  servers: [{ serverId: SERVER, name: 'vps', connected: true, supported: true }],
  jobs: [],
  history: [],
  ...patch,
})
const settingsHtml = (current: RunnerStatus | null, patch: Partial<RunnerSettingsViewProps> = {}) =>
  renderToStaticMarkup(
    createElement(RunnerSettingsView, {
      t: t as RunnerSettingsViewProps['t'],
      status: current,
      now: 10_000,
      busy: false,
      error: '',
      cancelling: new Set<string>(),
      onChange: vi.fn(),
      onChooseFolder: vi.fn(),
      onClearCaches: vi.fn(),
      onCancelJob: vi.fn(),
      onRecheckDocker: vi.fn(),
      ...patch,
    })
  )

describe('Settings → Runner', () => {
  it('says it is loading, or why it could not load', () => {
    expect(settingsHtml(null)).toContain('common.loading')
    expect(settingsHtml(null, { error: 'Not reachable' })).toContain('Not reachable')
  })

  it('has nothing to run jobs in a bot container', () => {
    const html = settingsHtml(status({ available: false }))
    expect(html).toContain('settings.runner.unavailable')
    expect(html).not.toContain('role="switch"')
  })

  it('offers the switch off, with the warning that linked bots run code on this computer', () => {
    const html = settingsHtml(status({ config: { ...status().config, enabled: false } }))
    expect(html).toContain('aria-label="settings.runner.enable"')
    expect(html).toMatch(/role="switch"[^>]*aria-checked="false"|aria-checked="false"[^>]*role="switch"/)
    expect(html).toContain('settings.runner.warningNative')
    // Nothing to choose until it runs jobs, except the storage it may already hold.
    expect(html).not.toContain('settings.runner.executor.title')
    expect(html).not.toContain('settings.runner.capacity.title')
    expect(html).toContain('settings.runner.storage.title')
    expect(html).toContain('settings.runner.servers.notTaking')
  })

  it('warns about the container instead of the user when jobs run in Docker', () => {
    const html = settingsHtml(status({ config: { ...status().config, executor: 'container' } }))
    expect(html).toContain('settings.runner.warningContainer')
    expect(html).not.toContain('settings.runner.warningNative')
  })

  it('shows what each server does for this computer', () => {
    const html = settingsHtml(
      status({
        servers: [
          { serverId: SERVER, name: 'vps', connected: true, supported: true },
          {
            serverId: 'bbbbbbbb-0000-4000-8000-000000000002' as FleetServerId,
            name: 'home',
            connected: true,
            supported: false,
          },
          {
            serverId: 'cccccccc-0000-4000-8000-000000000003' as FleetServerId,
            name: 'lab',
            connected: false,
            supported: true,
          },
        ],
      })
    )
    expect(html).toContain('settings.runner.servers.taking')
    expect(html).toContain('settings.runner.servers.unsupported')
    expect(html).toContain('settings.runner.servers.offline')
    expect(settingsHtml(status({ servers: [] }))).toContain('settings.runner.servers.none')
  })

  it('offers Native and Container with Native chosen, and the slots, but no limits for Native', () => {
    const html = settingsHtml(status())
    expect(html).toContain('data-testid="runner-executor-native"')
    expect(html).toContain('data-testid="runner-executor-container"')
    expect(html).toMatch(
      /data-testid="runner-executor-native"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-testid="runner-executor-native"/
    )
    expect(html).toContain('settings.runner.capacity.slots')
    expect(html).not.toContain('settings.runner.capacity.cpus')
    expect(html).not.toContain('settings.runner.capacity.memory')
    expect(html).not.toContain('data-testid="runner-docker"')
  })

  it('offers Container only on a system that cannot run Native, and says so', () => {
    const html = settingsHtml(status({ nativeAllowed: false, config: { ...status().config, executor: 'container' } }))
    expect(html).not.toContain('data-testid="runner-executor-native"')
    expect(html).toContain('data-testid="runner-executor-container"')
    expect(html).toContain('settings.runner.executor.windows')
  })

  it('shows Docker’s state and the per-job limits for Container, with the installer’s words when Docker is missing', () => {
    const container = { ...status().config, executor: 'container' as const }
    const missing = settingsHtml(
      status({ config: container, docker: { state: 'missing', engine: null, version: null } })
    )
    expect(missing).toContain('data-testid="runner-docker"')
    expect(missing).toContain('botServer.local.missing')
    expect(missing).toContain('botServer.local.download')
    expect(missing).toContain('botServer.local.checkAgain')
    expect(missing).toContain('settings.runner.capacity.cpus')
    expect(missing).toContain('settings.runner.capacity.memory')
    const ready = settingsHtml(
      status({ config: container, docker: { state: 'ready', engine: 'OrbStack', version: '27.1.0' } })
    )
    expect(ready).toContain('botServer.local.readyEngine')
    expect(ready).toContain('27.1.0')
    expect(ready).not.toContain('botServer.local.download')
    expect(ready).not.toContain('botServer.local.checkAgain')
    expect(settingsHtml(status({ config: container }))).toContain('settings.runner.docker.checking')
  })

  it('lets jobs use the GPU only where there is one', () => {
    const none = settingsHtml(status())
    expect(none).toContain('settings.runner.capacity.gpuNone')
    const gpu = { vendor: 'nvidia' as const, name: 'RTX 4090', memoryBytes: 24 * GIB }
    const found = settingsHtml(status({ detectedGpu: gpu }))
    expect(found).toContain('RTX 4090')
    expect(found).toContain('settings.runner.capacity.gpuDetected')
  })

  it('shows the folder, how much each bot keeps and the way to clear the caches', () => {
    const html = settingsHtml(
      status({
        config: { ...status().config, storageDir: '/mnt/fast/runner' },
        storage: {
          dir: '/data/runner',
          blobBytes: 3 * GIB,
          cacheBytes: GIB,
          bots: [
            {
              serverId: SERVER,
              serverName: 'vps',
              botId: 'scout',
              botName: 'Scout',
              scope: 'abc',
              blobBytes: 3 * GIB,
              cacheBytes: GIB,
            },
          ],
        },
      })
    )
    expect(html).toContain('/mnt/fast/runner')
    expect(html).toContain('settings.runner.storage.useDefault')
    // Until the app restarts, it keeps using the folder it has.
    expect(html).toContain('settings.runner.storage.restartNote')
    expect(html).toContain('/data/runner')
    expect(html).toContain('data-testid="runner-usage-bot"')
    expect(html).toContain('Scout')
    expect(html).toContain('data-testid="runner-clear-caches"')
  })

  it('does not call the default folder a change that waits for a restart', () => {
    const html = settingsHtml(status({ storage: { dir: '/data/runner', bots: [], blobBytes: 0, cacheBytes: 0 } }))
    expect(html).not.toContain('settings.runner.storage.restartNote')
    expect(html).toContain('settings.runner.storage.defaultFolder')
  })

  it('lists the jobs it holds with the first line of the command, their state, how long they ran and Cancel', () => {
    const html = settingsHtml(
      status({
        jobs: [
          {
            serverId: SERVER,
            serverName: 'vps',
            botId: 'scout',
            botName: 'Scout',
            jobId: 'job_RunnerCoreTest0001',
            command: 'ffmpeg -i in.mov out.mp4',
            phase: 'running',
            startedAt: 10_000 - 75_000,
            usage: null,
          },
        ],
      })
    )
    expect(html).toContain('data-testid="runner-job"')
    expect(html).toContain('ffmpeg -i in.mov out.mp4')
    expect(html).toContain('settings.runner.jobs.phase.running')
    expect(html).toContain('1:15')
    expect(html).toContain('settings.runner.jobs.cancel')
    expect(settingsHtml(status())).toContain('settings.runner.jobs.empty')
  })

  it('shows a job being cancelled as such', () => {
    const job = {
      serverId: SERVER,
      serverName: 'vps',
      botId: 'scout',
      botName: null,
      jobId: 'job_RunnerCoreTest0001',
      command: 'make',
      phase: 'preparing' as const,
      startedAt: 0,
      usage: null,
    }
    const html = settingsHtml(status({ jobs: [job] }), { cancelling: new Set([job.jobId]) })
    expect(html).toContain('settings.runner.jobs.cancelling')
    expect(html).toContain('disabled')
    expect(html).toContain('settings.runner.jobs.unknownBot')
  })

  const runningJob = (patch: Partial<RunnerJobItem> = {}): RunnerJobItem => ({
    serverId: SERVER,
    serverName: 'vps',
    botId: 'scout',
    botName: 'Scout',
    jobId: 'job_RunnerCoreTest0001',
    command: 'ffmpeg -i in.mov out.mp4',
    phase: 'running',
    startedAt: 0,
    usage: null,
    ...patch,
  })
  const computer = { protocol: 1 as const, os: 'linux' as const, arch: 'x64' as const, cpus: 12, memoryBytes: 32 * GIB }

  it('shows what a running job uses: its share of the processors, its memory and its peak, and its processes', () => {
    const usage = { cpuPercent: 350, memoryBytes: GIB, peakMemoryBytes: 2 * GIB, processes: 4, at: 5 }
    const html = plain(
      settingsHtml(
        status({
          capabilities: { ...computer, executor: 'native', gpu: null, slots: 2 },
          jobs: [runningJob({ usage })],
        })
      )
    )
    expect(html).toContain('data-testid="runner-job-usage"')
    expect(html).toContain('botSettings.runners.usage.cpuOf {"count":12,"used":"3.5"}')
    expect(html).toContain('botSettings.runners.usage.memory {"now":"1 GB","peak":"2 GB"}')
    expect(html).toContain('botSettings.runners.usage.processes {"count":4}')
  })

  it('shows the CPU as a percentage while the processors of the computer are not known, and nothing before a sample', () => {
    const usage = { cpuPercent: 350, memoryBytes: 512 * 1024 ** 2, peakMemoryBytes: GIB, processes: 1, at: 5 }
    const html = plain(settingsHtml(status({ jobs: [runningJob({ usage })] })))
    expect(html).toContain('botSettings.runners.usage.cpu {"percent":"350"}')
    expect(html).not.toContain('usage.cpuOf')
    expect(html).toContain('"now":"512 MB"')
    expect(settingsHtml(status({ jobs: [runningJob()] }))).not.toContain('runner-job-usage')
  })

  it('offers the log of a running job beside Cancel', () => {
    const html = settingsHtml(status({ jobs: [runningJob()] }))
    expect(html).toContain('settings.runner.jobs.log')
    expect(html.indexOf('settings.runner.jobs.log')).toBeLessThan(html.indexOf('settings.runner.jobs.cancel'))
    // The viewer opens on a click, not before.
    expect(html).not.toContain('data-testid="runner-log"')
  })

  const entry = (patch: Partial<RunnerHistoryItem> = {}): RunnerHistoryItem => ({
    serverId: SERVER,
    serverName: 'vps',
    botId: 'scout',
    botName: 'Scout',
    jobId: 'job_RunnerCoreTest0002',
    command: 'make -j8',
    outcome: 'succeeded',
    exitCode: 0,
    error: null,
    startedAt: 1_000_000,
    endedAt: 1_000_000 + 75_000,
    peakMemoryBytes: 3 * GIB,
    cpuSeconds: 200,
    ...patch,
  })

  it('lists the jobs that ended here lately: who sent them, the command, how they ended, how long, what they used', () => {
    const html = plain(settingsHtml(status({ history: [entry()] })))
    expect(html).toContain('data-testid="runner-history"')
    expect(html.match(/data-testid="runner-history-job"/g)).toHaveLength(1)
    expect(html).toContain('settings.runner.history.title')
    expect(html).toContain('settings.runner.jobs.bot {"bot":"Scout","server":"vps"}')
    expect(html).toContain('make -j8')
    expect(html).toContain('data-outcome="succeeded"')
    expect(html).toContain('settings.runner.history.outcome.succeeded')
    expect(html).toContain('settings.runner.history.took {"time":"1:15"}')
    expect(html).toContain('settings.runner.history.peakMemory {"memory":"3 GB"}')
    expect(html).toContain('settings.runner.history.cpuTime {"time":"3:20"}')
    // A job that worked has no exit code to explain.
    expect(html).not.toContain('settings.runner.history.exitCode')
    expect(html).toContain('settings.runner.jobs.log')
    expect(html).not.toContain('settings.runner.jobs.cancel')
  })

  it('says how a failed or cancelled job ended: the reason, else the exit code', () => {
    const html = plain(
      settingsHtml(
        status({
          history: [
            entry({
              jobId: 'job_RunnerCoreTest0003',
              outcome: 'failed',
              exitCode: 2,
              error: { code: 'exit_code', message: 'The command exited with code 2.' },
            }),
            entry({ jobId: 'job_RunnerCoreTest0004', outcome: 'failed', exitCode: 137 }),
            entry({ jobId: 'job_RunnerCoreTest0005', outcome: 'cancelled', exitCode: null }),
          ],
        })
      )
    )
    expect(html.match(/data-testid="runner-history-job"/g)).toHaveLength(3)
    expect(html).toContain('settings.runner.history.outcome.failed')
    expect(html).toContain('settings.runner.history.outcome.cancelled')
    expect(html).toContain('The command exited with code 2.')
    expect(html).toContain('settings.runner.history.exitCode {"code":137}')
    expect(html.match(/settings\.runner\.history\.exitCode/g)).toHaveLength(1)
  })

  it('leaves out what was never measured, and names a bot it does not know', () => {
    const html = plain(
      settingsHtml(status({ history: [entry({ peakMemoryBytes: null, cpuSeconds: null, botName: null })] }))
    )
    expect(html).not.toContain('settings.runner.history.peakMemory')
    expect(html).not.toContain('settings.runner.history.cpuTime')
    expect(html).toContain('settings.runner.history.took')
    expect(html).toContain('settings.runner.jobs.unknownBot')
  })

  it('keeps twenty jobs in one scrolling list, and says when none ended lately', () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      entry({ jobId: `job_RunnerCoreTest${String(index).padStart(4, '0')}` })
    )
    const html = settingsHtml(status({ history: many }))
    expect(html.match(/data-testid="runner-history-job"/g)).toHaveLength(20)
    expect(html).toContain('overflow-y-auto')
    expect(settingsHtml(status())).toContain('settings.runner.history.empty')
    // Nothing to list, and the runner is off: the section stays away.
    expect(settingsHtml(status({ config: { ...status().config, enabled: false } }))).not.toContain(
      'settings.runner.history.title'
    )
    expect(settingsHtml(status({ config: { ...status().config, enabled: false }, history: [entry()] }))).toContain(
      'data-testid="runner-history"'
    )
  })

  it('says what went wrong', () => {
    expect(settingsHtml(status(), { error: 'Docker did not answer' })).toContain('Docker did not answer')
  })
})

const link = (patch: Partial<FleetRunnerLinkView> = {}): FleetRunnerLinkView => ({
  runnerId: 'rnr_AAAAAAAAAAAAAAAA0001',
  name: 'Studio',
  online: true,
  capabilities: {
    protocol: 1,
    os: 'macos',
    arch: 'arm64',
    cpus: 12,
    memoryBytes: 32 * GIB,
    executor: 'native',
    gpu: { vendor: 'apple', name: 'Apple M3 Max', memoryBytes: null },
    slots: 2,
  },
  busySlots: 1,
  lastSeenAt: NOW,
  linkedAt: NOW,
  self: false,
  ...patch,
})
const job = (patch: Partial<FleetRunnerJob> = {}): FleetRunnerJob => ({
  jobId: 'job_RunnerCoreTest0001',
  botId: 'scout',
  runnerId: 'rnr_AAAAAAAAAAAAAAAA0001',
  runnerName: 'Studio',
  state: 'running',
  requires: {},
  cancelRequested: false,
  createdAt: NOW,
  queueDeadline: NOW,
  assignedAt: NOW,
  startedAt: NOW,
  endedAt: null,
  exitCode: null,
  error: null,
  ...patch,
})
const access = (patch: Partial<RunnerAccessView> = {}): RunnerAccessView => ({
  supported: true,
  connected: true,
  botSupported: true,
  runnerEnabled: true,
  executor: 'native',
  self: null,
  links: [],
  jobs: [],
  defaultName: 'Studio Mac mini',
  ...patch,
})
const botHtml = (view: RunnerAccessView | null, patch: Partial<BotRunnersViewProps> = {}) =>
  renderToStaticMarkup(
    createElement(BotRunnersView, {
      id: 'runners',
      view,
      loadError: '',
      busy: false,
      error: '',
      onLink: vi.fn(async () => true),
      onUnlink: vi.fn(async () => true),
      onRemove: vi.fn(async () => true),
      onCancelJob: vi.fn(async () => undefined),
      readJobLog: vi.fn(async () => ({ start: 0, next: 0, size: 0, text: '' })),
      ...patch,
    })
  )

describe('Bot settings → Runners', () => {
  it('says it is loading, or why it could not load', () => {
    expect(botHtml(null)).toContain('botSettings.runners.loading')
    expect(botHtml(null, { loadError: 'Unreachable' })).toContain('Unreachable')
  })

  it('offers the switch on a computer that runs jobs, and no warning until the bot is linked', () => {
    const html = botHtml(access())
    expect(html).toContain('data-testid="fleet-runners-switch"')
    expect(html).toContain('aria-label="botSettings.runners.thisComputer.enable"')
    expect(html).not.toContain('data-testid="fleet-runners-off"')
    expect(html).not.toContain('data-testid="fleet-runners-unavailable"')
    expect(html).not.toContain('data-testid="fleet-runners-form"')
  })

  it('shows the name the bot sees and the warning once it is linked, for the executor in use', () => {
    const self = link({ self: true, name: 'Render box' })
    const native = botHtml(access({ self, links: [self] }))
    expect(native).toContain('botSettings.runners.thisComputer.on')
    expect(native).toContain('Render box')
    expect(native).toContain('data-testid="fleet-runners-form"')
    expect(native).toContain('botSettings.runners.thisComputer.warningNative')
    expect(native).toContain('aria-label="botSettings.runners.thisComputer.turnOff"')
    const container = botHtml(access({ self, links: [self], executor: 'container' }))
    expect(container).toContain('botSettings.runners.thisComputer.warningContainer')
    expect(container).not.toContain('botSettings.runners.thisComputer.warningNative')
  })

  it('says to turn on Run jobs for bots, with a way to Settings, while this computer does not run jobs', () => {
    const html = botHtml(access({ runnerEnabled: false }))
    expect(html).toContain('data-testid="fleet-runners-off"')
    expect(html).toContain('botSettings.runners.thisComputer.runnerOff')
    expect(html).toContain('botSettings.runners.thisComputer.openSettings')
    // The switch cannot be turned on from here.
    expect(html).toMatch(/aria-checked="false"[^>]*disabled|disabled[^>]*aria-checked="false"/)
  })

  it('says which part lacks support: the connection, the gateway or the bot’s image', () => {
    expect(botHtml(access({ connected: false, links: null, jobs: null }))).toContain(
      'botSettings.runners.unavailable.disconnected'
    )
    expect(botHtml(access({ supported: false, links: null, jobs: null }))).toContain(
      'botSettings.runners.unavailable.gateway-update'
    )
    expect(botHtml(access({ botSupported: false }))).toContain('botSettings.runners.unavailable.bot-update')
  })

  it('lists every runner with what it is, and Remove only for another computer’s', () => {
    const self = link({ self: true, name: 'Studio', runnerId: 'rnr_AAAAAAAAAAAAAAAA0001' })
    const rack = link({
      runnerId: 'rnr_BBBBBBBBBBBBBBBB0002',
      name: 'Rack',
      online: false,
      capabilities: { ...link().capabilities!, os: 'linux', executor: 'container', gpu: null },
    })
    const html = botHtml(access({ self, links: [self, rack] }))
    expect(html.match(/data-testid="fleet-runner"/g)).toHaveLength(2)
    expect(html).toContain('Studio')
    expect(html).toContain('Rack')
    expect(html).toContain('Apple M3 Max')
    expect(html).toContain(RUNNER_OS_NAMES.macos)
    expect(html).toContain(RUNNER_OS_NAMES.linux)
    expect(html).toContain('botSettings.runners.list.native')
    expect(html).toContain('botSettings.runners.list.container')
    expect(html).toContain('botSettings.runners.list.noGpu')
    expect(html).toContain('botSettings.runners.list.online')
    expect(html).toContain('botSettings.runners.list.offline')
    expect(html).toContain('botSettings.runners.list.slots')
    expect(html.match(/botSettings\.runners\.list\.remove</g)).toHaveLength(1)
  })

  it('says when no computer runs jobs for the bot, or the server could not list them', () => {
    expect(botHtml(access())).toContain('botSettings.runners.list.empty')
    expect(botHtml(access({ links: null, jobs: null }))).toContain('botSettings.runners.list.unknown')
  })

  it('lists the newest jobs with their state and runner', () => {
    const html = botHtml(
      access({
        jobs: [
          job({ jobId: 'job_RunnerCoreTest0001', state: 'succeeded', createdAt: '2026-10-29T08:00:00.000Z' }),
          job({
            jobId: 'job_RunnerCoreTest0002',
            state: 'failed',
            runnerName: null,
            createdAt: '2026-10-29T09:00:00.000Z',
            error: { code: 'exit_code', message: 'The command exited with code 2.' },
          }),
        ],
      })
    )
    expect(html.match(/data-testid="fleet-runner-job"/g)).toHaveLength(2)
    expect(html).toContain('botSettings.runners.jobs.state.succeeded')
    expect(html).toContain('botSettings.runners.jobs.state.failed')
    expect(html).toContain('The command exited with code 2.')
    expect(html).toContain('botSettings.runners.jobs.unknownRunner')
    // The newest first.
    expect(html.indexOf('botSettings.runners.jobs.state.failed')).toBeLessThan(
      html.indexOf('botSettings.runners.jobs.state.succeeded')
    )
    expect(botHtml(access())).toContain('botSettings.runners.jobs.empty')
  })

  it('shows only the newest ten jobs', () => {
    const jobs = Array.from({ length: 14 }, (_, index) =>
      job({
        jobId: `job_RunnerCoreTest${String(index).padStart(4, '0')}`,
        createdAt: `2026-10-29T10:${String(index).padStart(2, '0')}:00.000Z`,
      })
    )
    expect(botHtml(access({ jobs })).match(/data-testid="fleet-runner-job"/g)).toHaveLength(10)
  })

  /** The markup of each job row of the tab. */
  const jobRows = (jobs: FleetRunnerJob[], patch: Partial<BotRunnersViewProps> = {}) =>
    plain(botHtml(access({ jobs }), patch))
      .split('data-testid="fleet-runner-job"')
      .slice(1)
  const stateOf = (row: string) => /data-state="(\w+)"/.exec(row)?.[1]

  it('offers Cancel on a job that is not over and Log on one that started', () => {
    const rows = jobRows([
      job({ jobId: 'job_RunnerCoreTest0001', state: 'queued', startedAt: null, runnerId: null, runnerName: null }),
      job({ jobId: 'job_RunnerCoreTest0002', state: 'assigned', startedAt: null }),
      job({ jobId: 'job_RunnerCoreTest0003', state: 'running' }),
      job({ jobId: 'job_RunnerCoreTest0004', state: 'finishing' }),
      job({ jobId: 'job_RunnerCoreTest0005', state: 'succeeded', endedAt: NOW }),
      job({ jobId: 'job_RunnerCoreTest0006', state: 'failed', endedAt: NOW }),
      job({ jobId: 'job_RunnerCoreTest0007', state: 'expired', startedAt: null, endedAt: NOW }),
      job({ jobId: 'job_RunnerCoreTest0008', state: 'lost', endedAt: NOW }),
    ])
    const buttons = Object.fromEntries(
      rows.map((row) => [
        stateOf(row),
        [
          row.includes('botSettings.runners.jobs.cancel<') && 'cancel',
          row.includes('botSettings.runners.jobs.log<') && 'log',
        ].filter(Boolean),
      ])
    )
    expect(buttons).toEqual({
      queued: ['cancel'],
      assigned: ['cancel'],
      running: ['cancel', 'log'],
      finishing: ['cancel', 'log'],
      succeeded: ['log'],
      failed: ['log'],
      expired: [],
      lost: ['log'],
    })
  })

  it('shows a job already asked to stop as cancelling, and cannot be asked again', () => {
    const [row] = jobRows([job({ cancelRequested: true })])
    expect(row).toContain('botSettings.runners.jobs.cancelling')
    expect(row).not.toContain('botSettings.runners.jobs.cancel<')
    expect(row).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*botSettings\.runners\.jobs\.cancelling/s)
  })

  it('shows what a running job uses, as a share of the processors of the runner that has it', () => {
    const usage = { cpuPercent: 150, memoryBytes: 3 * GIB, peakMemoryBytes: 4 * GIB, processes: 2, at: NOW }
    const [row] = jobRows([job({ state: 'running', usage })], {})
    // The runner is not among the links shown: the CPU is a percentage.
    expect(row).toContain('botSettings.runners.usage.cpu {"percent":"150"}')
    const html = plain(botHtml(access({ jobs: [job({ state: 'running', usage })], links: [link()] })))
    expect(html).toContain('botSettings.runners.usage.cpuOf {"count":12,"used":"1.5"}')
    expect(html).toContain('botSettings.runners.usage.memory {"now":"3 GB","peak":"4 GB"}')
    expect(html).toContain('botSettings.runners.usage.processes {"count":2}')
  })

  it('shows no usage for a job that is waiting or over', () => {
    const usage = { cpuPercent: 150, memoryBytes: GIB, peakMemoryBytes: GIB, processes: 1, at: NOW }
    for (const state of ['queued', 'assigned', 'finishing', 'succeeded', 'cancelled'] as const)
      expect(botHtml(access({ jobs: [job({ state, usage })] }))).not.toContain('runner-job-usage')
  })

  it('lists the newest ten jobs first', () => {
    const jobs = Array.from({ length: 12 }, (_, index) =>
      job({
        jobId: `job_RunnerCoreTest${String(index).padStart(4, '0')}`,
        createdAt: `2026-10-29T10:${String(index).padStart(2, '0')}:00.000Z`,
      })
    )
    const shown = newestJobs(jobs)
    expect(shown).toHaveLength(10)
    expect(shown[0]?.jobId).toBe('job_RunnerCoreTest0011')
    expect(shown.at(-1)?.jobId).toBe('job_RunnerCoreTest0002')
    expect(jobs[0]?.jobId).toBe('job_RunnerCoreTest0000')
  })

  it('shows a failure of the last change', () => {
    expect(botHtml(access(), { error: 'The server refused' })).toContain('The server refused')
  })
})

describe('Runner log viewer', () => {
  const page = (patch: Partial<FleetRunnerJobLogPage> = {}): FleetRunnerJobLogPage => ({
    start: 0,
    next: 6,
    size: 6,
    text: 'hello\n',
    ...patch,
  })
  const pane = (state: Partial<RunnerLogState>, live = true, jobId?: string) =>
    plain(renderToStaticMarkup(createElement(RunnerLogPane, { state: { ...EMPTY_RUNNER_LOG, ...state }, live, jobId })))

  it('says it is loading until the first read, and waits for output when the log is empty', () => {
    expect(pane({})).toContain('botSettings.runners.log.loading')
    const waiting = pane({ loaded: true })
    expect(waiting).toContain('botSettings.runners.log.waiting')
    expect(waiting).toContain('data-testid="runner-log-empty"')
    // A job that is over and wrote nothing is not waited for.
    expect(pane({ loaded: true }, false)).toContain('botSettings.runners.log.noOutput')
    expect(pane({ loaded: true }, false)).not.toContain('botSettings.runners.log.waiting')
  })

  it('shows the text as it is, in monospace, wrapping long lines', () => {
    const html = pane({ loaded: true, text: 'step 1\n<b>not markup</b> & more\n' })
    expect(html).toContain('step 1')
    expect(html).toContain('&lt;b&gt;not markup&lt;/b&gt; &amp; more')
    expect(html).toMatch(/<pre[^>]*class="[^"]*\bfont-mono\b/)
    expect(html).toMatch(/<pre[^>]*class="[^"]*\bwhitespace-pre-wrap\b/)
    expect(html).toMatch(/<pre[^>]*class="[^"]*\bbreak-words\b/)
    expect(html).not.toContain('data-testid="runner-log-empty"')
    expect(html).not.toContain('data-testid="runner-log-earlier"')
  })

  it('says earlier lines are not shown, and where the whole log lands when the job ends', () => {
    const live = pane({ loaded: true, text: 'late\n', earlier: true }, true, 'job_RunnerCoreTest0001')
    expect(live).toContain('data-testid="runner-log-earlier"')
    expect(live).toContain(
      'botSettings.runners.log.earlier {"path":".maestrly/runner-jobs/job_RunnerCoreTest0001.log"}'
    )
    const ended = pane({ loaded: true, text: 'late\n', earlier: true }, false, 'job_RunnerCoreTest0001')
    expect(ended).toContain('botSettings.runners.log.earlierEnded')
    expect(ended).toContain('.maestrly/runner-jobs/job_RunnerCoreTest0001.log')
    expect(runnerLogPath(undefined)).toBe('.maestrly/runner-jobs/<jobId>.log')
  })

  it('shows a failed read where the log is, and says it tries again only while live', () => {
    const live = pane({ loaded: true, text: 'so far\n', error: 'The environment is not running' })
    expect(live).toContain('so far')
    expect(live).toContain('role="alert"')
    expect(live).toContain('botSettings.runners.log.error {"error":"The environment is not running"}')
    expect(live).toContain('botSettings.runners.log.retrying')
    const ended = pane({ error: 'This job’s log is no longer kept on this computer.' }, false)
    expect(ended).toContain('no longer kept')
    expect(ended).not.toContain('botSettings.runners.log.retrying')
    // A first read that failed is not "loading" any more.
    expect(ended).not.toContain('botSettings.runners.log.loading')
  })

  it('keeps the last half megabyte, dropping the oldest lines whole and saying so', () => {
    expect(RUNNER_LOG_MAX_CHARS).toBe(512 * 1024)
    expect(fitRunnerLog('short\n')).toEqual({ text: 'short\n', dropped: false })
    const lines = Array.from({ length: 100 }, (_, index) => `line ${String(index).padStart(3, '0')}\n`)
    const fit = fitRunnerLog(lines.join(''), 55)
    expect(fit.dropped).toBe(true)
    expect(fit.text.length).toBeLessThanOrEqual(55)
    expect(fit.text.startsWith('line ')).toBe(true)
    expect(fit.text.endsWith('line 099\n')).toBe(true)
    // Without a line start near the cut, the cut is where it falls.
    expect(fitRunnerLog('x'.repeat(100), 40)).toEqual({ text: 'x'.repeat(40), dropped: true })
    // The last line is never cut down to nothing.
    expect(fitRunnerLog('abcdefghij\n', 5).text).toBe('ghij\n')
  })

  it('shows the start of the first page as earlier lines, replaces with it, and follows the others', () => {
    let state = applyRunnerLogPage(EMPTY_RUNNER_LOG, page({ start: 90, next: 100, size: 100, text: 'tail\n' }), true)
    expect(state).toEqual({ text: 'tail\n', earlier: true, loaded: true, error: '' })
    state = applyRunnerLogPage({ ...state, error: 'late' }, page({ start: 100, next: 106, text: 'more\n' }), false)
    expect(state).toEqual({ text: 'tail\nmore\n', earlier: true, loaded: true, error: '' })
    expect(applyRunnerLogPage(EMPTY_RUNNER_LOG, page(), true).earlier).toBe(false)
    const big = applyRunnerLogPage(
      { ...EMPTY_RUNNER_LOG, loaded: true, text: 'a\n'.repeat(RUNNER_LOG_MAX_CHARS / 2) },
      page({ text: 'new\n' }),
      false
    )
    expect(big.earlier).toBe(true)
    expect(big.text.length).toBeLessThanOrEqual(RUNNER_LOG_MAX_CHARS)
    expect(big.text.endsWith('new\n')).toBe(true)
  })

  describe('following a log', () => {
    afterEach(() => vi.useRealTimers())
    const follow = (
      reads: Array<FleetRunnerJobLogPage | Error>,
      live: boolean,
      cursor: RunnerLogCursor = { next: null }
    ) => {
      vi.useFakeTimers()
      const queue = [...reads]
      const read = vi.fn(async (_offset: number | null) => {
        const next = queue.shift() ?? page({ start: 0, next: 0, size: 0, text: '' })
        if (next instanceof Error) throw next
        return next
      })
      const pages: Array<[string, boolean]> = []
      const errors: string[] = []
      const stop = followRunnerLog({
        read,
        live,
        cursor,
        onPage: (received, first) => pages.push([received.text, first]),
        onError: (cause) => errors.push((cause as Error).message),
      })
      return { read, pages, errors, stop, cursor }
    }
    const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms)

    it('reads the end, then asks every second and a half from where the page before ended, until stopped', async () => {
      const { read, pages, stop } = follow(
        [
          page({ start: 90, next: 100, size: 100, text: 'tail\n' }),
          page({ start: 100, next: 110, size: 110, text: 'more\n' }),
          page({ start: 110, next: 110, size: 110, text: '' }),
        ],
        true
      )
      await tick(0)
      expect(read.mock.calls).toEqual([[null]])
      await tick(RUNNER_LOG_POLL_MS - 1)
      expect(read).toHaveBeenCalledTimes(1)
      await tick(1)
      expect(read.mock.calls).toEqual([[null], [100]])
      await tick(RUNNER_LOG_POLL_MS)
      expect(read.mock.calls).toEqual([[null], [100], [110]])
      expect(pages).toEqual([
        ['tail\n', true],
        ['more\n', false],
        ['', false],
      ])
      stop()
      await tick(10 * RUNNER_LOG_POLL_MS)
      expect(read).toHaveBeenCalledTimes(3)
    })

    it('goes on at once while a page stopped short of what the log holds', async () => {
      const { read } = follow(
        [
          page({ start: 0, next: 10, size: 25, text: 'a' }),
          page({ start: 10, next: 20, size: 25, text: 'b' }),
          page({ start: 20, next: 25, size: 25, text: 'c' }),
        ],
        true
      )
      await tick(5)
      expect(read.mock.calls).toEqual([[null], [10], [20]])
      await tick(RUNNER_LOG_POLL_MS - 10)
      expect(read).toHaveBeenCalledTimes(3)
    })

    it('does not spin on a page that went nowhere', async () => {
      const { read } = follow(
        [page({ start: 0, next: 10, size: 50, text: 'a' }), page({ start: 10, next: 10, size: 50, text: '' })],
        true
      )
      await tick(5)
      expect(read.mock.calls).toEqual([[null], [10]])
      await tick(RUNNER_LOG_POLL_MS - 10)
      expect(read).toHaveBeenCalledTimes(2)
      await tick(10)
      expect(read).toHaveBeenCalledTimes(3)
    })

    it('reads once when the job is not live, and again from where it ended when it is followed on', async () => {
      const cursor: RunnerLogCursor = { next: null }
      const first = follow([page({ start: 0, next: 6, size: 6 })], false, cursor)
      await tick(10 * RUNNER_LOG_POLL_MS)
      expect(first.read.mock.calls).toEqual([[null]])
      expect(cursor.next).toBe(6)
      // The job ended: one last read, from where the log was.
      const last = follow([page({ start: 6, next: 12, size: 12, text: 'done\n' })], false, cursor)
      await tick(10 * RUNNER_LOG_POLL_MS)
      expect(last.read.mock.calls).toEqual([[6]])
      expect(last.pages).toEqual([['done\n', false]])
    })

    it('shows a failed read and, while live, tries again until it works', async () => {
      const { read, errors, pages } = follow(
        [new Error('Offline'), new Error('Still offline'), page({ start: 0, next: 6, size: 6 })],
        true
      )
      await tick(0)
      expect(errors).toEqual(['Offline'])
      await tick(RUNNER_LOG_POLL_MS)
      expect(errors).toEqual(['Offline', 'Still offline'])
      await tick(RUNNER_LOG_POLL_MS)
      // The log is still read from its end: nothing was read before.
      expect(read.mock.calls).toEqual([[null], [null], [null]])
      expect(pages).toEqual([['hello\n', true]])
    })

    it('does not try again after a failure when the job is not live', async () => {
      const { read, errors } = follow([new Error('Gone')], false)
      await tick(10 * RUNNER_LOG_POLL_MS)
      expect(errors).toEqual(['Gone'])
      expect(read).toHaveBeenCalledTimes(1)
    })

    it('drops a read that was under way when it is stopped', async () => {
      vi.useFakeTimers()
      let finish: (value: FleetRunnerJobLogPage) => void = () => undefined
      const read = vi.fn(() => new Promise<FleetRunnerJobLogPage>((resolve) => (finish = resolve)))
      const onPage = vi.fn()
      const cursor: RunnerLogCursor = { next: null }
      const stop = followRunnerLog({ read, live: true, cursor, onPage, onError: vi.fn() })
      stop()
      finish(page())
      await tick(10 * RUNNER_LOG_POLL_MS)
      expect(onPage).not.toHaveBeenCalled()
      expect(cursor.next).toBeNull()
      expect(read).toHaveBeenCalledTimes(1)
    })
  })
})

describe('Runner helpers', () => {
  it('times a job in minutes and seconds, and in hours from the first', () => {
    expect(jobDuration(0)).toBe('0:00')
    expect(jobDuration(-5_000)).toBe('0:00')
    expect(jobDuration(9_000)).toBe('0:09')
    expect(jobDuration(75_000)).toBe('1:15')
    expect(jobDuration(59 * 60_000 + 59_000)).toBe('59:59')
    expect(jobDuration(3_600_000)).toBe('1:00:00')
    expect(jobDuration(3_600_000 + 61_000)).toBe('1:01:01')
  })

  it('converts sizes to the whole gigabytes people edit, at least one', () => {
    expect(bytesToGb(null)).toBeUndefined()
    expect(bytesToGb(50 * GIB)).toBe(50)
    expect(bytesToGb(GIB / 4)).toBe(1)
    expect(gbToBytes(8)).toBe(8 * GIB)
    expect(gbToBytes(2.4)).toBe(2 * GIB)
  })

  it('offers one to eight simultaneous jobs', () => {
    expect(RUNNER_SLOT_CHOICES).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('names Docker’s state with the installer’s texts', () => {
    expect(dockerNoticeKey({ state: 'missing', engine: null, version: null })).toBe('botServer.local.missing')
    expect(dockerNoticeKey({ state: 'stopped', engine: null, version: null })).toBe('botServer.local.stopped')
    expect(dockerNoticeKey({ state: 'no-permission', engine: null, version: null })).toBe(
      'botServer.local.no-permission'
    )
    expect(dockerNoticeKey({ state: 'ready', engine: null, version: '27' })).toBe('botServer.local.ready')
    expect(dockerNoticeKey({ state: 'ready', engine: 'OrbStack', version: '27' })).toBe('botServer.local.readyEngine')
  })
})

describe('Runner texts', () => {
  const find = (catalog: unknown, key: string): unknown =>
    key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog)
  // A text with a count is kept once for each plural form.
  const lookup = (catalog: unknown, key: string): unknown => find(catalog, key) ?? find(catalog, `${key}_other`)
  const sources = [
    '../../src/renderer/components/settings/RunnerSection.tsx',
    '../../src/renderer/components/fleet/BotRunnersSection.tsx',
    '../../src/renderer/components/fleet/RunnerLogDialog.tsx',
    '../../src/renderer/components/fleet/RunnerUsage.tsx',
    '../../src/renderer/lib/runner.ts',
  ].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))

  /** Every literal key the runner screens ask for, in the namespace each asks it in. */
  const used = (pattern: RegExp, source: string) => [...source.matchAll(pattern)].map((match) => match[1])

  it('has every text the settings screens ask for, in English and Brazilian Portuguese', () => {
    const ui = used(/\bt\('(settings\.runner\.[A-Za-z.]+)'/g, sources.join('\n'))
    const fleet = used(/\bt\(\s*'(botSettings\.runners\.[A-Za-z.-]+)'/g, sources.join('\n'))
    const installer = used(/\btf\('(botServer\.local\.[A-Za-z-]+)'/g, sources.join('\n'))
    expect(ui.length).toBeGreaterThan(20)
    expect(fleet.length).toBeGreaterThan(15)
    expect(installer).toContain('botServer.local.download')
    const missing = (['en', 'pt-BR'] as const).flatMap((language) => [
      ...ui
        .filter((key) => typeof lookup(resources[language].ui, key) !== 'string')
        .map((key) => `${language} ui ${key}`),
      ...fleet
        .filter((key) => typeof lookup(resources[language].fleet, key) !== 'string')
        .map((key) => `${language} fleet ${key}`),
      ...installer
        .filter((key) => typeof lookup(resources[language].fleet, key) !== 'string')
        .map((key) => `${language} fleet ${key}`),
    ])
    expect(missing).toEqual([])
  })

  it('has the texts the screens build from a state', () => {
    const keys = {
      ui: [
        ...['native', 'container'].flatMap((kind) => [
          `settings.runner.executor.${kind}`,
          `settings.runner.executor.${kind}Desc`,
        ]),
        ...['preparing', 'running', 'uploading', 'finishing'].map((phase) => `settings.runner.jobs.phase.${phase}`),
        ...['succeeded', 'failed', 'cancelled'].map((outcome) => `settings.runner.history.outcome.${outcome}`),
      ],
      fleet: [
        ...['queued', 'assigned', 'running', 'finishing', 'succeeded', 'failed', 'cancelled', 'expired', 'lost'].map(
          (state) => `botSettings.runners.jobs.state.${state}`
        ),
        ...['disconnected', 'gateway-update', 'bot-update'].map((part) => `botSettings.runners.unavailable.${part}`),
        ...['native', 'container'].map((kind) => `botSettings.runners.list.${kind}`),
        'botSettings.runners.list.cpus_one',
        'botSettings.runners.list.cpus_other',
        ...['one', 'other'].flatMap((form) => [
          `botSettings.runners.usage.cpuOf_${form}`,
          `botSettings.runners.usage.processes_${form}`,
        ]),
        ...['loading', 'waiting', 'noOutput', 'earlier', 'earlierEnded', 'live', 'ended'].map(
          (part) => `botSettings.runners.log.${part}`
        ),
        ...['copy', 'copied', 'copyFailed', 'latest', 'error', 'retrying', 'title'].map(
          (part) => `botSettings.runners.log.${part}`
        ),
        ...['missing', 'stopped', 'no-permission', 'ready', 'readyEngine'].map((state) => `botServer.local.${state}`),
      ],
    }
    const missing = (['en', 'pt-BR'] as const).flatMap((language) => [
      ...keys.ui
        .filter((key) => typeof lookup(resources[language].ui, key) !== 'string')
        .map((key) => `${language} ${key}`),
      ...keys.fleet
        .filter((key) => typeof lookup(resources[language].fleet, key) !== 'string')
        .map((key) => `${language} ${key}`),
    ])
    expect(missing).toEqual([])
  })

  it('says Runners in the bot settings tabs, and Runner in the settings menu', () => {
    for (const language of ['en', 'pt-BR'] as const) {
      expect(resources[language].fleet.botSettings.section.runners).toBe('Runners')
      expect(resources[language].ui.settings.nav.runner).toBe('Runner')
    }
  })
})
