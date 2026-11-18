import type { FleetRoutineRunKept } from '@maestrly/bot-fleet-protocol'
import type { LocalRoutine, LocalRoutineRun } from '../../shared/routines'
import { getConversation } from '../store'
import { keepConversationFiles } from '../fleet/instance/run-files'

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export function routineRunKeptFolder(run: Pick<LocalRoutineRun, 'startedAt' | 'scheduledAt'>): string {
  const d = new Date(run.startedAt ?? run.scheduledAt)
  const stamp = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}${pad2(d.getMinutes())}`
  return `runs/${stamp}`
}

export async function keepRoutineRunFiles(
  routine: Pick<LocalRoutine, 'folder'>,
  run: Pick<LocalRoutineRun, 'conversationId' | 'startedAt' | 'scheduledAt'>
): Promise<FleetRoutineRunKept> {
  if (!run.conversationId || !getConversation(run.conversationId)) {
    return { folder: '', files: [] }
  }
  return keepConversationFiles({
    conversationId: run.conversationId,
    folder: routine.folder,
    relativeFolder: routineRunKeptFolder(run),
  })
}
