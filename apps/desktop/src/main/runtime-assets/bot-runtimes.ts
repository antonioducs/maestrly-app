import type { FleetInstanceStatus } from '@maestrly/bot-fleet-protocol'
import { notifyClaudeRuntimeChanged } from '../chat/claude-agent-sdk/manager'
import { botClaudeRuntime } from '../chat/claude-agent-sdk/runtime-selection'
import { resolveBotCodexRuntime } from '../chat/codex-subscription/bot-runtime'
import { listCodexSubscriptionManagers, recycleCodexConnections } from '../chat/codex-subscription/manager'
import { isBotMode } from '../fleet/instance/config'
import { RuntimeRecycleScheduler } from '../fleet/instance/runtime-recycle'
import { onRuntimeUpdateChanged } from './app-service'

export interface BotRuntimesOptions {
  /** The status of every bot of this environment, read now. */
  readonly botStatuses: () => Promise<readonly FleetInstanceStatus[]>
}

function log(message: string, error?: unknown): void {
  console.warn(`[bot-runtimes] ${message}`, error ?? '')
}

/** Rejects any open Codex connection that does not run the runtime a new connection would use now. */
async function staleCodexRuntime(): Promise<(runtimePath: string) => boolean> {
  const selected = await resolveBotCodexRuntime()
  return (runtimePath) => runtimePath !== selected.executablePath
}

/**
 * Moves a bot's conversations to the Claude Code and Codex versions its runtime updates activate, without
 * interrupting them: Claude switches for the next query; Codex connections are recycled once every bot of the
 * environment is idle. Returns the function that stops following updates. Does nothing outside bots.
 */
export function startBotRuntimes(options: BotRuntimesOptions): () => void {
  if (!isBotMode()) return () => {}
  const claude = botClaudeRuntime()
  const refreshClaude = () =>
    void claude
      .refresh()
      .then((changed) => {
        if (changed) notifyClaudeRuntimeChanged()
      })
      .catch((error: unknown) => log('Unable to select the Claude Code runtime', error))

  const codex = new RuntimeRecycleScheduler({
    statuses: options.botStatuses,
    recycle: async () => recycleCodexConnections(await staleCodexRuntime()),
  })
  const recycleCodexIfStale = () =>
    void staleCodexRuntime()
      .then((stale) => {
        const outdated = listCodexSubscriptionManagers().some((manager) => {
          const runtimePath = manager.connectedRuntimePath
          return runtimePath !== null && stale(runtimePath)
        })
        if (outdated) codex.request()
      })
      .catch((error: unknown) => log('Unable to select the Codex runtime', error))

  // A version activated before this process restarted is picked up at once.
  refreshClaude()
  const unsubscribe = onRuntimeUpdateChanged((id) => {
    if (id === 'claude-code-runtime') refreshClaude()
    else recycleCodexIfStale()
  })
  return () => {
    unsubscribe()
    codex.dispose()
  }
}
