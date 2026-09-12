import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import en from '../../src/shared/i18n/en/chat'
import ptBR from '../../src/shared/i18n/pt-BR/chat'

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

describe('subagent profile conversation UI contract', () => {
  it('distinguishes synthetic Maestrly Ultra from native provider Ultra', () => {
    expect(ptBR.reasoning.maestrlyUltra).toContain('sintético')
    expect(ptBR.reasoning.ultraDesc).toContain('não o Ultra nativo')
    expect(en.reasoning.maestrlyUltra).toContain('synthetic')
    expect(en.reasoning.ultraDesc).toContain("not the provider's native Ultra")
  })

  it('separates menu toggles from editor opening', () => {
    const menu = source('src/renderer/components/chat/ChatPlusMenu.tsx')
    expect(menu).toContain('chatSubagentProfilesGetConversation(targetConversationId)')
    expect(menu).toContain('chatSubagentProfilesSetConversationEnabled(targetConversationId, next)')
    expect(menu).toContain('chatSubagentsSetConversationEnabled(targetConversationId, next)')
    expect(menu).toContain('conversationIdRef.current !== targetConversationId')
    expect(menu).toContain('subagentProfilesRevisionRef.current !== profilesRevision')
    expect(menu).toContain("onClick={() => setActivePanel('subagents')}")
    expect(menu).toContain('onClick={toggleSubagentProfiles}')
    expect(menu).toContain('onClick={toggleSubagents}')
    expect(menu).toContain('setSubagentProfilesEnabled(result.ok ? result.value.enabled : previous)')
    expect(menu).toContain('setSubagentsEnabled(result.ok ? result.value.subagentsEnabled : previous)')
    expect(ptBR.plusMenu.subagentsDisabled).toContain('desativada')
    expect(en.plusMenu.subagentsDisabled).toContain('disabled')
  })

  it('keeps saved inactive rules editable with clear status', () => {
    const modal = source('src/renderer/components/chat/subagent-profiles/ConversationSubagentProfiles.tsx')
    expect(modal).toContain('payload?.enabled === false')
    expect(modal).toContain("t('subagentProfiles.conversationDisabled')")
    expect(modal).toContain('<SubagentProfileRulesEditor')
    expect(ptBR.subagentProfiles.conversationDisabled).toContain('continuam salvas')
    expect(en.subagentProfiles.conversationDisabled).toContain('remain saved')
  })

  it('keeps unavailable Fable accessible without allowing activation', () => {
    const editor = source('src/renderer/components/chat/subagent-profiles/SubagentProfileRulesEditor.tsx')
    const fields = source('src/renderer/components/chat/subagent-profiles/CandidateFields.tsx')
    const select = source('src/renderer/components/ui/search-select.tsx')
    expect(fields).toContain("modelCatalogStatus === 'available'")
    expect(fields).toContain('chatSubagentProfilesModelCatalog(candidate.providerId)')
    expect(editor).toContain('onChatSubscriptionStatus(provider')
    expect(editor).toContain('setCatalogRevision((revision) => revision + 1)')
    expect(fields).toContain('[candidate.providerId, catalogRevision, config]')
    expect(fields).toContain('[candidate.providerId, candidate.modelId, catalogRevision, config]')
    expect(editor).toContain('[rules, catalogRevision, config]')
    expect(fields).toContain('isUnavailableClaudeFable(candidate.providerId')
    expect(editor).toContain('isUnavailableClaudeFable(candidate.providerId')
    expect(fields).toContain("t('subagentProfiles.modelUnavailable')")
    expect(select).toContain('aria-disabled={item.disabled || undefined}')
    expect(select).toContain('options.find((option) => option.id === id)?.disabled')
    expect(select).not.toContain('disabled={item.disabled}')
    expect(ptBR.subagentProfiles.diagnostics['model-unavailable']).toContain('não está disponível')
    expect(en.subagentProfiles.diagnostics['model-unavailable']).toContain('not available')
  })

  it('offers only verified Fast and clears incompatible state', () => {
    const fields = source('src/renderer/components/chat/subagent-profiles/CandidateFields.tsx')
    expect(fields).toContain('modelMeta.meta?.fastModeCapability === true')
    expect(fields).toContain('aria-pressed={candidate.fastMode === true}')
    expect(fields).toContain('changeSubagentProfileFastMode(candidate, false)')
    expect(fields).toContain("t('subagentProfiles.standardMode')")
    expect(ptBR.subagentProfiles.diagnostics['fast-mode-unsupported']).toContain('não é suportado')
    expect(en.subagentProfiles.diagnostics['fast-mode-unverified']).toContain('metadata')
  })

  it('shares candidate fields across profile editors and Maestro pools', () => {
    const editor = source('src/renderer/components/chat/subagent-profiles/SubagentProfileRulesEditor.tsx')
    const maestro = source('src/renderer/components/chat/MaestroControl.tsx')
    expect(editor).toContain("import { CandidateFields } from './CandidateFields'")
    expect(editor).toContain('<CandidateFields')
    expect(maestro).toContain('<CandidateFields')
    // Shared extraction must not leave divergent selector copies.
    expect(editor).not.toContain('function CandidateEditor(')
    expect(editor).not.toContain('<SearchSelect\n        value={candidate.providerId')
  })
})
