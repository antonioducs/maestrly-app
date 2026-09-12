import { ipcRenderer } from 'electron'

export interface PlanLineComment {
  line: number
  text: string
}

export interface PlanDecision {
  action: 'approve' | 'revise' | 'discard'

  implementationTarget?: 'source' | 'maestro'

  maestroStrategyProfileId?: string
  editedPlan?: string
  feedback?: string
  lineComments?: PlanLineComment[]
}

export interface PlanDecisionResponse {
  ok: boolean
  error?: string

  conversationId?: string
}

export interface PlanReceived {
  agentId: string
  cwd: string
  plan: string
  planFilePath?: string
  version: number
  previousPlan: string | null
}

export const planApi = {
  onPlanReceived: (cb: (plan: PlanReceived) => void): (() => void) => {
    const listener = (_e: unknown, plan: PlanReceived) => cb(plan)
    ipcRenderer.on('plan:received', listener)
    return () => ipcRenderer.removeListener('plan:received', listener)
  },
  onPlanCleared: (cb: (payload: { agentId: string }) => void): (() => void) => {
    const listener = (_e: unknown, payload: { agentId: string }) => cb(payload)
    ipcRenderer.on('plan:cleared', listener)
    return () => ipcRenderer.removeListener('plan:cleared', listener)
  },
  decidePlan: (agentId: string, decision: PlanDecision): Promise<PlanDecisionResponse | undefined> =>
    ipcRenderer.invoke('plan:decide', agentId, decision),

  getPendingPlan: (convId: string): Promise<PlanReceived | null> => ipcRenderer.invoke('plan:get', convId),
  openPlanFile: (convId: string, filePath: string, line?: number, endLine?: number): Promise<void> =>
    ipcRenderer.invoke('plan:open-file', convId, filePath, line, endLine),
}
