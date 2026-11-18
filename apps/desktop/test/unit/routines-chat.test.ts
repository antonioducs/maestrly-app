import { createInstance } from 'i18next'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import ptBRChat from '../../src/shared/i18n/pt-BR/chat'
import ptBRPlugins from '../../src/shared/i18n/pt-BR/plugins'
import ptBRRoutines from '../../src/shared/i18n/pt-BR/routines'
import ptBRUi from '../../src/shared/i18n/pt-BR/ui'
import type { ChatComposerSource } from '../../src/renderer/components/chat/chat-composer-source'
import type { ChatMessage } from '../../src/shared/chat'
import type { LocalRoutine, LocalRoutineRun, RoutineProposal } from '../../src/shared/routines'

const i18nInstance = createInstance()
void i18nInstance.init({
  lng: 'pt-BR',
  resources: {
    'pt-BR': {
      routines: ptBRRoutines,
      chat: ptBRChat,
      ui: ptBRUi,
      plugins: ptBRPlugins,
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

vi.mock('../../src/renderer/lib/chat-window-context', () => ({
  useChatDocument: () => ({
    addEventListener: () => {},
    removeEventListener: () => {},
  }),
  useChatOwnerWindow: () => ({
    innerWidth: 1200,
    innerHeight: 800,
    api: { platformInfo: { os: 'linux' } },
  }),
  useChatSourceFocus: () => () => {},
}))

vi.mock('../../src/renderer/lib/hosts/host-context', () => {
  const mockApi = {
    chatConfig: async () => ({ mcpServers: [], appToolsEnabled: true, imageGenEnabled: true }),
    chatGetConvTools: async () => ({ app: true, mcpDisabled: [], imageGen: true }),
    chatSubagentProfilesGetConversation: async () => ({ enabled: true, subagentsEnabled: true, profiles: [] }),
  }
  return {
    useHostApi: () => mockApi,
    useHostId: () => 'local',
    hostApi: () => mockApi,
  }
})

import { chatActivitySegments } from '../../src/renderer/lib/agent-activity'
import { ChatPlusMenu } from '../../src/renderer/components/chat/ChatPlusMenu'
import {
  RoutineCreatedNotice,
  RoutineProposalCardBody,
  interleaveChatMenuRoutines,
  parseRoutineProposeOutput,
} from '../../src/renderer/components/routines/RoutineProposalCard'

function makeProposal(overrides: Partial<RoutineProposal> = {}): RoutineProposal {
  return {
    id: 'rprop-1',
    conversationId: 'c-lisboa',
    draft: {
      title: 'Preço GRU → LIS em março',
      instruction: 'Confira no Google Voos.',
      schedule: { kind: 'weekly', time: '08:00', days: [], timezone: 'America/Sao_Paulo' },
      permMode: 'auto',
      model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-6', reasoning: 'medium', fastMode: false },
      notify: 'notable',
      missed: 'catchup',
      retentionDays: 30,
    },
    state: 'pending',
    routineId: null,
    createdAt: 1_700_000_000_000,
    ...overrides,
  }
}

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
    createdAt: 1_700_000_100_000,
    updatedAt: 1_700_000_100_000,
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
    finishedAt: now - 3_540_000,
    trigger: 'schedule',
    status: 'notable',
    summary: 'GRU → LIS caiu para R$ 3.180.',
    report: null,
    error: null,
    conversationId: 'c-run-1',
    conversationDeleted: false,
    pinned: false,
    unread: false,
    ...overrides,
  }
}

const noop = () => {}

describe('chat routine activity and output parsing', () => {
  it('pins routine_propose outside the compact agent activity group', () => {
    const segs = chatActivitySegments(
      [
        {
          type: 'tool',
          id: 'p1',
          toolCallId: 't1',
          toolName: 'read',
          input: { path: 'a.txt' },
          state: { status: 'completed', output: 'ok' },
        },
        {
          type: 'tool',
          id: 'p2',
          toolCallId: 't2',
          toolName: 'mcp__maestrly__routine_propose',
          input: {},
          state: { status: 'completed', output: 'Proposal rprop-1 created.' },
        },
      ],
      false
    )
    expect(segs.map((s) => s.kind)).toEqual(['part', 'activity'])
    const pinned = segs[0]
    expect(pinned.kind === 'part' && pinned.part.type === 'tool' && pinned.part.toolName).toBe(
      'mcp__maestrly__routine_propose'
    )
  })

  it('extracts proposalId from both model-text and JSON tool outputs', () => {
    expect(
      parseRoutineProposeOutput(
        'Proposal prop-abc123 created. The routine does NOT exist yet: the person creates, adjusts or discards it.'
      )
    ).toBe('prop-abc123')
    expect(parseRoutineProposeOutput(JSON.stringify({ ok: true, proposalId: 'prop-json-1' }))).toBe('prop-json-1')
    expect(parseRoutineProposeOutput('Could not create routine proposal: invalid')).toBeNull()
    expect(parseRoutineProposeOutput(JSON.stringify({ ok: false, error: 'nope' }))).toBeNull()
  })
})

describe('RoutineProposalCardBody', () => {
  it('renders pending proposal with facts, expandable long instruction, background warning, and actions', () => {
    const proposal = makeProposal({
      draft: {
        ...makeProposal().draft,
        instruction: 'Linha 1 com detalhes completos\nLinha 2 da instrução para expandir.',
        permMode: 'full',
      },
    })
    const html = renderToStaticMarkup(
      createElement(RoutineProposalCardBody, {
        proposal,
        routine: null,
        lastRun: null,
        backgroundEnabled: false,
        modelInfo: { name: 'Sonnet 4.6', providerName: 'Anthropic' },
        onEnableBackground: noop,
        onCreate: noop,
        onAdjust: noop,
        onDiscard: noop,
        onRestore: noop,
        onOpenRoutine: noop,
      })
    )
    expect(html).toContain('08:00')
    expect(html).toContain('todos os dias')
    expect(html).toContain('Nova rotina · aguardando você')
    expect(html).toContain('Preço GRU → LIS em março')
    expect(html).toContain('Horário fixo · 08:00 · todos os dias · America/Sao_Paulo')
    expect(html).toContain('Próximas')
    expect(html).toContain('Instrução')
    expect(html).toContain('Ver tudo')
    expect(html).toContain('Permissões')
    expect(html).toContain('Acesso completo')
    expect(html).toContain('Hoje o Maestrly fecha junto com a janela.')
    expect(html).toContain('Ativar')
    expect(html).toContain('Criar rotina')
    expect(html).toContain('Ajustar…')
    expect(html).toContain('Descartar')
    expect(html).toContain('Roda neste computador. Nada roda antes de você criar.')
  })

  it('renders read-only notice on remote hosts instead of mutation actions', () => {
    const html = renderToStaticMarkup(
      createElement(RoutineProposalCardBody, {
        proposal: makeProposal(),
        routine: null,
        lastRun: null,
        backgroundEnabled: true,
        readOnly: true,
        modelInfo: { name: 'Sonnet 4.6', providerName: 'Anthropic' },
        onEnableBackground: noop,
        onCreate: noop,
        onAdjust: noop,
        onDiscard: noop,
        onRestore: noop,
        onOpenRoutine: noop,
      })
    )
    expect(html).not.toContain('Criar rotina')
    expect(html).toContain('gerenciada lá')
  })

  it('renders created state, created via + menu notice, discarded state with undo, and deleted placeholder', () => {
    const routine = makeRoutine()
    const createdHtml = renderToStaticMarkup(
      createElement(RoutineProposalCardBody, {
        proposal: makeProposal({ state: 'created', routineId: routine.id }),
        routine,
        lastRun: makeRun(),
        backgroundEnabled: true,
        modelInfo: { name: 'Sonnet 4.6', providerName: 'Anthropic' },
        onEnableBackground: noop,
        onCreate: noop,
        onAdjust: noop,
        onDiscard: noop,
        onRestore: noop,
        onOpenRoutine: noop,
      })
    )
    expect(createdHtml).toContain('Rotina criada')
    expect(createdHtml).toContain('Próxima:')
    expect(createdHtml).toContain('Última:')
    expect(createdHtml).toContain('Abrir rotina')

    const menuNoticeHtml = renderToStaticMarkup(
      createElement(RoutineCreatedNotice, {
        routine: makeRoutine({ origin: { conversationId: 'c-lisboa', title: 'Chat', via: 'menu' } }),
        lastRun: null,
        modelInfo: { name: 'Sonnet 4.6', providerName: 'Anthropic' },
        onOpenRoutine: noop,
      })
    )
    expect(menuNoticeHtml).toContain('Rotina criada pelo menu +')
    expect(menuNoticeHtml).toContain('Abrir rotina')

    const discardedHtml = renderToStaticMarkup(
      createElement(RoutineProposalCardBody, {
        proposal: makeProposal({ state: 'discarded' }),
        routine: null,
        lastRun: null,
        backgroundEnabled: true,
        modelInfo: { name: 'Sonnet 4.6', providerName: 'Anthropic' },
        onEnableBackground: noop,
        onCreate: noop,
        onAdjust: noop,
        onDiscard: noop,
        onRestore: noop,
        onOpenRoutine: noop,
      })
    )
    expect(discardedHtml).toContain('Rotina descartada: Preço GRU → LIS em março')
    expect(discardedHtml).toContain('Desfazer')

    const deletedHtml = renderToStaticMarkup(
      createElement(RoutineProposalCardBody, {
        proposal: makeProposal({ state: 'created', routineId: 'missing' }),
        routine: null,
        lastRun: null,
        backgroundEnabled: true,
        modelInfo: { name: 'Sonnet 4.6', providerName: 'Anthropic' },
        onEnableBackground: noop,
        onCreate: noop,
        onAdjust: noop,
        onDiscard: noop,
        onRestore: noop,
        onOpenRoutine: noop,
      })
    )
    expect(deletedHtml).toContain('Esta rotina foi excluída.')
  })

  it('interleaves menu-created routines chronologically with chat messages', () => {
    const m1 = { id: 'm1', conversationId: 'c1', role: 'user', parts: [], createdAt: 100 } as ChatMessage
    const m2 = { id: 'm2', conversationId: 'c1', role: 'assistant', parts: [], createdAt: 300 } as ChatMessage
    const rMenu = makeRoutine({ id: 'r-menu', createdAt: 200, origin: { conversationId: 'c1', title: 'Chat', via: 'menu' } })
    const items = interleaveChatMenuRoutines([m1, m2], [rMenu])
    expect(items.map((x) => (x.kind === 'message' ? x.message.id : x.routine.id))).toEqual(['m1', 'r-menu', 'm2'])
  })

  it('renders Schedule as routine in ChatPlusMenu only for local non-bot chats when handler is provided', () => {
    const baseSource = {
      chatConfig: async () => ({ mcpServers: [], appToolsEnabled: true, imageGenEnabled: true }),
      chatGetConvTools: async () => ({ app: true, mcpDisabled: [], imageGen: true }),
      chatSetConvTools: async () => {},
      chatSubagentProfilesGetConversation: async () => ({ enabled: true, subagentsEnabled: true, profiles: [] }),
      chatSubagentProfilesSetConversationEnabled: async () => ({ ok: true as const, value: { enabled: true } }),
      chatSubagentsSetConversationEnabled: async () => ({ ok: true as const, value: { subagentsEnabled: true } }),
    } as unknown as ChatComposerSource
    const localHtml = renderToStaticMarkup(
      createElement(ChatPlusMenu, {
        conversationId: 'c1',
        mode: 'agent',
        onAddFiles: noop,
        fontScale: 1,
        onFontScale: noop,
        source: baseSource,
        onScheduleRoutine: noop,
        initialOpenPanel: 'menu',
      })
    )
    expect(localHtml).toContain('Agendar como rotina…')
    expect(localHtml).toContain('Usa o texto da mensagem como instrução')

    const botSource = {
      ...baseSource,
      bot: {
        listSelections: async () => [],
        updateSelection: async () => ({}) as never,
        ceiling: 'auto',
        setCeiling: async () => ({}) as never,
        manage: async () => {},
      },
    } as unknown as ChatComposerSource
    const botHtml = renderToStaticMarkup(
      createElement(ChatPlusMenu, {
        conversationId: 'c1',
        mode: 'agent',
        onAddFiles: noop,
        fontScale: 1,
        onFontScale: noop,
        source: botSource,
        onScheduleRoutine: noop,
        initialOpenPanel: 'menu',
      })
    )
    expect(botHtml).not.toContain('Agendar como rotina…')
  })
})
