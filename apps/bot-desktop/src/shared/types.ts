export type { Vm, Host, Operation } from '@maestrly/host-protocol'
import type { Operation } from '@maestrly/host-protocol'
export type HostEvent = { seq: number; kind: string; createdAt: string; value: unknown }
export const methods = [
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
export type Method = (typeof methods)[number]
export type Call = { method: Method; params: Record<string, unknown> }
export type Connection = {
  connected: boolean
  alias: string | null
  error?: string
  hostId?: string
  retryableKeys?: string[]
  recoveryIssue?: string
  lastOperation?: Operation
  pending?: Operation[]
  retainedVmIds?: string[]
}
export interface BotApi {
  hosts(): Promise<string[]>
  connect(alias: string): Promise<Connection>
  disconnect(): Promise<void>
  status(): Promise<Connection>
  retry(idempotencyKey: string): Promise<Operation>
  call(call: Call): Promise<unknown>
}
declare global {
  interface Window {
    bot: BotApi
  }
}
