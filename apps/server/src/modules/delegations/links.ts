/**
 * Deep links into Maestrly. Kept dependency-free so any module can build a link without importing the
 * delegation service, and so a link is never fabricated from a different origin than the one configured.
 */
export interface DelegationLinkOptions {
  webOrigin: string
}

export interface LinkableTask {
  id: string
  organizationId: string
  projectId: string
  boardId: string
  cardId: string
}

export function delegationLinks(options: DelegationLinkOptions, task: LinkableTask) {
  const base = `${options.webOrigin}/?organization=${task.organizationId}&project=${task.projectId}`
  return {
    task: `${base}&board=${task.boardId}&card=${task.cardId}&delegation=${task.id}`,
    card: `${base}&board=${task.boardId}&card=${task.cardId}`,
  }
}
