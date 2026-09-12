export interface MemoryEvictionPrepareRequest {
  requestId: string
  convId: string
  tab: string
}

export interface MemoryEvictionReadyPayload {
  requestId: string
  safe: boolean
  reason?: string
}

export interface VSCodeMemorySnapshot {
  dirtyDocuments: number
  debugActive: boolean
  operationInFlight: boolean
  lastActivityAt: number
  generation?: number
}

export interface PlanDraftPrefs {
  version: number
  planHash: string
  text: string
  feedback: string
  lineComments: Record<number, string>
  mode: 'read' | 'edit' | 'diff'
}
