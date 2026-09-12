import { chatDiag } from './diag-log'

export interface DiagnosticUsage {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  totalInput: number
}

export function recordModelCallUsage(args: {
  runtime: 'byok-ai-sdk' | 'codex-subscription' | 'github-copilot-subscription' | 'claude-subscription'
  providerId: string
  modelId: string
  usage: DiagnosticUsage
  conversationId?: string
  agent?: string
  attempt?: number
  step?: number
}): void {
  const cacheHitRatio = args.usage.totalInput > 0 ? args.usage.cacheRead / args.usage.totalInput : 0
  chatDiag({
    kind: 'model-call-usage',
    runtime: args.runtime,
    provider: args.providerId,
    model: args.modelId,
    ...(args.conversationId ? { conv: args.conversationId } : {}),
    ...(args.agent ? { agent: args.agent } : {}),
    ...(args.attempt != null ? { attempt: args.attempt } : {}),
    ...(args.step != null ? { step: args.step } : {}),
    input: args.usage.input,
    cacheRead: args.usage.cacheRead,
    cacheCreate: args.usage.cacheCreate,
    output: args.usage.output,
    totalInput: args.usage.totalInput,
    cacheHitRatio: Math.round(cacheHitRatio * 10_000) / 10_000,
  })
}
