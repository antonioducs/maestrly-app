import { createInstance } from 'i18next'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ChatConfig } from '../../src/shared/chat'
import type { FleetServerId } from '../../src/shared/fleet-servers'
import { hostKey, LOCAL_HOST_ID } from '../../src/shared/host-key'
import type { HostView } from '../../src/shared/hosts'
import ptBRChat from '../../src/shared/i18n/pt-BR/chat'
import ptBRRoutines from '../../src/shared/i18n/pt-BR/routines'
import ptBRUi from '../../src/shared/i18n/pt-BR/ui'
import {
  type LocalRoutine,
  type LocalRoutineRun,
  type RoutineDraft,
  type RoutineProposal,
  resolveRoutinePlace,
  storedRoutinePlace,
} from '../../src/shared/routines'
import {
  isRoutineHostCapable,
  mergeHostRoutines,
  routineHostDisplay,
  shellRoutine,
  shellRoutineRun,
  validateRoutineModelForHost,
} from '../../src/renderer/lib/routines/host-routines'

Object.assign(globalThis, {
  window: {
    innerWidth: 1200,
    innerHeight: 800,
    api: { platformInfo: { os: 'linux' } },
  },
})

vi.mock('../../src/renderer/lib/chat-window-context', () => ({
  useChatOwnerWindow: () => globalThis.window,
  useChatDocument: () => ({ addEventListener: () => {}, removeEventListener: () => {} }),
  useChatPortalContainer: () => undefined,
  ChatWindowEnvironment: { Provider: ({ children }: { children: unknown }) => children },
}))

const i18nInstance = createInstance()
void i18nInstance.init({
  lng: 'pt-BR',
  resources: {
    'pt-BR': {
      routines: ptBRRoutines,
      chat: ptBRChat,
      ui: ptBRUi,
    },
  },
  defaultNS: 'routines',
  interpolation: { escapeValue: false },
})

vi.mock('react-i18next', () => ({
  useTranslation: (ns = 'routines') => ({
    t: (key: string, opts?: Record<string, unknown>) => i18nInstance.t(key, { ns, ...opts }),
    i18n: i18nInstance,
  }),
}))

import { RoutineEditorFormBody } from '../../src/renderer/components/routines/RoutineEditorDialog'
import { RoutineProposalCardBody } from '../../src/renderer/components/routines/RoutineProposalCard'

const SERVER_HOST_ID = 'server-1/workspaces'
const STOPPED_HOST_ID = 'server-1/staging'
const OLD_HOST_ID = 'server-2/legacy'
const PEER_HOST_ID = 'peer:macbook'

function makeHost(patch: Partial<HostView> & { id: string }): HostView {
  return {
    remote: patch.id !== LOCAL_HOST_ID,
    label: patch.id === LOCAL_HOST_ID ? '' : 'Workspaces',
    server: patch.id === LOCAL_HOST_ID ? '' : 'vps-prod',
    serverId: patch.id === LOCAL_HOST_ID ? null : ('server-1' as FleetServerId),
    tint: patch.id === LOCAL_HOST_ID ? null : '#4978c6',
    state: 'online',
    epoch: 1,
    os: 'linux',
    homeDir: '/home/bot',
    desktopEffects: patch.id === LOCAL_HOST_ID,
    editor: true,
    browser: true,
    computer: false,
    folderTransfers: false,
    routines: true,
    environment:
      patch.id === LOCAL_HOST_ID
        ? null
        : { id: 'workspaces', lifecycle: 'running', updateAvailable: false },
    peer: null,
    hostVersion: null,
    ...patch,
  }
}

const localHost = makeHost({ id: LOCAL_HOST_ID })
const serverHost = makeHost({ id: SERVER_HOST_ID, label: 'Workspaces', server: 'vps-prod' })
const stoppedHost = makeHost({
  id: STOPPED_HOST_ID,
  label: 'Staging',
  server: 'vps-prod',
  state: 'offline',
  environment: { id: 'staging', lifecycle: 'stopped', updateAvailable: false },
})
const oldContainerHost = makeHost({
  id: OLD_HOST_ID,
  label: 'Legacy',
  server: 'vps-old',
  routines: false,
})
const peerHost = makeHost({
  id: PEER_HOST_ID,
  label: 'MacBook',
  server: '',
  serverId: null,
  routines: true,
  environment: null,
  peer: { deviceId: 'p1', problem: null },
})

