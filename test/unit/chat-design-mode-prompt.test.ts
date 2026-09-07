import { describe, expect, it } from 'vitest'
import type { ChatBehavior } from '../../src/shared/conversation-experience'
import {
  DESIGN_PROMPT_VERSION,
  renderDesignModePrompt,
  renderDesignUltraGuidance,
} from '../../src/main/chat/design-mode-prompt'

describe('Design mode prompt', () => {
  it('is deterministic, versioned, and emitted only for Design', () => {
    const first = renderDesignModePrompt('design')
    expect(first).toBe(renderDesignModePrompt('design'))
    expect(first.match(new RegExp(`# Maestrly Design mode — ${DESIGN_PROMPT_VERSION}`, 'g'))).toHaveLength(1)
    expect(first).not.toMatch(/\b20\d{2}-\d{2}-\d{2}\b|\/tmp\//)
    for (const mode of ['agent', 'plan', 'ask', 'maestro'] satisfies ChatBehavior[]) {
      expect(renderDesignModePrompt(mode)).toBe('')
      expect(renderDesignUltraGuidance(mode)).toBe('')
    }
  })

  it('requires an executable frontend, honest mocks, interaction, visual direction, and accessible verification', () => {
    const prompt = renderDesignModePrompt('design')
    for (const expected of [
      'executable, interactive visual prototype',
      'coherent fictional data',
      'Make requested navigation',
      'compact system for semantic colors',
      'prefers-reduced-motion',
      'responsive layouts',
      'browser_snapshot',
      'browser_screenshot',
      'console and network errors',
      'distinguish working frontend behavior from mocked behavior',
      'prototypes/<slug>/',
    ]) {
      expect(prompt).toContain(expected)
    }
  })

  it('uses only exposed capabilities and never directs silent enablement or a mandatory review loop', () => {
    const prompt = renderDesignModePrompt('design')
    expect(prompt).toContain('only when the generation tool is genuinely exposed and enabled')
    expect(prompt).toContain('do not enable or bypass them')
    expect(prompt).toContain('Use only tools actually advertised')
    expect(prompt).not.toContain('start_review_loop')
    expect(prompt).not.toContain('review_plan')
  })

  it('directs Ultra toward visual quality without production architecture or read-only behavior', () => {
    const guidance = renderDesignUltraGuidance('design')
    expect(guidance).toContain('visual composition')
    expect(guidance).toContain('responsive behavior')
    expect(guidance).toContain('evidence-based browser verification')
    expect(guidance).toContain('not a read-only investigation')
    expect(guidance).not.toContain('domain/service/repository')
  })
})
