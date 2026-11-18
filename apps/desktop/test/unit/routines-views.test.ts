import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createInstance } from 'i18next'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import ptBRChat from '../../src/shared/i18n/pt-BR/chat'
import ptBRRoutines from '../../src/shared/i18n/pt-BR/routines'
import ptBRUi from '../../src/shared/i18n/pt-BR/ui'
import type { LocalRoutine, LocalRoutineRun, RoutineSavedPermission } from '../../src/shared/routines'

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

import { RoutinesSidebarPanel } from '../../src/renderer/components/routines/RoutinesSidebarPanel'
import { RoutinesAgendaView } from '../../src/renderer/components/routines/RoutinesAgendaView'
import { RoutineDetailView } from '../../src/renderer/components/routines/RoutineDetailView'

function makeRoutine(overrides: Partial<LocalRoutine> = {}): LocalRoutine {
  return {
    id: 'r-lisboa',
    title: 'Preço GRU → LIS em março',
    instruction: 'Confira no Google Voos.',
    schedule: { kind: 'weekly', time: '08:00', days: [], timezone: 'America/Sao_Paulo' },
    enabled: true,
    pausedAt: null,
    permMode: 'auto',
    model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-6', reasoning: 'medium', fastMode: false },
    notify: 'notable',
    missed: 'catchup',
    retentionDays: 30,
    origin: { conversationId: 'c-lisboa', title: 'Viagem a Lisboa em março', via: 'proposal' },
    folder: '/tmp/routines/r-lisboa',
    nextRunAt: Date.now() + 21 * 3_600_000,
    createdAt: Date.now() - 6 * 86_400_000,
    updatedAt: Date.now() - 6 * 86_400_000,
    ...overrides,
  }
}

function makeRun(overrides: Partial<LocalRoutineRun> = {}): LocalRoutineRun {
  const now = Date.now()
  return {
    id: 'run-1',
    routineId: 'r-lisboa',
    scheduledAt: now - 3_600_000,
    startedAt: now - 3_600_000,
    finishedAt: now - 3_570_000,
    trigger: 'schedule',
    status: 'notable',
    summary: 'Menor preço caiu para R$ 3.790',
    report: null,
    error: null,
    conversationId: 'conv-run-1',
    conversationDeleted: false,
    pinned: false,
    unread: true,
    ...overrides,
  }
}

describe('RoutinesSidebarPanel', () => {
  it('renders Agenda, Active and Paused groups, expanded runs and background banner', () => {
    const active = makeRoutine()
    const paused = makeRoutine({ id: 'r-disk', title: 'Espaço do Docker', enabled: false, pausedAt: Date.now() - 3600_000 })
    const runs = [
      makeRun({ id: 'run-1', status: 'notable' }),
      makeRun({ id: 'run-2', status: 'skipped_closed', conversationId: null }),
    ]

    const html = renderToStaticMarkup(
      createElement(RoutinesSidebarPanel, {
        routines: [active, paused],
        runsByRoutine: { 'r-lisboa': runs, 'r-disk': [] },
        query: '',
        view: { kind: 'routine', id: 'r-lisboa' },
        activeConversationId: null,
        backgroundEnabled: false,
        expandedIds: new Set(['r-lisboa']),
        onToggleExpanded: vi.fn(),
        onOpenAgenda: vi.fn(),
        onOpenRoutine: vi.fn(),
        onOpenRun: vi.fn(),
        onEnableBackground: vi.fn(),
      })
    )

    expect(html).toContain('Agenda')
    expect(html).toContain('Ativas')
    expect(html).toContain('Pausadas')
    expect(html).toContain('Preço GRU → LIS em março')
    expect(html).toContain('Espaço do Docker')
    expect(html).toContain('Rotinas param com o Maestrly fechado')
    expect(html).toContain('disabled')
  })

  it('hides the background banner on the agenda view, with zero routines, or with only paused routines', () => {
    const active = makeRoutine()
    const paused = makeRoutine({ id: 'r-disk', title: 'Espaço do Docker', enabled: false })
    const baseProps = {
      runsByRoutine: {},
      query: '',
      activeConversationId: null,
      backgroundEnabled: false,
      expandedIds: new Set<string>(),
      onToggleExpanded: vi.fn(),
      onOpenAgenda: vi.fn(),
      onOpenRoutine: vi.fn(),
      onOpenRun: vi.fn(),
      onEnableBackground: vi.fn(),
    }

    const agendaHtml = renderToStaticMarkup(
      createElement(RoutinesSidebarPanel, {
        ...baseProps,
        routines: [active],
        view: { kind: 'agenda' },
      })
    )
    expect(agendaHtml).not.toContain('Rotinas param com o Maestrly fechado')

    const emptyHtml = renderToStaticMarkup(
      createElement(RoutinesSidebarPanel, {
        ...baseProps,
        routines: [],
        view: { kind: 'routine', id: 'r-lisboa' },
      })
    )
    expect(emptyHtml).not.toContain('Rotinas param com o Maestrly fechado')

    const pausedOnlyHtml = renderToStaticMarkup(
      createElement(RoutinesSidebarPanel, {
        ...baseProps,
        routines: [paused],
        view: { kind: 'routine', id: 'r-disk' },
      })
    )
    expect(pausedOnlyHtml).not.toContain('Rotinas param com o Maestrly fechado')
  })
})