const sampleDraft: RoutineDraft = {
  title: 'Monitorar deploy',
  instruction: 'Verifique a saúde do servidor e avise se algo falhar.',
  schedule: { kind: 'weekly', time: '09:00', days: [1, 2, 3, 4, 5], timezone: 'America/Sao_Paulo' },
  permMode: 'full',
  model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-6', reasoning: 'medium', fastMode: false },
  notify: 'notable',
  missed: 'catchup',
  retentionDays: 30,
}

function makeRawRoutine(id: string, overrides: Partial<LocalRoutine> = {}): LocalRoutine {
  return {
    id,
    ...sampleDraft,
    enabled: true,
    origin: { conversationId: 'conv-origin', title: 'Deploy chat', via: 'proposal' },
    createdAt: 1000,
    updatedAt: 2000,
    nextRunAt: 50_000,
    pausedAt: null,
    folder: `/home/bot/.maestrly/routines/${id}`,
    ...overrides,
  }
}

function makeRawRun(id: string, routineId: string, overrides: Partial<LocalRoutineRun> = {}): LocalRoutineRun {
  return {
    id,
    routineId,
    scheduledAt: 10_000,
    startedAt: 10_000,
    finishedAt: 11_000,
    trigger: 'schedule',
    status: 'notable',
    summary: 'Found issue',
    report: null,
    error: null,
    conversationId: 'conv-run-1',
    conversationDeleted: false,
    pinned: false,
    unread: true,
    ...overrides,
  }
}

