import { buildMaestrlyBasePrompt } from './host-contracts'
import {
  composeOpenAICodexPortPrompt,
  composeOpenAIConcisePrompt,
  type OpenAIPromptMode,
} from './strategies/prompt-layout'
import type { ChatBehavior, HarnessSourceProvenance, ResolvedHarness } from './types'

export interface BuildHarnessPromptInput {
  harness: ResolvedHarness
  cwd: string
  mode: ChatBehavior
  appToolsEnabled: boolean
  hasNotesTab: boolean
  nativeTools?: { localShell: boolean; applyPatch: boolean }
  projectContext?: string | null
  skillsContext?: string | null
  agentsContext?: string | null
  envContext?: string | null
  ultraContext?: string | null
}

export interface CompiledHarnessPrompt {
  layout: ResolvedHarness['prompts']['layout']
  instructions: string
  stablePrefix: string
  volatileSuffix: string
  /** Per-turn context some transports deliver outside the cached prompt. */
  transientContext: string | null
  provenance: HarnessSourceProvenance | null
}

/** Responses layouts have no Maestro mode: the orchestrator runs under the read-only Ask contract. */
function responsesMode(mode: ChatBehavior): OpenAIPromptMode {
  return mode === 'maestro' ? 'ask' : mode
}

/**
 * Single prompt composition entry point. The strategy comes from the resolved contract, so adding a
 * model that reuses an existing layout never adds a branch here.
 */
export function buildHarnessPrompt(input: BuildHarnessPromptInput): CompiledHarnessPrompt {
  const { harness } = input
  const transientContext = harness.prompts.environment.transient ? (input.envContext?.trim() ?? null) : null
  const provenance = harness.source

  if (harness.prompts.layout === 'maestrly-base' || !harness.prompts.base) {
    const instructions = buildMaestrlyBasePrompt({
      harness,
      cwd: input.cwd,
      appToolsEnabled: input.appToolsEnabled,
      mode: input.mode,
      hasNotesTab: input.hasNotesTab,
    })
    return {
      layout: 'maestrly-base',
      instructions,
      stablePrefix: instructions,
      volatileSuffix: '',
      transientContext,
      provenance,
    }
  }

  const layoutInput = {
    base: harness.prompts.base,
    cwd: input.cwd,
    mode: responsesMode(input.mode),
    appToolsEnabled: input.appToolsEnabled,
    hasNotesTab: input.hasNotesTab,
    projectContext: input.projectContext,
    skillsContext: input.skillsContext,
    agentsContext: input.agentsContext,
    envContext: input.envContext,
    ultraContext: input.ultraContext,
    ...(input.nativeTools ? { nativeTools: input.nativeTools } : {}),
  }
  const compiled =
    harness.prompts.layout === 'openai-astra'
      ? composeOpenAIConcisePrompt(layoutInput)
      : composeOpenAICodexPortPrompt(layoutInput)
  return { layout: harness.prompts.layout, ...compiled, transientContext, provenance }
}

/**
 * Developer-instruction contract for transports that carry the host policy separately from the
 * provider-owned operating prompt. Without a declared prefix the base is returned untouched.
 */
export function buildHarnessDeveloperInstructions(
  base: string,
  harness: ResolvedHarness,
  facts: { asyncTools: boolean }
): string {
  const prefix = harness.prompts.developerPrefix
  if (!prefix) return base
  const guidance = facts.asyncTools && prefix.asyncTools ? prefix.asyncTools : ''
  return `${[prefix.base, guidance].filter(Boolean).join(' ')}\n\n${base}`
}
