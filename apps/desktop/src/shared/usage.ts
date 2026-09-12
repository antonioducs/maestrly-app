export type UsageSource = 'chat'

export interface UsageModelRow {
  source: UsageSource
  providerId: string
  modelId: string
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  turns: number

  costUsd: number | null

  catalogInput?: number
  catalogOutput?: number
  catalogCacheRead?: number
  catalogCacheCreate?: number
}

export interface UnifiedUsageStats {
  rows: UsageModelRow[]
  chatTurns: number

  firstAt: number | null
  lastAt: number | null
  generatedAt: number
}

export const USAGE_MAX_WINDOW_DAYS = 90
