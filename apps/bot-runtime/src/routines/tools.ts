import { z } from 'zod'
import { routineParamSchemas, type RoutineMethodName } from '@maestrly/host-protocol'
import type { RoutineClient } from './client.js'

/**
 * Routine tools the model sees while talking to a person. They are added to the catalogue of
 * the turn they belong to and to no other: a delegated worker, a scheduled occurrence and a
 * continuation after a takeover find no such tool, and the Host refuses them as well even if
 * the model has learned the names.
 *
 * The descriptions are deliberately blunt about what these tools do NOT do. A suggestion is
 * a card; telling the person "your routine is scheduled" after calling this would be a lie.
 */
export const ROUTINE_SUMMARIES: Record<RoutineMethodName, string> = {
  routine_propose: 'Sugerindo uma rotina para você confirmar',
  routine_proposal_status: 'Consultando a sugestão de rotina',
}
export const ROUTINE_DESCRIPTIONS: Record<RoutineMethodName, string> = {
  routine_propose:
    'Cria um CARTÃO de sugestão de rotina para a pessoa revisar. Não agenda nada e não executa nada: a rotina só passa a existir depois que a pessoa confirmar na tela. Nunca diga que a rotina foi criada ou agendada. Informe dia, hora e fuso apenas se a pessoa tiver dito; se estiver ambíguo, use "clarification" e pergunte.',
  routine_proposal_status: 'Consulta o que aconteceu com uma sugestão que você mesmo criou, pelo identificador do cartão.',
}

export interface RoutineTool {
  name: RoutineMethodName
  description: string
  inputSchema: Record<string, unknown>
}
/** Catalogue for this turn only; an empty list means this turn may not suggest anything. */
export function routineTools(client: RoutineClient): RoutineTool[] {
  return client.available().map((name) => ({
    name,
    description: ROUTINE_DESCRIPTIONS[name],
    inputSchema: z.toJSONSchema(routineParamSchemas[name]),
  }))
}
export const isRoutineTool = (name: string): name is RoutineMethodName => name in ROUTINE_SUMMARIES
