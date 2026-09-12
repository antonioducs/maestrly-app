/** One row of the project execution ledger (`GET …/projects/:id/executions`). */
export interface Operation {
  id: string
  cardId: string
  cardTitle: string
  jobState: string
  runState: string | null
  approvalId: string | null
  approvalStatus: string | null
  informationRequestId: string | null
  informationQuestion: string | null
  createdAt: string
}
