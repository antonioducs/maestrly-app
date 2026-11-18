import { createInstance } from 'i18next'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import ptBRChat from '../../src/shared/i18n/pt-BR/chat'
import ptBRRoutines from '../../src/shared/i18n/pt-BR/routines'
import ptBRUi from '../../src/shared/i18n/pt-BR/ui'
import type { ChatPermissionRequest, ChatRoutineRunMeta, MessagePart } from '../../src/shared/chat'
import type { Conversation } from '../../src/shared/conversation'
import type { LocalRoutine, LocalRoutineRun } from '../../src/shared/routines'

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

import { chatActivitySegments } from '../../src/renderer/lib/agent-activity'
import {
  inboxSourceCounts,
  parseInboxLedger,
  reconcileInbox,
  inboxItems,
} from '../../src/renderer/lib/inbox/inbox-model'
import { conversationObservations, routineObservations } from '../../src/renderer/lib/inbox/inbox-sources'
import { PermissionPrompt } from '../../src/renderer/components/chat/PermissionPrompt'
import { RoutineReportCardBody } from '../../src/renderer/components/routines/RoutineReportCard'
import { RoutineRunFailureCard } from '../../src/renderer/components/routines/RoutineRunFailureCard'
import { RoutineRunGoneView } from '../../src/renderer/components/routines/RoutineRunGoneView'
import { RoutineRunHeader } from '../../src/renderer/components/routines/RoutineRunHeader'
import { RoutineRunTrigger } from '../../src/renderer/components/routines/RoutineRunTrigger'

const T0 = Date.UTC(2026, 10, 18, 11, 0, 0)

function makeRoutine(overrides: Partial<LocalRoutine> = {}): LocalRoutine {
  return {
    id: 'routine-1',
    title: 'Preço da passagem GRU → LIS',
    instruction: 'Abra o Google Voos e compare o menor preço.',
    schedule: { kind: 'weekly', time: '08:00', days: [], timezone: 'America/Sao_Paulo' },
    enabled: true,
    pausedAt: null,
    permMode: 'auto',
    model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-6', reasoning: 'medium', fastMode: false },
    notify: 'notable',
    missed: 'catchup',
    retentionDays: 30,
    origin: null,
    folder: '/tmp/routines/routine-1',
    nextRunAt: T0 + 86_400_000,
    createdAt: T0 - 86_400_000,
    updatedAt: T0 - 86_400_000,
    ...overrides,
  }
}

function makeRun(overrides: Partial<LocalRoutineRun> = {}): LocalRoutineRun {
  return {
    id: 'run-1',
    routineId: 'routine-1',
    scheduledAt: T0,
    startedAt: T0 + 2_000,
    finishedAt: T0 + 45_000,
    trigger: 'schedule',
    status: 'notable',
    summary: 'Menor preço R$ 3.870 na TAP.',
    report: {
      outcome: 'notable',
      summary: 'Consultou Google Voos e Decolar.',
      pending: null,
      notes: 'Último menor preço: R$ 3.870.',
    },
    error: null,
    conversationId: 'conv-run-1',
    conversationDeleted: false,
    pinned: false,
    unread: true,
    ...overrides,
  }
}

