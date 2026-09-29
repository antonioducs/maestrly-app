import type { FleetInstanceStatus } from '@maestrly/bot-fleet-protocol'
import { notifyClaudeRuntimeChanged } from '../chat/claude-agent-sdk/manager'
import { botClaudeRuntime } from '../chat/claude-agent-sdk/runtime-selection'
import { isBotMode } from '../fleet/instance/config'
import { onRuntimeUpdateChanged } from './app-service'

export interface BotRuntimesOptions {
  /** The status of every bot of this environment, read now. */
  readonly botStatuses: () => Promise<readonly FleetInstanceStatus[]>
}

function log(message: string, error?: unknown): void {
  console.warn(`[bot-runtimes] ${message}`, error ?? '')
}

/**
 * Moves a bot's conversations to the Claude Code and Codex versions its runtime updates activate, without
 * interrupting them. Returns the function that stops following updates. Does nothing outside bots.
 */
export function startBotRuntimes(_options: BotRuntimesOptions): () => void {
  if (!isBotMode()) return () => {}
  const claude = botClaudeRuntime()
  const refreshClaude = () =>
    void claude
      .refresh()
      .then((changed) => {
        if (changed) notifyClaudeRuntimeChanged()
      })
      .catch((error: unknown) => log('Unable to select the Claude Code runtime', error))

  // A version activated before this process restarted is picked up at once.
  refreshClaude()
  const unsubscribe = onRuntimeUpdateChanged((id) => {
    if (id === 'claude-code-runtime') refreshClaude()
  })
  return () => {
    unsubscribe()
  }
}