describe('multi-host routine helpers', () => {
  it('filters routine-capable hosts, excluding legacy containers and peer computers', () => {
    expect(isRoutineHostCapable(localHost)).toBe(true)
    expect(isRoutineHostCapable(serverHost)).toBe(true)
    expect(isRoutineHostCapable(stoppedHost)).toBe(true)
    expect(isRoutineHostCapable(oldContainerHost)).toBe(false)
    expect(isRoutineHostCapable(peerHost)).toBe(false)
  })

  it('keys remote routines and runs with their host and preserves cross-host origin conversation keys', () => {
    const sameHostOrigin = shellRoutine(SERVER_HOST_ID, makeRawRoutine('r1'))
    expect(sameHostOrigin.id).toBe(hostKey(SERVER_HOST_ID, 'r1'))
    expect(sameHostOrigin.origin?.conversationId).toBe(hostKey(SERVER_HOST_ID, 'conv-origin'))

    // A computer's origin is stored by the device id it has on the server: only that computer links to it.
    const computerOrigin = makeRawRoutine('r2', {
      origin: { conversationId: 'conv-local', title: 'Local chat', via: 'proposal', deviceId: 'device-me' },
    })
    const mine = shellRoutine(SERVER_HOST_ID, computerOrigin, (server) => (server === 'server-1' ? 'device-me' : null))
    expect(mine.id).toBe(hostKey(SERVER_HOST_ID, 'r2'))
    expect(mine.origin).toMatchObject({ conversationId: 'conv-local', hostId: LOCAL_HOST_ID, title: 'Local chat' })
    expect(mine.origin).not.toHaveProperty('deviceId')
    const another = shellRoutine(SERVER_HOST_ID, computerOrigin, () => 'device-other')
    expect(another.origin).toMatchObject({ conversationId: '', hostId: null, title: 'Local chat' })

    // Another server host keeps its id, which every computer paired with that server reads alike.
    const fromOtherEnv = shellRoutine(
      LOCAL_HOST_ID,
      makeRawRoutine('r3', {
        origin: { conversationId: 'conv-srv', title: 'Server chat', via: 'menu', hostId: SERVER_HOST_ID },
      })
    )
    expect(fromOtherEnv.origin?.conversationId).toBe(hostKey(SERVER_HOST_ID, 'conv-srv'))

    const run = shellRoutineRun(SERVER_HOST_ID, makeRawRun('run-1', 'r1'))
    expect(run.id).toBe(hostKey(SERVER_HOST_ID, 'run-1'))
    expect(run.routineId).toBe(hostKey(SERVER_HOST_ID, 'r1'))
    expect(run.conversationId).toBe(hostKey(SERVER_HOST_ID, 'conv-run-1'))
  })

  it('stores places every paired computer resolves alike, and round-trips them for this computer', () => {
    const mine = (server: string) => (server === 'server-1' ? 'device-me' : null)
    const other = () => 'device-other'
    const cases: [store: string, target: string][] = [
      [LOCAL_HOST_ID, LOCAL_HOST_ID],
      [LOCAL_HOST_ID, SERVER_HOST_ID],
      [SERVER_HOST_ID, SERVER_HOST_ID],
      [SERVER_HOST_ID, LOCAL_HOST_ID],
      [SERVER_HOST_ID, STOPPED_HOST_ID],
    ]
    for (const [store, target] of cases) {
      const place = storedRoutinePlace(store, target, mine)
      expect(place.hostId).not.toBe(LOCAL_HOST_ID)
      expect(resolveRoutinePlace(store, place, mine)).toBe(target)
    }
    // Another computer paired with the same server does not take this one's conversations for its own.
    expect(resolveRoutinePlace(SERVER_HOST_ID, storedRoutinePlace(SERVER_HOST_ID, LOCAL_HOST_ID, mine), other)).toBeNull()
    // Without a known device id, the place resolves for no computer rather than for every one.
    expect(resolveRoutinePlace(SERVER_HOST_ID, storedRoutinePlace(SERVER_HOST_ID, LOCAL_HOST_ID, () => null), mine)).toBeNull()
  })

  it('aggregates routines from multiple hosts and keeps cached entries for offline hosts', () => {
    const localRoutine = makeRawRoutine('r-local', { nextRunAt: 30_000 })
    const serverRoutine = makeRawRoutine('r-srv', { nextRunAt: 20_000 })
    const stoppedRoutine = makeRawRoutine('r-stop', { enabled: false, nextRunAt: null })

    const merged = mergeHostRoutines([LOCAL_HOST_ID, SERVER_HOST_ID, STOPPED_HOST_ID], {
      [LOCAL_HOST_ID]: {
        routines: [localRoutine],
        runsByRoutine: {},
        timelineRunsByRoutine: {},
      },
      [SERVER_HOST_ID]: {
        routines: [serverRoutine],
        runsByRoutine: { 'r-srv': [makeRawRun('run-1', 'r-srv')] },
        timelineRunsByRoutine: {},
      },
      [STOPPED_HOST_ID]: {
        routines: [stoppedRoutine],
        runsByRoutine: {},
        timelineRunsByRoutine: {},
      },
    })
    expect(merged.routines.map((r) => r.id)).toEqual([
      'r-local',
      hostKey(SERVER_HOST_ID, 'r-srv'),
      hostKey(STOPPED_HOST_ID, 'r-stop'),
    ])
    expect(merged.runsByRoutine[hostKey(SERVER_HOST_ID, 'r-srv')]?.[0]?.id).toBe(
      hostKey(SERVER_HOST_ID, 'run-1')
    )
  })

  it('validates provider account and model availability on the destination host', () => {
    const emptyConfig = { providers: [] } as unknown as ChatConfig
    expect(validateRoutineModelForHost(sampleDraft.model, emptyConfig)).toEqual({
      status: 'missing-provider',
      providerName: 'anthropic',
    })

    const connectedConfig = {
      providers: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          kind: 'claude',
          connected: true,
          apiKeyPresent: true,
          models: ['claude-haiku-4-5'],
        },
      ],
    } as unknown as ChatConfig
    const rowsWithoutModel = [
      {
        key: 'anthropic::claude-haiku-4-5',
        providerId: 'anthropic',
        modelId: 'claude-haiku-4-5',
        label: 'Claude Haiku 4.5',
      },
    ] as unknown as Parameters<typeof validateRoutineModelForHost>[2]
    expect(validateRoutineModelForHost(sampleDraft.model, connectedConfig, rowsWithoutModel, 0)).toEqual({
      status: 'missing-model',
      providerName: 'Anthropic',
    })

    const rowsWithModel = [
      {
        key: 'anthropic::claude-sonnet-4-6',
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-6',
        label: 'Claude Sonnet 4.6',
      },
    ] as unknown as Parameters<typeof validateRoutineModelForHost>[2]
    expect(validateRoutineModelForHost(sampleDraft.model, connectedConfig, rowsWithModel, 0)).toEqual({
      status: 'valid',
      providerName: 'Anthropic',
    })
  })

  it('formats host display labels and statuses for local, online, and stopped server environments', () => {
    const tr = (key: string, opts?: Record<string, unknown>) => String(i18nInstance.t(key, { ns: 'routines', ...opts }))
    expect(routineHostDisplay(localHost, LOCAL_HOST_ID, tr)).toMatchObject({
      isRemote: false,
      fullLabel: ptBRRoutines.host.thisComputer,
      status: 'online',
    })
    expect(routineHostDisplay(serverHost, SERVER_HOST_ID, tr)).toMatchObject({
      isRemote: true,
      fullLabel: 'Workspaces · vps-prod',
      status: 'online',
    })
    expect(routineHostDisplay(stoppedHost, STOPPED_HOST_ID, tr)).toMatchObject({
      isRemote: true,
      status: 'stopped',
      canStart: true,
    })
  })
})