describe('Phase 10 routine run conversation components', () => {
  it('keeps routine_run_report pinned outside collapsed agent activity', () => {
    const parts: MessagePart[] = [
      {
        type: 'tool',
        id: 'p1',
        toolCallId: 't1',
        toolName: 'bash',
        input: { command: 'ls' },
        state: { status: 'completed', output: 'ok' },
      },
      {
        type: 'tool',
        id: 'p2',
        toolCallId: 't2',
        toolName: 'routine_run_report',
        input: { outcome: 'notable', summary: 'Caiu para R$ 3.870.' },
        state: { status: 'completed', output: 'Run report saved.' },
      },
    ]

    const segments = chatActivitySegments(parts, false)
    expect(segments.map((s) => s.kind)).toEqual(['part', 'activity'])
    const pinnedPart = segments[0]
    expect(pinnedPart.kind).toBe('part')
    if (pinnedPart.kind === 'part' && pinnedPart.part.type === 'tool') {
      expect(pinnedPart.part.toolName).toBe('routine_run_report')
    }
  })

  it('renders RoutineRunHeader with breadcrumbs, kept chip, stop button when running', () => {
    const routine = makeRoutine()
    const runningRun = makeRun({ status: 'running', pinned: true, finishedAt: null })
    const html = renderToStaticMarkup(
      createElement(RoutineRunHeader, {
        routine,
        run: runningRun,
        onOpenAgenda: () => {},
        onOpenRoutine: () => {},
        onStop: () => {},
        onTogglePin: () => {},
        onDeleteConversation: () => {},
      })
    )
    expect(html).toContain('Rotinas')
    expect(html).toContain(routine.title)
    expect(html).toContain('Rodando')
    expect(html).toContain('Mantida')
    expect(html).toContain('Parar')

    const finishedHtml = renderToStaticMarkup(
      createElement(RoutineRunHeader, {
        routine,
        run: makeRun({ status: 'done', pinned: false }),
        onOpenAgenda: () => {},
        onOpenRoutine: () => {},
        onStop: () => {},
        onTogglePin: () => {},
        onDeleteConversation: () => {},
      })
    )
    expect(finishedHtml).not.toContain('Mantida')
    expect(finishedHtml).not.toContain('>Parar<')
  })

  it('renders RoutineRunTrigger for scheduled, manual, and late runs', () => {
    const scheduledMeta: ChatRoutineRunMeta = {
      routineId: 'routine-1',
      runId: 'run-1',
      title: 'Preço da passagem GRU → LIS',
      instruction: 'Confira o menor preço para 12–26 de março.',
      schedule: { kind: 'weekly', time: '08:00', days: [], timezone: 'America/Sao_Paulo' },
      trigger: 'schedule',
      scheduledAt: T0,
      startedAt: T0,
      hasPreviousReport: true,
    }
    const scheduledHtml = renderToStaticMarkup(createElement(RoutineRunTrigger, { meta: scheduledMeta }))
    expect(scheduledHtml).toContain('Rotina')
    expect(scheduledHtml).toContain('08:00 · todos os dias')
    expect(scheduledHtml).toContain('Ver instrução')
    expect(scheduledHtml).toContain('Confira o menor preço para 12–26 de março.')
    expect(scheduledHtml).toContain('Recebeu o relatório da execução anterior')

    const lateManualHtml = renderToStaticMarkup(
      createElement(RoutineRunTrigger, {
        meta: {
          ...scheduledMeta,
          trigger: 'late',
          startedAt: Date.UTC(2026, 10, 18, 13, 42, 0),
          hasPreviousReport: true,
        },
      })
    )
    expect(lateManualHtml).toContain('quando o computador acordou')

    const manualFirstHtml = renderToStaticMarkup(
      createElement(RoutineRunTrigger, {
        meta: {
          ...scheduledMeta,
          trigger: 'manual',
          hasPreviousReport: false,
        },
      })
    )
    expect(manualFirstHtml).toContain('Executada agora por você')
    expect(manualFirstHtml).not.toContain('Recebeu o relatório da execução anterior')
  })

  it('renders RoutineReportCardBody with optional pending and notes fields', () => {
    const html = renderToStaticMarkup(
      createElement(RoutineReportCardBody, {
        outcome: 'notable',
        summary: 'Consultou Google Voos e Decolar.',
        pending: 'Confirmar taxa de bagagem.',
        notes: 'Último menor preço: R$ 3.870.',
      })
    )
    expect(html).toContain('Relatório da execução')
    expect(html).toContain('Novidade')
    expect(html).toContain('Fez')
    expect(html).toContain('Consultou Google Voos e Decolar.')
    expect(html).toContain('Pendente')
    expect(html).toContain('Confirmar taxa de bagagem.')
    expect(html).toContain('Notas para a próxima')
    expect(html).toContain('Último menor preço: R$ 3.870.')
    expect(html).toContain('A próxima execução recebe este relatório.')

    const minimalHtml = renderToStaticMarkup(
      createElement(RoutineReportCardBody, {
        outcome: 'nothing_new',
        summary: 'Tudo igual.',
        pending: null,
        notes: null,
      })
    )
    expect(minimalHtml).toContain('Nada novo')
    expect(minimalHtml).not.toContain('>Pendente<')
    expect(minimalHtml).not.toContain('Notas para a próxima')
  })

  it('renders RoutineRunFailureCard with switch model and run again actions', () => {
    const html = renderToStaticMarkup(
      createElement(RoutineRunFailureCard, {
        error: 'Erro 429 no provedor.',
        onSwitchModel: () => {},
        onRunAgain: () => {},
      })
    )
    expect(html).toContain('A execução falhou')
    expect(html).toContain('Erro 429 no provedor.')
    expect(html).toContain('Trocar o modelo da rotina')
    expect(html).toContain('Executar de novo')
  })

  it('renders RoutineRunGoneView for deleted conversations and skipped runs', () => {
    const routine = makeRoutine()
    const deletedHtml = renderToStaticMarkup(
      createElement(RoutineRunGoneView, {
        routine,
        run: makeRun({ conversationDeleted: true, status: 'done' }),
        onOpenAgenda: () => {},
        onOpenRoutine: () => {},
      })
    )
    expect(deletedHtml).toContain('Conversa apagada')
    expect(deletedHtml).toContain('O relatório continua no histórico da rotina')
    expect(deletedHtml).toContain('Abrir rotina')

    const skippedHtml = renderToStaticMarkup(
      createElement(RoutineRunGoneView, {
        routine,
        run: makeRun({ status: 'skipped_asleep', conversationId: null, summary: 'Pulada porque o computador dormia.' }),
        onOpenAgenda: () => {},
        onOpenRoutine: () => {},
      })
    )
    expect(skippedHtml).toContain('Pulada: computador dormindo')
    expect(skippedHtml).toContain('Pulada porque o computador dormia.')
    expect(skippedHtml).toContain('Abrir rotina')
  })

  it('renders routine-specific wording and waiting note in PermissionPrompt', () => {
    const request = {
      id: 'req-1',
      title: 'bash pede aprovação',
      resources: [],
      allowAlways: true,
    } as unknown as ChatPermissionRequest

    const html = renderToStaticMarkup(
      createElement(PermissionPrompt, {
        request,
        scope: 'routine',
        routineWaitingSince: T0,
        onDecide: () => {},
      })
    )
    expect(html).toContain('Sempre permitir nesta rotina')
    expect(html).toContain('A execução está pausada desde')
    expect(html).toContain('o próximo horário é pulado')
  })
})

