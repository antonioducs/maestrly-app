import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Design mode renderer contract', () => {
  const picker = readFileSync('src/renderer/components/chat/ChatModePicker.tsx', 'utf8')
  const view = readFileSync('src/renderer/components/chat/ChatView.tsx', 'utf8')
  const plus = readFileSync('src/renderer/components/chat/ChatPlusMenu.tsx', 'utf8')
  const en = readFileSync('src/shared/i18n/en/chat.ts', 'utf8')
  const pt = readFileSync('src/shared/i18n/pt-BR/chat.ts', 'utf8')

  it('places Design after Agent with Palette and the approved localized descriptions', () => {
    expect(picker).toContain("{ id: 'design'")
    expect(picker.indexOf("id: 'design'")).toBeGreaterThan(picker.indexOf("id: 'agent'"))
    expect(picker.indexOf("id: 'design'")).toBeLessThan(picker.indexOf("id: 'plan'"))
    expect(picker).toContain('Palette')
    expect(en).toContain('Builds navigable visual prototypes focused on UI/UX with mock data.')
    expect(pt).toContain('Cria protótipos visuais navegáveis, com foco em UI/UX e dados simulados.')
  })

  it('uses the shared shortcut policy and explains the cycle including Design', () => {
    expect(view).toContain('cycleChatMode(mode)')
    expect(view).not.toContain("const order: ChatMode[] = ['agent', 'plan', 'ask']")
    expect(en).toContain('Agent → Design → Plan → Ask → Agent')
    expect(pt).toContain('Agente → Design → Plano → Pergunta → Agente')
  })

  it('gives Design a warm ambient treatment distinct from Ultra', () => {
    const styles = readFileSync('src/renderer/styles.css', 'utf8')
    const composer = readFileSync('src/renderer/components/chat/ChatComposer.tsx', 'utf8')
    expect(view).toContain("mode === 'design'")
    expect(view).toContain('chat-design-ambient')
    expect(picker).toContain("mode === 'design'")
    expect(picker).toContain('text-amber-300')
    expect(composer).toContain('chat-composer-shell')
    expect(composer).toContain('chat-send-button')
    expect(styles).toContain('.chat-design-ambient')
    expect(styles).toContain('.chat-design-ambient .chat-composer-shell')
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('does not treat Design as restricted or look up a nonexistent restricted translation', () => {
    expect(plus).toContain("mode === 'plan' || mode === 'ask'")
    expect(plus).not.toContain("mode !== 'agent'")
    expect(en).not.toMatch(/restrictedMode:\s*\{[^}]*design:/s)
    expect(pt).not.toMatch(/restrictedMode:\s*\{[^}]*design:/s)
  })

  it('confirms persistence before changing UI and guards stale conversation responses', () => {
    expect(view).toContain('await window.api.chatSetMode(conversationId, m)')
    expect(view).toContain('if (result.ok) setMode(m)')
    expect(view).toContain('convIdRef.current !== conversationId')
    expect(picker).toContain('disabled={transitioning}')
    expect(view).toContain("t('mode.changeFailed')")
  })
})
