import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { planDecisionError } from '../../src/renderer/lib/plan-decision'

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

describe('plan decision failure in the renderer', () => {
  it('keeps IPC errors visible and allows another attempt', () => {
    expect(planDecisionError({ ok: false, error: 'plan-review-unavailable' })).toBe('plan-review-unavailable')
    expect(planDecisionError({ ok: false })).toBe('plan-decision-failed')
    expect(planDecisionError({ ok: true })).toBeNull()
    expect(planDecisionError(undefined)).toBeNull()
  })

  it('the tab waits for the actual IPC response and displays the retry path', () => {
    const host = source('src/renderer/panel.tsx')
    const panel = source('src/renderer/components/PlanPanel.tsx')

    expect(host).toContain('onDecide={(d) => window.api.decidePlan(conv, d)}')
    expect(host).not.toContain('onDecide={(d) => void window.api.decidePlan(conv, d)}')
    expect(panel).toContain('setBusy(false)')
    expect(panel).toContain("t('panel.planDecisionFailed', { error: decisionError })")
  })

  it('offers approval in a Maestro conversation alongside traditional approval', () => {
    const panel = source('src/renderer/components/PlanPanel.tsx')
    const picker = source('src/renderer/components/MaestroPlanProfileDialog.tsx')
    const ptBR = source('src/shared/i18n/pt-BR/ui.ts')
    const en = source('src/shared/i18n/en/ui.ts')

    expect(panel).toContain("implementationTarget: 'maestro'")
    expect(panel).toContain('maestroStrategyProfileId: profileId')
    expect(panel).toContain("t('plan.implementWithMaestro')")
    expect(panel).toContain('setMaestroProfileOpen(true)')
    expect(picker).toContain('<SearchSelect')
    expect(picker).toContain('chatMaestroStrategyProfilesList()')
    expect(picker).toContain('next.lastUsedId')
    expect(panel).toContain("decide({ action: 'approve', editedPlan: edited ? text : undefined })")
    expect(ptBR).toContain("implementWithMaestro: 'Implementar com Maestro'")
    expect(en).toContain("implementWithMaestro: 'Implement with Maestro'")
  })

  it('offers implementation in a new Standard conversation with only supported settings', () => {
    const panel = source('src/renderer/components/PlanPanel.tsx')
    const dialog = source('src/renderer/components/StandardPlanHandoffDialog.tsx')
    const ptBR = source('src/shared/i18n/pt-BR/ui.ts')
    const en = source('src/shared/i18n/en/ui.ts')

    expect(panel).toContain("implementationTarget: 'standard'")
    expect(panel).toContain('standardHandoff,')
    expect(panel).toContain('sourceConversationId={plan.agentId}')
    expect(panel).toContain('setStandardHandoffOpen(true)')
    expect(panel).toContain("t('plan.implementInNewConversation')")
    // Reuses the composer's controlled pickers instead of a native <select>.
    expect(dialog).toContain('<ChatModelChip')
    expect(dialog).toContain('<ChatReasoningPicker')
    expect(dialog).toContain('<FastModeChip')
    expect(dialog).not.toContain('<select')
    // Starts from the source settings without writing them back.
    expect(dialog).toContain('window.api.chatGetSelection(sourceConversationId)')
    expect(dialog).not.toMatch(/chatSet(Selection|Reasoning|FastMode|Mode)/)
    // Late metadata for a previous model can neither unlock submission nor show stale choices.
    expect(dialog).toContain('metaGeneration.current === generation')
    expect(dialog).toContain("const metaReady = !!selection && meta?.key === currentKey")
    expect(dialog).toContain('fastMode: fastAvailable && fastMode')
    expect(dialog).toContain('role="radiogroup"')
    expect(dialog).toContain('onOpenChange={(next) => !busy && onOpenChange(next)}')
    expect(en).toContain("implementInNewConversation: 'Implement in new conversation'")
    expect(ptBR).toContain("implementInNewConversation: 'Implementar em nova conversa'")
    for (const catalog of [en, ptBR]) {
      for (const key of ['placementShared', 'placementWorktree', 'fastUnavailable', 'start', 'cancel']) {
        expect(catalog).toContain(`${key}:`)
      }
    }
  })

  it('shows dispatched conversations, their origin and a retry for a failed first turn', () => {
    const list = source('src/renderer/components/chat/ChatMessageList.tsx')
    const card = source('src/renderer/components/chat/ConversationDispatchCard.tsx')
    const banner = source('src/renderer/components/chat/ConversationDispatchBanner.tsx')
    const view = source('src/renderer/components/chat/ChatView.tsx')
    const panels = source('src/renderer/lib/use-main-panels.ts')

    expect(list).toContain("toolPart.toolName === 'start_conversations'")
    expect(list).toContain("message.source === 'conversation-dispatch'")
    expect(card).toContain('parseConversationDispatchBatchResult')
    expect(card).toContain("new CustomEvent('maestrly:open-conversation'")
    expect(panels).toContain("window.addEventListener('maestrly:open-conversation', listener)")
    expect(view).toContain('<ConversationDispatchBanner conversationId={conversationId} />')
    expect(banner).toContain("status?.phase !== 'start-failed'")
    expect(banner).toContain('window.api.retryConversationDispatch(conversationId)')
    expect(banner).toContain('window.api.onConversationDispatchChanged(')
  })
})