describe('RoutinesAgendaView', () => {
  it('renders empty state when no routines exist and Linux login-item hint when disabled', () => {
    const emptyHtml = renderToStaticMarkup(
      createElement(RoutinesAgendaView, {
        routines: [],
        runsByRoutine: {},
        attentionRuns: [],
        settings: { keepRunning: true, openAtLogin: false },
        preventSleepEnabled: true,
        isLinux: true,
        onNewRoutine: vi.fn(),
        onAskInChat: vi.fn(),
        onOpenRoutine: vi.fn(),
        onOpenRun: vi.fn(),
        onViewBots: vi.fn(),
        onToggleKeepRunning: vi.fn(),
        onToggleOpenAtLogin: vi.fn(),
      })
    )
    expect(emptyHtml).toContain('Nenhuma rotina ainda')
    expect(emptyHtml).toContain('Pedir no chat')
    expect(emptyHtml).toContain('Criar aqui')
    expect(emptyHtml).toContain('Disponível no macOS e no Windows')
    expect(emptyHtml).toContain('Ver bots')
    expect(emptyHtml).toContain('pl-[var(--view-header-inset)]')
  })

  it('renders Precisa de você, Esta semana timeline, A seguir and background banner', () => {
    const routine = makeRoutine()
    const waitingRun = makeRun({
      id: 'run-wait',
      status: 'waiting',
      summary: null,
      waiting: { kind: 'approval', prompt: 'Quer apagar 3 instaladores (4,2 GB)' },
    })
    const questionRun = makeRun({
      id: 'run-ask',
      status: 'waiting',
      summary: null,
      waiting: { kind: 'question', prompt: 'Qual pasta usar?' },
    })
    const failedRun = makeRun({
      id: 'run-fail',
      status: 'failed',
      summary: null,
      error: 'Taxa excedida na API',
    })
    const html = renderToStaticMarkup(
      createElement(RoutinesAgendaView, {
        routines: [routine],
        runsByRoutine: { 'r-lisboa': [waitingRun, questionRun, failedRun] },
        attentionRuns: [
          { routine, run: waitingRun },
          { routine, run: questionRun },
          { routine, run: failedRun },
        ],
        settings: { keepRunning: false, openAtLogin: false },
        preventSleepEnabled: true,
        isLinux: false,
        onNewRoutine: vi.fn(),
        onAskInChat: vi.fn(),
        onOpenRoutine: vi.fn(),
        onOpenRun: vi.fn(),
        onViewBots: vi.fn(),
        onToggleKeepRunning: vi.fn(),
        onToggleOpenAtLogin: vi.fn(),
      })
    )
    expect(html).toContain('Rotinas param com o Maestrly fechado.')
    expect(html).toContain('Precisa de você')
    expect(html).toContain('text-[13px] font-medium text-foreground')
    expect(html).toContain('Aguardando você')
    expect(html).toContain('Quer apagar 3 instaladores (4,2 GB). Aguardando sua aprovação.')
    expect(html).toContain('Fez uma pergunta')
    expect(html).toContain('Qual pasta usar? Aguardando sua resposta.')
    expect(html).toContain('Falhou: Taxa excedida na API')
    expect(html).toContain('Esta semana')
    expect(html).toContain('A seguir')
    expect(html).toContain('Este computador')
    expect(html).toContain('Ligado')
  })

  it('hides the agenda background banner when there are zero or only paused routines', () => {
    const paused = makeRoutine({ id: 'r-disk', enabled: false })
    const baseProps = {
      runsByRoutine: {},
      attentionRuns: [],
      settings: { keepRunning: false, openAtLogin: false },
      preventSleepEnabled: true,
      isLinux: false,
      onNewRoutine: vi.fn(),
      onAskInChat: vi.fn(),
      onOpenRoutine: vi.fn(),
      onOpenRun: vi.fn(),
      onViewBots: vi.fn(),
      onToggleKeepRunning: vi.fn(),
      onToggleOpenAtLogin: vi.fn(),
    }

    const emptyHtml = renderToStaticMarkup(createElement(RoutinesAgendaView, { ...baseProps, routines: [] }))
    expect(emptyHtml).not.toContain('Rotinas param com o Maestrly fechado.')

    const pausedHtml = renderToStaticMarkup(createElement(RoutinesAgendaView, { ...baseProps, routines: [paused] }))
    expect(pausedHtml).not.toContain('Rotinas param com o Maestrly fechado.')
  })
})

