import type { FleetInstanceStatus } from '@maestrly/bot-fleet-protocol'
import { notifyClaudeRuntimeChanged } from '../chat/claude-agent-sdk/manager'
import { botClaudeRuntime } from '../chat/claude-agent-sdk/runtime-selection'
import { resolveBotCodexRuntime } from '../chat/codex-subscription/bot-runtime'
import {
  codexConnectionUses,
  listCodexSubscriptionManagers,
  recycleCodexConnections,
} from '../chat/codex-subscription/manager'
import { isBotMode } from '../fleet/instance/config'
import { RuntimeRecycleScheduler } from '../fleet/instance/runtime-recycle'
import { onRuntimeUpdateChanged } from './app-service'

export interface BotRuntimesOptions {
  /** The status of every bot of this environment, read now. */
  readonly botStatuses: () => Promise<readonly FleetInstanceStatus[]>
  /** A runtime's version or release channel changed, so bot statuses report it anew. */
  readonly onRuntimesChanged?: () => void
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
    // A turn that starts after the bots were seen idle, while the runtime is still being resolved, keeps its
    // connection: recycling compares these uses in the same tick it closes one.
    uses: codexConnectionUses,
    statuses: options.botStatuses,
    recycle: async (unusedSince) => {
      const recycled = await recycleCodexConnections(await staleCodexRuntime(), unusedSince)
      // Bot statuses report the Codex their connections run: the old one is gone now.
      if (recycled) options.onRuntimesChanged?.()
      return recycled
    },
  })
  const recycleCodexIfStale = () =>
    void staleCodexRuntime()
      .then((stale) => {
        const outdated = listCodexSubscriptionManagers().some((manager) => {
          // A connection being established may have selected the old runtime before this update, and no update
          // event follows its handshake: the scheduler keeps retrying until it can be checked.
          if (manager.connecting) return true
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
    options.onRuntimesChanged?.()
  })
  return () => {
    unsubscribe()
    codex.dispose()
  }
}
