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
})
