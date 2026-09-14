import type { AuthStatus, BotTurn, GuestEvent, ModelCatalogEntry, TurnSnapshot, DelegatedCredential, LegacyCredential } from '@maestrly/host-protocol'
export type ProviderEvent = Omit<GuestEvent, 'type' | 'runtimeEventId' | 'createdAt'>
export interface ApprovalRequest {
  actionId: string
  title: string
  reason: string
  consequence: string
  parameters: Record<string, unknown>
  scope?: Record<string, unknown>
}
export interface QuestionRequest {
  actionId: string
  title: string
  question: string
}
export interface TurnHooks {
  emit(event: ProviderEvent): void
  requestApproval(req: ApprovalRequest): Promise<'approve' | 'deny'>
  askQuestion(req: QuestionRequest): Promise<string>
}
export interface TurnOutcome {
  status: 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
  error?: { code: string; message: string }
  usage?: BotTurn['usage']
  providerThreadId?: string
  providerTurnId?: string
  finalMessage?: string
}
export interface ProviderAdapter {
  inspect(): Promise<{ version: string; capabilities: string[] }>
  models(): Promise<ModelCatalogEntry[]>
  auth: {
    status(): Promise<AuthStatus>
    prepareDelegation?(): Promise<void>
    useDelegated?(credential: DelegatedCredential): Promise<AuthStatus>
    setCredentialProvider?(provider: (forceRefresh: boolean, credentialHash?: string) => Promise<DelegatedCredential>): void
    exportLegacy?(): Promise<{ credential: LegacyCredential; digest: string }>
    commitMigration?(digest: string): Promise<void>
    startDevice(): Promise<AuthStatus>
    startApiKey(apiKey: string): Promise<AuthStatus>
    cancel(loginId: string): Promise<unknown>
    logout(): Promise<unknown>
  }
  startTurn(snapshot: TurnSnapshot, hooks: TurnHooks, signal: AbortSignal): Promise<TurnOutcome>
  cancelTurn(turnId: string): Promise<void>
  dispose(): Promise<void>
  /** Supervisor observes process death without polling or replaying turns. */
  waitForExit?(): Promise<unknown>
}
