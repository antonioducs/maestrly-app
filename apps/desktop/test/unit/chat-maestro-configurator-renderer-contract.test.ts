import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import en from '../../src/shared/i18n/en/chat'
import ptBR from '../../src/shared/i18n/pt-BR/chat'

const source = (path: string) => readFileSync(path, 'utf8')

describe('Maestro configurator renderer contract', () => {
  it('keeps the assistant optional, resizable beside the Pool and over it when the Pool would get too narrow', () => {
    const settings = source('src/renderer/components/chat/MaestroSettings.tsx')
    expect(settings).toContain("import { MaestroConfigurator } from './MaestroConfigurator'")
    // Closed unless the user left it open last time on this computer.
    expect(settings).toContain("useState(() => readStored(ASSISTANT_OPEN_KEY) === 'true')")
    expect(settings).toContain('aria-expanded={assistantOpen}')
    expect(settings).toContain('aria-controls="maestro-configurator-panel"')
    expect(settings).toContain('role="separator"')
    expect(settings).toContain('onDoubleClick={() => onChange(clamp(ASSISTANT_DEFAULT_WIDTH))}')
    expect(settings).toContain('writeStored(ASSISTANT_WIDTH_KEY, String(assistantWidth))')
    expect(settings).toContain('workspaceWidth < ASSISTANT_MIN_WIDTH + POOL_MIN_WIDTH')
    // Over the Pool it steps aside during a review and never covers the review bar.
    expect(settings).toContain('setAssistantHidden(true)')
    expect(settings).toContain('{ bottom: 8 + reviewBarHeight }')
    expect(settings).toContain('draft={draft}')
    expect(settings).toContain('onReview={startReview}')
  })

  it('adopts the Settings surface instead of the chat-only dark block', () => {
    const settings = source('src/renderer/components/chat/MaestroSettings.tsx')
    const assistant = source('src/renderer/components/chat/MaestroConfigurator.tsx')
    expect(settings).toContain('rounded-lg border border-border bg-white/[0.02]')
    expect(settings).not.toContain('bg-[#0d0d10]')
    expect(assistant).toContain('rounded-lg border border-border bg-white/[0.02]')
    expect(assistant).not.toContain('bg-[#0d0d10]')
    // Use app typography rather than the dense modal scale.
    expect(assistant).not.toContain('text-[10px]')
    expect(assistant).not.toContain('text-[11px]')
  })

  it('puts the chat pills for model, reasoning and Fast in the assistant header', () => {
    const assistant = source('src/renderer/components/chat/MaestroConfigurator.tsx')
    const modelChip = source('src/renderer/components/chat/ChatModelChip.tsx')
    const reasoning = source('src/renderer/components/chat/ChatReasoningPicker.tsx')
    const fast = source('src/renderer/components/chat/ChatFastModeToggle.tsx')
    expect(assistant).toContain('<ChatModelChip')
    expect(assistant).toContain('<ChatReasoningPicker')
    expect(assistant).toContain('<FastModeChip')
    expect(assistant).not.toContain('<CandidateFields')
    // The global surface controls the model; this chip never persists a conversation setting.
    expect(modelChip).toContain('conversationId?: string')
    expect(modelChip).toContain('if (conversationId) api.chatGetSelection(conversationId)')
    expect(assistant).toContain('chatMaestroConfiguratorSetProfile(next)')
    // This surface has no delegation, so the synthetic Ultra mode is unavailable.
    expect(assistant).toContain('allowUltra={false}')
    expect(reasoning).toContain('allowUltra?: boolean')
    expect(reasoning).toContain('avoidOverflow?: boolean')
    // Fixed placement goes through the helper that also corrects for transformed ancestors such as dialogs.
    expect(reasoning).toContain('fixedPanelPlacement(root, {')
    expect(reasoning).toContain('const ownerWindow = useChatOwnerWindow()')
    expect(reasoning).toContain("ownerWindow.addEventListener('scroll', reposition, true)")
    expect(fast).toContain('export function FastModeChip')
    // Fast and reasoning appear only when the selected model advertises the capability.
    expect(assistant).toContain('profileMeta.meta?.fastModeCapability === true')
    expect(assistant).toContain('efforts.length > 0 && (')
    expect(assistant.indexOf('<ChatModelChip')).toBeLessThan(assistant.indexOf('</header>'))
    expect(assistant).toContain("t('maestro.configurator.modelLabel')")
  })

  it('guards stale proposals and reviews them in the Pool, never writing settings directly', () => {
    const assistant = source('src/renderer/components/chat/MaestroConfigurator.tsx')
    const settings = source('src/renderer/components/chat/MaestroSettings.tsx')
    // The renderer hashes the same normalized draft as the main process, so case or spacing never makes it stale.
    expect(assistant).toContain('prepareMaestroConfiguratorDraft(draft)')
    expect(assistant).toContain('stale={message.proposal.baseHash !== draftHash}')
    expect(assistant).not.toContain('hashMaestroConfig(draft)')
    expect(assistant).toContain('onReview={() => onReview(message.proposal!)}')
    // The thread decides what became of each proposal, so the card survives a reload.
    expect(assistant).toContain('maestroProposalOutcomes(messages)')
    expect(assistant).not.toContain('chatMaestroSetGlobal')
    expect(assistant).not.toContain('chatMaestroSetConversation')
    // A stale proposal is never laid over the Pool.
    expect(settings).toContain('if (!prepared.ok || prepared.value.baseHash !== proposal.baseHash) return')
  })

  it('applies only the parts of a proposal the user keeps, and tells the assistant what was left out', () => {
    const settings = source('src/renderer/components/chat/MaestroSettings.tsx')
    const pool = source('src/renderer/components/chat/MaestroPoolEditor.tsx')
    expect(settings).toContain('maestroProposalUnits(prepared.value.config, proposal.config)')
    expect(settings).toContain('applyMaestroProposalUnits({')
    expect(settings).toContain(
      "recordEvent({ kind: 'proposal-applied', proposalId: review.proposal.id, ...(skipped.length ? { skipped } : {}) })"
    )
    expect(settings).toContain("recordEvent({ kind: 'proposal-dismissed', proposalId: review.proposal.id })")
    expect(settings).toContain('toggleUnit(MAESTRO_PROPOSAL_STRATEGY_UNIT, event.target.checked)')
    // Nothing else can change the draft while a proposal is under review.
    expect(settings).toContain('disabled={reviewing}')
    expect(settings).toContain('disabled={busy || reviewing || !dirty || idIssues.length > 0}')
    expect(pool).toContain('data-maestro-review-bar')
    expect(pool).toContain("t('maestro.poolEditor.review.includeLabel', { label })")
    expect(pool).toContain('disabled={selectedCount === 0}')
  })

  it('edits the strategy as a field instead of opening built-in strategies, and never drops unsaved work silently', () => {
    const settings = source('src/renderer/components/chat/MaestroSettings.tsx')
    // Built-in strategies are the Global default with another strategy, so the editor never opens one.
    expect(settings).toContain("strategies.items.filter((item) => item.source !== 'builtin')")
    expect(settings).toContain('role="radiogroup"')
    expect(settings).toContain('setDraft({ ...draft, strategy })')
    expect(settings).not.toContain('editInGlobal')
    // Switching strategy or discarding asks first.
    expect(settings.match(/ownerWindow\.confirm\(t\('maestro\.confirmDiscard'\)\)/g)).toHaveLength(2)
    // The working state lives in the host while the app runs and is restored when the tab comes back.
    expect(settings).toContain('chatMaestroSettingsDraftGet()')
    expect(settings).toContain('.chatMaestroSettingsDraftSet({')
    expect(settings).toContain('if (!hydrated || !draft || !selectedProfile) return')
    // Editor actions reach the assistant thread.
    for (const kind of ['proposal-applied', 'proposal-dismissed', 'draft-discarded', 'saved', 'profile-selected']) {
      expect(settings).toContain(`kind: '${kind}'`)
    }
  })

  it('accepts pasted, dropped or picked images and renders editor events in the thread', () => {
    const assistant = source('src/renderer/components/chat/MaestroConfigurator.tsx')
    expect(assistant).toContain('onPaste=')
    expect(assistant).toContain('onDrop={onComposerDrop}')
    expect(assistant).toContain("accept={IMAGE_TYPES.join(',')}")
    expect(assistant).toContain("t('maestro.configurator.attachImage')")
    expect(assistant).toContain("message.role === 'event' && message.event")
    expect(assistant).toContain("if (event.kind === 'message')")
    expect(en.maestro.configurator.errorNoVision).toContain('image interpreter')
    expect(ptBR.maestro.configurator.errorNoVision).toContain('intérprete de imagens')
  })

  it('provides iterative chat, stop/reset, suggestions and localized accessible copy', () => {
    const assistant = source('src/renderer/components/chat/MaestroConfigurator.tsx')
    expect(assistant).toContain('onChatMaestroConfiguratorEvent')
    expect(assistant).toContain('chatMaestroConfiguratorCancel(activeTurnId)')
    expect(assistant).toContain('chatMaestroConfiguratorReset()')
    expect(assistant).toContain('aria-live="polite"')
    expect(en.maestro.configurator.scope).toContain('{{name}}')
    expect(ptBR.maestro.configurator.scope).toContain('{{name}}')
    expect(en.maestro.configurator.suggestionQuality).toContain('maximum-quality')
    expect(ptBR.maestro.configurator.suggestionReplace).toContain('todos os recursos')
  })
})