describe('multi-host routine UI rendering', () => {
  const proposal: RoutineProposal = {
    id: 'prop-1',
    conversationId: 'conv-1',
    draft: sampleDraft,
    state: 'pending',
    routineId: null,
    createdAt: 1000,
  }

  it('renders host selector and model/stopped warnings on RoutineProposalCardBody', () => {
    const htmlMissingModel = renderToStaticMarkup(
      createElement(RoutineProposalCardBody, {
        proposal,
        routine: null,
        lastRun: null,
        backgroundEnabled: false,
        modelInfo: { name: 'Claude Sonnet 4.6', providerName: 'Anthropic' },
        hosts: [localHost, serverHost, stoppedHost, oldContainerHost],
        targetHostId: SERVER_HOST_ID,
        modelValidation: { status: 'missing-model', providerName: 'Anthropic' },
        onChangeTargetHost: () => {},
        onEnableBackground: () => {},
        onCreate: () => {},
        onAdjust: () => {},
        onDiscard: () => {},
        onRestore: () => {},
        onOpenRoutine: () => {},
      })
    )
    expect(htmlMissingModel).toContain(ptBRRoutines.host.runsOn)
    expect(htmlMissingModel).toContain('Workspaces · vps-prod')
    expect(htmlMissingModel).not.toContain('Legacy')
    // Local keep-running warning is hidden when targeting a remote server.
    expect(htmlMissingModel).not.toContain(ptBRRoutines.proposal.bgWarning)
    expect(htmlMissingModel).toContain('Este modelo não está disponível em Workspaces · vps-prod')

    const htmlStopped = renderToStaticMarkup(
      createElement(RoutineProposalCardBody, {
        proposal,
        routine: null,
        lastRun: null,
        backgroundEnabled: true,
        modelInfo: { name: 'Claude Sonnet 4.6', providerName: 'Anthropic' },
        hosts: [localHost, serverHost, stoppedHost],
        targetHostId: STOPPED_HOST_ID,
        onChangeTargetHost: () => {},
        onStartTargetHost: () => {},
        onEnableBackground: () => {},
        onCreate: () => {},
        onAdjust: () => {},
        onDiscard: () => {},
        onRestore: () => {},
        onOpenRoutine: () => {},
      })
    )
    expect(htmlStopped).toContain(ptBRRoutines.host.startAction)
  })

  it('renders host selector and container-scoped full-access copy in RoutineEditorFormBody', () => {
    const htmlNewRemote = renderToStaticMarkup(
      createElement(RoutineEditorFormBody, {
        target: { kind: 'new', initialHostId: SERVER_HOST_ID },
        hosts: [localHost, serverHost, oldContainerHost],
        savedPermissions: [],
        onClose: () => {},
        onSaveNew: async () => {},
        onSaveEdit: async () => {},
        onRemoveSavedPermission: () => {},
      })
    )
    expect(htmlNewRemote).toContain(ptBRRoutines.host.runsOn)
    expect(htmlNewRemote).toContain('Workspaces · vps-prod')
    expect(htmlNewRemote).not.toContain('Legacy')

    const remoteRoutine = shellRoutine(SERVER_HOST_ID, makeRawRoutine('r-remote', { permMode: 'full' }))
    const htmlEditRemote = renderToStaticMarkup(
      createElement(RoutineEditorFormBody, {
        target: { kind: 'edit', routine: remoteRoutine },
        hosts: [localHost, serverHost],
        savedPermissions: [],
        onClose: () => {},
        onSaveNew: async () => {},
        onSaveEdit: async () => {},
        onRemoveSavedPermission: () => {},
      })
    )
    expect(htmlEditRemote).toContain(ptBRRoutines.host.fullRoutineRemote)
    expect(htmlEditRemote).toContain('Workspaces · vps-prod')
  })
})
