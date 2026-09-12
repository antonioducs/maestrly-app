import type { Capability, ExecutionEnvelope } from '@maestrly/protocol'

export interface PreparedEnvironment {
  evidenceGitDirectory?: string
  gitBaseCommit?: string
  repositoryBindingId?: string
  runtimeDirectory?: string
  workspacePath: string
  isolated: boolean
  environment: Record<string, string>
  cleanup(): Promise<void>
}

export interface ExecutionEvent {
  type: string
  data: Record<string, unknown>
}

export interface ExecutionContext {
  signal?:AbortSignal
  readOnly?:boolean
  stageId?:string
  envelope: ExecutionEnvelope
  environment: PreparedEnvironment
  emit(event: ExecutionEvent): Promise<void>
}

export interface ExecutionArtifact {
  kind: 'summary' | 'patch' | 'commit' | 'log' | 'verification' | 'attachment'
  name: string
  contentType: string
  bytes: Uint8Array
}

export interface ExecutionOutcome {
  state: 'succeeded' | 'failed' | 'cancelled' | 'needs_input'
  summary?: string
  failure?: string
  question?: string
  estimatedCostUsd?: number
  artifacts?: ExecutionArtifact[]
}

export interface ExecutorCapabilities {
  executor: 'codex' | 'claude-agent' | string
  capabilities: Capability[]
}

export interface ExecutorAdapter {
  managesOrchestration?:boolean

  capabilities(): Promise<ExecutorCapabilities>
  start(context: ExecutionContext): Promise<ExecutionHandle>
}

export interface ExecutionHandle {
  done: Promise<ExecutionOutcome>
  cancel(reason: string): Promise<void>
}