describe('Phase 10 inbox routine integration', () => {
  const place = { key: 'host:local', label: 'Este computador' }
  const tRoutines = ((key: string, opts?: Record<string, unknown>) =>
    i18nInstance.t(key, { ns: 'routines', ...opts })) as unknown as Parameters<typeof routineObservations>[3]

  it('maps routine runs into inbox observations and skips routine conversations from chat observations', () => {
    const routine = makeRoutine()
    const waitingRun = makeRun({
      id: 'run-wait',
      status: 'waiting',
      unread: true,
      conversationId: 'conv-wait',
      startedAt: T0 + 50_000,
      finishedAt: null,
      waiting: { kind: 'approval', prompt: 'Apagar 3 arquivos' },
    })
    const questionRun = makeRun({
      id: 'run-ask',
      status: 'waiting',
      unread: true,
      conversationId: 'conv-ask',
      startedAt: T0 + 55_000,
      finishedAt: null,
      waiting: { kind: 'question', prompt: 'Qual ambiente?' },
    })
    const failedRun = makeRun({ id: 'run-fail', status: 'failed', unread: true, error: 'Erro 429', summary: null })
    const notableRun = makeRun({ id: 'run-notable', status: 'notable', unread: true })
    const oldReadRun = makeRun({ id: 'run-old', status: 'done', unread: false })

    const obs = routineObservations(
      [routine],
      { [routine.id]: [waitingRun, questionRun, failedRun, notableRun, oldReadRun] },
      place,
      tRoutines
    )

    expect(obs).toHaveLength(5)
    expect(obs[0].active).toEqual({ kind: 'approval', unread: true })
    expect(obs[0].view.summary).toBe('Precisa da sua aprovação para continuar')
    expect(obs[0].view.source).toBe('routine')
    expect(obs[0].view.target).toEqual({
      kind: 'routine-run',
      routineId: routine.id,
      runId: 'run-wait',
      conversationId: 'conv-wait',
    })
    expect(obs[1].active).toEqual({ kind: 'question', unread: true })
    expect(obs[1].view.summary).toBe('Fez uma pergunta')
    expect(obs[2].active).toEqual({ kind: 'error', unread: true })
    expect(obs[3].active).toEqual({ kind: 'finished', unread: true })
    expect(obs[4].active).toBeNull()

    const ledger = reconcileInbox({}, obs, T0 + 60_000)
    const items = inboxItems(ledger, obs, T0 + 60_000)
    expect(items.map((i) => i.group)).toEqual(['waiting', 'waiting', 'new', 'new'])
    expect(inboxSourceCounts(items)).toMatchObject({ all: 4, routine: 4, workspace: 0, chat: 0, bot: 0 })

    const serialized = JSON.stringify(ledger)
    expect(Object.keys(parseInboxLedger(serialized))).toEqual(Object.keys(ledger))

    const convs: Conversation[] = [
      {
        id: 'conv-chat',
        scope: 'standalone',
        workspaceId: null,
        name: 'Chat normal',
        cwd: '/tmp',
        branch: null,
        mode: null,
        experience: 'standard',
        isMulti: 0,
        status: 'ready',
        archived: 0,
        pinnedAt: null,
        createdAt: T0,
        lastActivityAt: T0,
      },
      {
        id: 'conv-run-1',
        scope: 'standalone',
        workspaceId: null,
        name: 'Execução da rotina',
        cwd: '/tmp',
        branch: null,
        mode: null,
        experience: 'standard',
        isMulti: 0,
        status: 'ready',
        archived: 0,
        pinnedAt: null,
        createdAt: T0,
        lastActivityAt: T0,
        routineId: 'routine-1',
        routineRunId: 'run-1',
      },
    ]
    const convObs = conversationObservations(
      convs.map((conversation) => ({ conversation, place })),
      { statuses: {}, attention: new Set(['conv-chat', 'conv-run-1']), pendingPlanIds: new Set(), liveAt: {} }
    )
    expect(convObs.map((c) => c.key)).toEqual(['conversation:conv-chat'])
  })
})
