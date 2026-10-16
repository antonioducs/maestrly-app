import { killAllPtyTrees } from '../pty-manager'
import { stopShellTerminals } from '../terminal-manager'
import { stopOwnedGroups } from './owned-groups'
import type { ProcessSurvivor } from './terminate'

export interface StopProcessesResult {
  /** Every shell exited and nothing outlived SIGKILL. */
  ok: boolean
  terminalsExited: boolean
  survivors: ProcessSurvivor[]
}

function reportSurvivors(scope: string, survivors: readonly ProcessSurvivor[]): void {
  if (survivors.length === 0) return
  console.warn(
    JSON.stringify({
      component: 'conversation-processes',
      level: 'warn',
      message: 'Processes outlived SIGKILL',
      scope,
      count: survivors.length,
      pids: survivors.map((survivor) => survivor.pid),
      // The executable name only; a command line can carry secrets.
      names: [...new Set(survivors.map((survivor) => survivor.name).filter(Boolean))],
    })
  )
}

/**
 * Ends what a conversation started and Maestrly can show is its own: its terminals with their process trees, and the
 * process groups of its `bash` commands, including what was sent to the background. Waits for them, so a worktree is
 * never removed under a running process. Nothing is matched by directory, so a shared or local checkout stays safe.
 * Runs on archive, delete, reset and moves; a second call finds nothing left.
 */
export async function stopConversationProcesses(conversationId: string): Promise<StopProcessesResult> {
  const [terminals, groups] = await Promise.all([stopShellTerminals(conversationId), stopOwnedGroups(conversationId)])
  const survivors = [...terminals.survivors, ...groups.survivors]
  reportSurvivors(conversationId, survivors)
  return { ok: terminals.exited && survivors.length === 0, terminalsExited: terminals.exited, survivors }
}

/** The same for every conversation, when the app quits: once it is gone nothing could prove these are its own. */
export async function stopAllConversationProcesses(): Promise<StopProcessesResult> {
  const [terminals, groups] = await Promise.all([killAllPtyTrees(), stopOwnedGroups(null)])
  const survivors = [...terminals.survivors, ...groups.survivors]
  reportSurvivors('all', survivors)
  return { ok: terminals.exited && survivors.length === 0, terminalsExited: terminals.exited, survivors }
}
