import { readFileSync } from 'node:fs'
import { createInstance } from 'i18next'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import ptBRChat from '../../src/shared/i18n/pt-BR/chat'
import ptBRRoutines from '../../src/shared/i18n/pt-BR/routines'
import ptBRUi from '../../src/shared/i18n/pt-BR/ui'
import type { LocalRoutine, RoutineDraft, RoutineSavedPermission } from '../../src/shared/routines'

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

import { RoutineEditorDialog, RoutineEditorFormBody } from '../../src/renderer/components/routines/RoutineEditorDialog'

const noop = () => {}

const sampleDraft: RoutineDraft = {
  title: 'Preço GRU → LIS',
  instruction: 'Verifique passagem ida e volta para Lisboa em abril e avise se baixar de R$ 4.200.',
  schedule: { kind: 'weekly', time: '08:00', days: [1, 3, 5], timezone: 'America/Sao_Paulo' },
  permMode: 'auto',
  model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-6', reasoning: 'medium', fastMode: false },
  notify: 'notable',
  missed: 'catchup',
  retentionDays: 30,
}

const sampleRoutine: LocalRoutine = {
  id: 'routine-1',
  ...sampleDraft,
  enabled: true,
  origin: { conversationId: 'conv-origin', title: 'Viagem para Lisboa', via: 'proposal' },
  createdAt: Date.now() - 86_400_000,
  updatedAt: Date.now() - 3_600_000,
  nextRunAt: Date.now() + 3_600_000,
  pausedAt: null,
  folder: '/tmp/routines/routine-1',
}

const sampleSaved: RoutineSavedPermission[] = [
  { id: 'perm-1', scopeKey: 'bash:curl', action: 'bash', resource: 'curl' },
  { id: 'perm-2', scopeKey: 'dir:/tmp/reports', action: 'dir', resource: '/tmp/reports' },
]

describe('RoutineEditorDialog', () => {
  it('renders proposal, full perm risk warning, and saved permissions in edit mode', () => {
    expect(RoutineEditorDialog).toBeTypeOf('function')

    const proposalHtml = renderToStaticMarkup(
      createElement(RoutineEditorFormBody, {
        target: { kind: 'proposal', draft: sampleDraft, originTitle: 'Viagem para Lisboa', onConfirmDraft: noop },
        savedPermissions: [],
        onClose: noop,
        onSaveNew: async () => {},
        onSaveEdit: async () => {},
        onRemoveSavedPermission: noop,
      })
    )
    expect(proposalHtml).toContain('Ajustar a rotina proposta')
    expect(proposalHtml).toContain('Viagem para Lisboa')
    expect(proposalHtml).toContain('Criar rotina')
    expect(proposalHtml).toContain('Permissões')

    const fullHtml = renderToStaticMarkup(
      createElement(RoutineEditorFormBody, {
        target: { kind: 'edit', routine: { ...sampleRoutine, permMode: 'full' } },
        savedPermissions: sampleSaved,
        onClose: noop,
        onSaveNew: async () => {},
        onSaveEdit: async () => {},
        onRemoveSavedPermission: noop,
      })
    )
    expect(fullHtml).toContain('Editar rotina')
    expect(fullHtml).toContain('Salvar rotina')
    expect(fullHtml).toContain('routine-mode-note risk')
    expect(fullHtml).not.toContain('Sempre permitido nesta rotina')

    const autoEditHtml = renderToStaticMarkup(
      createElement(RoutineEditorFormBody, {
        target: { kind: 'edit', routine: sampleRoutine },
        savedPermissions: sampleSaved,
        onClose: noop,
        onSaveNew: async () => {},
        onSaveEdit: async () => {},
        onRemoveSavedPermission: noop,
      })
    )
    expect(autoEditHtml).toContain('Sempre permitido nesta rotina')
    expect(autoEditHtml).toContain('curl')
    expect(autoEditHtml).toContain('/tmp/reports')

    const foreverHtml = renderToStaticMarkup(
      createElement(RoutineEditorFormBody, {
        target: { kind: 'edit', routine: { ...sampleRoutine, retentionDays: null } },
        savedPermissions: [],
        onClose: noop,
        onSaveNew: async () => {},
        onSaveEdit: async () => {},
        onRemoveSavedPermission: noop,
      })
    )
    expect(foreverHtml).toContain('<option value="always" selected="">Sempre</option>')
  })

  it('closes model and reasoning popovers cleanly on Escape without dismissing outer dialog', () => {
    const modelChipSource = readFileSync(
      new URL('../../src/renderer/components/chat/ChatModelChip.tsx', import.meta.url),
      'utf8'
    )
    const reasoningSource = readFileSync(
      new URL('../../src/renderer/components/chat/ChatReasoningPicker.tsx', import.meta.url),
      'utf8'
    )
    expect(modelChipSource).toContain('stopPropagation()')
    expect(reasoningSource).toContain("e.key !== 'Escape'")
    expect(reasoningSource).toContain('stopPropagation()')
  })
})
