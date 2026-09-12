import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import en from '../../src/shared/i18n/en/chat'
import ptBR from '../../src/shared/i18n/pt-BR/chat'

const source = (path: string) => readFileSync(path, 'utf8')

describe('Maestro configurator renderer contract', () => {
  it('keeps the assistant optional so the Pool editor owns the full width by default', () => {
    const settings = source('src/renderer/components/chat/MaestroSettings.tsx')
    expect(settings).toContain("import { MaestroConfigurator } from './MaestroConfigurator'")
    expect(settings).toContain('const [assistantOpen, setAssistantOpen] = useState(false)')
    expect(settings).toContain('aria-expanded={assistantOpen}')
    expect(settings).toContain('aria-controls="maestro-configurator-panel"')
    expect(settings).toContain("assistantOpen && 'xl:grid-cols-[minmax(0,1fr)_minmax(320px,22rem)]'")
    expect(settings).toContain('draft={draft}')
    expect(settings).toContain('onApply={setDraft}')
    expect(settings).toContain('onClose={() => setAssistantOpen(false)}')
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

  it('reuses the chat composer pills for model, reasoning and Fast instead of stacked selects', () => {
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
    expect(modelChip).toContain('if (conversationId) window.api.chatGetSelection(conversationId)')
    expect(assistant).toContain('chatMaestroConfiguratorSetProfile(next)')
    // This surface has no delegation, so the synthetic Ultra mode is unavailable.
    expect(assistant).toContain('allowUltra={false}')
    expect(reasoning).toContain('allowUltra?: boolean')
    expect(reasoning).toContain('avoidOverflow?: boolean')
    expect(reasoning).toContain("position: 'fixed'")
    expect(reasoning).toContain("window.addEventListener('scroll', reposition, true)")
    expect(fast).toContain('export function FastModeChip')
    // Fast and reasoning appear only when the selected model advertises the capability.
    expect(assistant).toContain('profileMeta.meta?.fastModeCapability === true')
    expect(assistant).toContain('efforts.length > 0 && (')
  })

  it('guards stale proposals and applies only to the draft, never directly to global settings', () => {
    const assistant = source('src/renderer/components/chat/MaestroConfigurator.tsx')
    expect(assistant).toContain('proposal.baseHash !== hashMaestroConfig(draft)')
    expect(assistant).toContain('onApply(cloneMaestroConfig(message.proposal!.config))')
    expect(assistant).not.toContain('chatMaestroSetGlobal')
    expect(assistant).not.toContain('chatMaestroSetConversation')
  })

  it('provides iterative chat, stop/reset, suggestions and localized accessible copy', () => {
    const assistant = source('src/renderer/components/chat/MaestroConfigurator.tsx')
    expect(assistant).toContain('onChatMaestroConfiguratorEvent')
    expect(assistant).toContain('chatMaestroConfiguratorCancel(activeTurnId)')
    expect(assistant).toContain('chatMaestroConfiguratorReset()')
    expect(assistant).toContain('aria-live="polite"')
    expect(en.maestro.configurator.scope).toContain('global draft')
    expect(ptBR.maestro.configurator.scope).toContain('draft global')
    expect(en.maestro.configurator.suggestionQuality).toContain('maximum-quality')
    expect(ptBR.maestro.configurator.suggestionReplace).toContain('todos os recursos')
  })
})
