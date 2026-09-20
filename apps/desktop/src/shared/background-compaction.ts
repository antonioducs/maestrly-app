export interface BackgroundCompactionConfig {
  enabled: boolean
  intervalTokens: number
  selection: {
    providerId: string
    modelId: string
    effort: string
    fastMode: boolean
  } | null
}

export interface BackgroundCompactionStatus {
  revision: number
  status: 'idle' | 'queued' | 'running' | 'ready' | 'failed' | 'paused'
  error?: string
}
