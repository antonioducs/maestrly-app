import { setOwnedCwdActivity, waitForCwdActivityDrain } from '../cwd-activity-coordinator'
import { disposeConversation } from '../drawer-manager'
import * as floatingManager from '../floating-manager'
import { unwatchNotesAtCwd } from '../notes/notes-service'
import { clearPlan } from '../plan-broker'
import * as popupManager from '../popup-manager'
import { killPtyAndWait } from '../pty-manager'
import { serverComputers } from '../remote-host/server/computers-registry'
import { unwatchConversation } from '../selection-bridge'
import { stopChatAndWait } from '../chat/service'
import { stopConversationProcesses } from '../process-ownership/conversation-processes'

export interface QuiesceResult {
  ok: boolean
  failed: string[]
}

/** Quiesce this conversation after acquiring cwd exclusivity. */
export async function quiesceConversation(conversationId: string, sourceCwd: string): Promise<QuiesceResult> {
  clearPlan(conversationId)
  // The chat stops first so no command starts after its processes were read.
  const [ptyExited, chatStopped, processes] = await Promise.all([
    killPtyAndWait(conversationId),
    stopChatAndWait(conversationId),
    stopConversationProcesses(conversationId),
  ])
  const terminalsExited = processes.terminalsExited
  // Callbacks/finally release the actual generation. Fallback release is safe only after termination is
  // confirmed; on timeout retain blocking activity to protect a still-live runtime.
  if (ptyExited) setOwnedCwdActivity(`pty:${conversationId}`, sourceCwd, 'pty', false)
  if (chatStopped) setOwnedCwdActivity(`chat:${conversationId}`, sourceCwd, 'chat', false)
  const admittedActivitiesDrained = await waitForCwdActivityDrain(sourceCwd, ['pty', 'chat', 'terminal'])

  // On a workspaces host, the conversation's computer goes back now: it is leaving, and a program window left open on
  // it would hold one of the eight computers for good.
  await serverComputers()?.close(conversationId)
  floatingManager.disposeConversation(conversationId)
  popupManager.disposeConversation(conversationId)
  disposeConversation(conversationId)
  unwatchNotesAtCwd(sourceCwd)
  unwatchConversation(conversationId, sourceCwd)

  const failed: string[] = []
  if (!ptyExited) failed.push('pty')
  if (!terminalsExited) failed.push('terminal')
  if (processes.survivors.length > 0) failed.push('processes')
  if (!chatStopped) failed.push('chat')
  if (!admittedActivitiesDrained) failed.push('runtime-activity')
  return { ok: failed.length === 0, failed }
}