describe('RoutineDetailView', () => {
  it('renders hero, runs filters, config with saved permissions, and hides saved permissions in full mode', () => {
    const routine = makeRoutine()
    const run = makeRun({ status: 'done', summary: 'Verificação ok', trigger: 'manual', pinned: true })
    const saved: RoutineSavedPermission[] = [
      { id: 'p-1', scopeKey: 'routine:r-lisboa', action: 'bash', resource: 'npm test' },
    ]
    const html = renderToStaticMarkup(
      createElement(RoutineDetailView, {
        routine,
        runs: [run],
        totalRuns: 1,
        hasMoreRuns: false,
        timelineRuns: [run],
        savedPermissions: saved,
        filter: 'all',
        modelInfo: { name: 'Claude Sonnet 4.6', providerName: 'Claude' },
        onFilterChange: vi.fn(),
        onShowMore: vi.fn(),
        onBackAgenda: vi.fn(),
        onToggleEnabled: vi.fn(),
        onRunNow: vi.fn(),
        onStopRun: vi.fn(),
        onEdit: vi.fn(),
        onDuplicate: vi.fn(),
        onDelete: vi.fn(),
        onOpenRun: vi.fn(),
        onRemoveSavedPermission: vi.fn(),
        onOpenFolder: vi.fn(),
        onOpenOriginChat: vi.fn(),
      })
    )
    expect(html).toContain('08:00')
    expect(html).toContain('Executar agora')
    expect(html).toContain('Todas')
    expect(html).toContain('Novidades')
    expect(html).toContain('Problemas e puladas')
    expect(html).toContain('Sempre permitido')
    expect(html).toContain('npm test')
    expect(html).toContain('Abrir pasta')
    expect(html).toContain('Criada no chat')
    expect(html).toContain('Viagem a Lisboa em março')
    expect(html).toContain('pl-[var(--view-header-inset)]')

    const fullHtml = renderToStaticMarkup(
      createElement(RoutineDetailView, {
        routine: makeRoutine({ permMode: 'full', origin: null }),
        runs: [],
        totalRuns: 0,
        hasMoreRuns: false,
        timelineRuns: [],
        savedPermissions: saved,
        filter: 'all',
        modelInfo: { name: 'Claude Sonnet 4.6', providerName: 'Claude' },
        onFilterChange: vi.fn(),
        onShowMore: vi.fn(),
        onBackAgenda: vi.fn(),
        onToggleEnabled: vi.fn(),
        onRunNow: vi.fn(),
        onStopRun: vi.fn(),
        onEdit: vi.fn(),
        onDuplicate: vi.fn(),
        onDelete: vi.fn(),
        onOpenRun: vi.fn(),
        onRemoveSavedPermission: vi.fn(),
        onOpenFolder: vi.fn(),
        onOpenOriginChat: vi.fn(),
      })
    )
    expect(fullHtml).not.toContain('Sempre permitido')
    expect(fullHtml).toContain('Criada em Rotinas')
  })

  it('keeps the routine run timestamp and trigger tag on one line in RoutineDetailView', () => {
    const routine = makeRoutine()
    const manualRun = makeRun({ id: 'run-manual', trigger: 'manual', status: 'nothing_new', summary: 'Sem novidades' })
    const html = renderToStaticMarkup(
      createElement(RoutineDetailView, {
        routine,
        runs: [manualRun],
        totalRuns: 1,
        hasMoreRuns: false,
        timelineRuns: [manualRun],
        savedPermissions: [],
        filter: 'all',
        modelInfo: { name: 'Claude Sonnet 4.6', providerName: 'Claude' },
        onFilterChange: vi.fn(),
        onShowMore: vi.fn(),
        onBackAgenda: vi.fn(),
        onToggleEnabled: vi.fn(),
        onRunNow: vi.fn(),
        onStopRun: vi.fn(),
        onEdit: vi.fn(),
        onDuplicate: vi.fn(),
        onDelete: vi.fn(),
        onOpenRun: vi.fn(),
        onRemoveSavedPermission: vi.fn(),
        onOpenFolder: vi.fn(),
        onOpenOriginChat: vi.fn(),
      })
    )
    expect(html).toContain('routine-run-when whitespace-nowrap')

    const css = readFileSync(path.resolve(import.meta.dirname, '../../src/renderer/styles.css'), 'utf8')
    const match = css.match(/\.routine-run-item\s*\{[^}]*grid-template-columns:\s*(\d+)px\s+minmax\(0,\s*1fr\)\s+auto/)
    expect(match).not.toBeNull()
    expect(Number(match?.[1])).toBeGreaterThanOrEqual(156)
  })

  it('opens the agenda when the routines tab is selected and no routine view or run is open', async () => {
    const mod = await import('../../src/renderer/lib/routines/use-routines')
    expect(mod.shouldOpenRoutinesAgendaOnTab('routines', null, null)).toBe(true)
    expect(mod.shouldOpenRoutinesAgendaOnTab('routines', { kind: 'routine' }, null)).toBe(false)
    expect(mod.shouldOpenRoutinesAgendaOnTab('routines', null, 'run-1')).toBe(false)
    expect(mod.shouldOpenRoutinesAgendaOnTab('chats', null, null)).toBe(false)

    const desktopSrc = readFileSync(
      path.resolve(import.meta.dirname, '../../src/renderer/DesktopApp.tsx'),
      'utf8'
    )
    expect(desktopSrc).toContain('shouldOpenRoutinesAgendaOnTab(nextTab, nav.routinesView, activeRoutineRunId)')
    expect(desktopSrc).toContain("nav.openRoutinesView({ kind: 'agenda' })")
  })

  it('shows the chats-tab routine hint only when at least one routine exists and no search query is active', async () => {
    const mod = (await import('../../src/renderer/lib/routines/use-routines')) as {
      shouldShowChatsRoutineHint?: (query: string, routinesCount: number) => boolean
    }
    expect(mod.shouldShowChatsRoutineHint?.('', 0)).toBe(false)
    expect(mod.shouldShowChatsRoutineHint?.('', 1)).toBe(true)
    expect(mod.shouldShowChatsRoutineHint?.('lisboa', 2)).toBe(false)

    const sidebarSrc = readFileSync(
      path.resolve(import.meta.dirname, '../../src/renderer/components/Sidebar.tsx'),
      'utf8'
    )
    expect(sidebarSrc).toContain('shouldShowChatsRoutineHint(q, routines?.routines.length ?? 0)')
  })
})
