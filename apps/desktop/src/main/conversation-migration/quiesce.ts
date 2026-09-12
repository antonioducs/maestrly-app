import { setOwnedCwdActivity, waitForCwdActivityDrain } from '../cwd-activity-coordinator'
import { disposeConversation } from '../drawer-manager'
import * as floatingManager from '../floating-manager'
import { unwatchNotesAtCwd } from '../notes/notes-service'
import { clearPlan } from '../plan-broker'
import * as popupManager from '../popup-manager'
import { killPtyAndWait } from '../pty-manager'
import { unwatchConversation } from '../selection-bridge'
import { stopChatAndWait } from '../chat/service'
import { disposeShellTerminalsAndWait } from '../terminal-manager'

export interface QuiesceResult {
  ok: boolean
  failed: string[]
}

/** Quiesce this conversation after acquiring cwd exclusivity. */
export async function quiesceConversation(conversationId: string, sourceCwd: string): Promise<QuiesceResult> {
  clearPlan(conversationId)
  const [ptyExited, terminalsExited, chatStopped] = await Promise.all([
    killPtyAndWait(conversationId),
    disposeShellTerminalsAndWait(conversationId),
    stopChatAndWait(conversationId),
  ])
  // Callbacks/finally release the actual generation. Fallback release is safe only after termination is
  // confirmed; on timeout retain blocking activity to protect a still-live runtime.
  if (ptyExited) setOwnedCwdActivity(`pty:${conversationId}`, sourceCwd, 'pty', false)
  if (chatStopped) setOwnedCwdActivity(`chat:${conversationId}`, sourceCwd, 'chat', false)
  const admittedActivitiesDrained = await waitForCwdActivityDrain(sourceCwd, ['pty', 'chat', 'terminal'])

  floatingManager.disposeConversation(conversationId)
  popupManager.disposeConversation(conversationId)
  disposeConversation(conversationId)
  unwatchNotesAtCwd(sourceCwd)
  unwatchConversation(conversationId, sourceCwd)

  const failed: string[] = []
  if (!ptyExited) failed.push('pty')
  if (!terminalsExited) failed.push('terminal')
  if (!chatStopped) failed.push('chat')
  if (!admittedActivitiesDrained) failed.push('runtime-activity')
  return { ok: failed.length === 0, failed }
}
