import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { FleetRunnerJob, FleetRunnerLinkView } from '@maestrly/bot-fleet-protocol'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resources } from '../../src/shared/i18n/resources'
import { GIB, type RunnerAccessView, type RunnerStatus } from '../../src/shared/runner'
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
import { BotRunnersView, type BotRunnersViewProps } from '../../src/renderer/components/fleet/BotRunnersSection'
import { RunnerSettingsView, type RunnerSettingsViewProps } from '../../src/renderer/components/settings/RunnerSection'

const SERVER = 'aaaaaaaa-0000-4000-8000-000000000001' as FleetServerId
const NOW = '2026-10-29T10:00:00.000Z'
const t = (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key)

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
    }
    const html = settingsHtml(status({ jobs: [job] }), { cancelling: new Set([job.jobId]) })
    expect(html).toContain('settings.runner.jobs.cancelling')
    expect(html).toContain('disabled')
    expect(html).toContain('settings.runner.jobs.unknownBot')
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

  it('shows a failure of the last change', () => {
    expect(botHtml(access(), { error: 'The server refused' })).toContain('The server refused')
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
      ],
      fleet: [
        ...['queued', 'assigned', 'running', 'finishing', 'succeeded', 'failed', 'cancelled', 'expired', 'lost'].map(
          (state) => `botSettings.runners.jobs.state.${state}`
        ),
        ...['disconnected', 'gateway-update', 'bot-update'].map((part) => `botSettings.runners.unavailable.${part}`),
        ...['native', 'container'].map((kind) => `botSettings.runners.list.${kind}`),
        'botSettings.runners.list.cpus_one',
        'botSettings.runners.list.cpus_other',
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
