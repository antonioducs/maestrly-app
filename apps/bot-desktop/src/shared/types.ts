export type { Vm, Host, Operation } from '@maestrly/host-protocol'
import type { BotMethod, BotResult, Operation } from '@maestrly/host-protocol'
export type HostEvent = { seq: number; kind: string; createdAt: string; value: unknown }
export const vmMethods = [
  'host.inspect',
  'vm.list',
  'vm.create',
  'vm.inspect',
  'vm.logs',
  'vm.start',
  'vm.shutdown',
  'vm.restart',
  'vm.remove',
  'operation.get',
  'operation.lookup',
  'operation.cancel',
  'events.list',
  'image.list',
] as const
export const methods = vmMethods
export type Method = (typeof vmMethods)[number]
export type Call = { method: Method; params: Record<string, unknown> }
export type BotCall<M extends BotMethod = BotMethod> = { method: M; params: Record<string, unknown> }
/** Where a Host runs: this Mac through the fixed local command, or a remote alias already trusted in SSH config. */
export type HostTarget =
  | { kind: 'local'; id: 'local'; displayName: string; hostId?: string; lastConnectedAt?: string }
  | { kind: 'ssh'; id: string; alias: string; displayName: string; hostId?: string; lastConnectedAt?: string }
export type Connection = {
  connected: boolean
  alias: string | null
  target?: HostTarget
  error?: string
  hostId?: string
  retryableKeys?: string[]
  recoveryIssue?: string
  lastOperation?: Operation
  pending?: Operation[]
  retainedVmIds?: string[]
  accountSupport?: 'available' | 'host-outdated' | 'unknown'
  botSupport?: 'available' | 'host-outdated' | 'unknown'
}
export type LocalHostStatus =
  | { state: 'installed'; version?: string }
  | { state: 'missing' }
  | { state: 'unsupported'; reason: string }
  | { state: 'untrusted'; reason: string }
export type InstallOutcome = { status: 'installed' | 'blocked' | 'cancelled' | 'failed'; message: string }
/** Persisted onboarding draft; never contains secrets. */
export type OnboardingDraft = {
  name: string
  purpose: string
  targetId?: string
  sharedVmId?: string
  accountId?: string
  model?: import('@maestrly/host-protocol').Bot['model']
  instructions?: string
  step?: number
  previewId?: string
  inventoryRevision?: string
  /** Durable key for bot.setup.start so reopening the app resumes instead of creating twice. */
  idempotencyKey?: string
  operationId?: string
  botId?: string
  updatedAt: string
}
export type UiPreferences = { theme: 'system' | 'light' | 'dark'; advanced: boolean; locale: 'pt-BR' | 'en'; lastBotId?: string }
export interface BotApi {
  hosts(): Promise<HostTarget[]>
  connect(targetId: string): Promise<Connection>
  addSshTarget(alias: string): Promise<HostTarget>
  removeTarget(targetId: string): Promise<void>
  disconnect(): Promise<void>
  status(): Promise<Connection>
  retry(idempotencyKey: string): Promise<Operation>
  call(call: Call): Promise<unknown>
  bot<M extends BotMethod>(call: BotCall<M>): Promise<BotResult<M>>
  syncAccounts(): Promise<{ unavailableHosts: string[] }>
  localHost(): Promise<LocalHostStatus>
  installLocalHost(): Promise<InstallOutcome>
  openExternal(url: string): Promise<boolean>
  draft(): Promise<OnboardingDraft | null>
  saveDraft(draft: OnboardingDraft | null): Promise<void>
  preferences(): Promise<UiPreferences>
  savePreferences(preferences: Partial<UiPreferences>): Promise<UiPreferences>
  saveFile(input: { name: string; dataBase64: string }): Promise<{ saved: boolean }>
  pickFile(): Promise<{ name: string; size: number; dataBase64: string } | null>
}
declare global {
  interface Window {
    bot: BotApi
  }
}
