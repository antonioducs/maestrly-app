import { z } from 'zod'
import { collaborationParamSchemas, type CollaborationMethod } from '@maestrly/host-protocol'
import type { CollaborationClient } from './client.js'

/**
 * Collaboration tools the model sees while working inside a team. They are added to the
 * catalogue of the turn they belong to and removed from every other turn, so a worker that
 * happens to know the name `team_delegate` finds no such tool and is refused by the Host as
 * well. None of them touches another bot's workspace, account or computer.
 */
export const COLLABORATION_SUMMARIES: Record<CollaborationMethod, string> = {
  team_members: 'Consultando a equipe',
  team_delegate: 'Distribuindo tarefas para a equipe',
  team_status: 'Consultando o andamento da equipe',
  team_publish_file: 'Compartilhando um arquivo com a equipe',
  team_memory_propose: 'Sugerindo uma anotação para a equipe',
  team_operation: 'Consultando o resultado de uma ação',
}
export const COLLABORATION_DESCRIPTIONS: Record<CollaborationMethod, string> = {
  team_members:
    'Lista os membros desta equipe neste trabalho, com nome e papel, e quanto ainda resta do limite deste trabalho. Não mostra contas, computadores nem caminhos.',
  team_delegate:
    'Envia UM lote de tarefas para os outros membros desta equipe e devolve um recibo. Depois de chamar, encerre seu turno: o Host inicia os membros e chama você de volta com os resultados. Não espere aqui pelo resultado deles.',
  team_status: 'Mostra o estado das tarefas deste trabalho e o resultado já entregue por cada membro.',
  team_publish_file:
    'Publica para a equipe um arquivo que você produziu no seu espaço de trabalho. O Host copia e verifica o conteúdo; os outros membros recebem uma cópia no espaço de trabalho deles.',
  team_memory_propose: 'Sugere uma anotação para a equipe guardar. A sugestão só vale depois que a pessoa aprovar.',
  team_operation: 'Consulta uma ação que você já pediu, pelo identificador do recibo, em vez de pedir de novo.',
}

export interface CollaborationTool {
  name: CollaborationMethod
  description: string
  inputSchema: Record<string, unknown>
}
/** Catalogue for this turn only; an empty list means this bot is not working in a team now. */
export function collaborationTools(client: CollaborationClient): CollaborationTool[] {
  return client.available().map((name) => ({
    name,
    description: COLLABORATION_DESCRIPTIONS[name],
    inputSchema: z.toJSONSchema(collaborationParamSchemas[name]),
  }))
}
export const isCollaborationTool = (name: string): name is CollaborationMethod => name in COLLABORATION_SUMMARIES
