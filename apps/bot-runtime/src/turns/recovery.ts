import { TURN_TERMINAL } from '@maestrly/host-protocol'
import type { Journal } from '../control/journal.js'
export function recoverTurns(journal: Journal) {
  for (const turn of journal.allTurns()) {
    if (TURN_TERMINAL.has(turn.status)) continue
    const detail = {
      status: 'interrupted',
      error: { code: 'RUNTIME_RESTARTED', message: 'Runtime restarted before the task finished' },
    }
    // Queue first: a crash between these writes only duplicates a safe status event.
    journal.event({
      turnId: turn.turnId,
      generation: turn.generation,
      kind: 'turn.status',
      summary: 'A tarefa foi interrompida',
      detail,
    })
    journal.status(turn.turnId, turn.generation, detail)
  }
}
