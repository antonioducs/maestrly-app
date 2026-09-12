/** Centralized TTLs and memory-pressure thresholds. Not user-tunable in this delivery. */

export const MEMORY_AUTO_RECLAIM_KEY = 'memory.autoReclaim'

export const CHAT_VIEW_COLD_TTL_MS = 5 * 60_000
export const BROWSER_TAB_COLD_TTL_MS = 10 * 60_000
export const PANEL_COLD_TTL_MS = 10 * 60_000
// ChatGPT is expensive to rematerialize (remote navigation + SPA hydration). Hidden views are already
// background-throttled, so keep a small warm set longer and reserve destructive eviction for genuinely
// cold views or hard memory pressure.
export const CHATGPT_VIEW_COLD_TTL_MS = 30 * 60_000
export const VSCODE_VIEW_COLD_TTL_MS = 15 * 60_000
export const VSCODE_SERVER_IDLE_TTL_MS = 15 * 60_000
export const WORKER_IDLE_TTL_MS = 5 * 60_000
export const IMAGE_OBJECT_URL_IDLE_MS = 30_000
export const TOOL_IMAGE_CACHE_TTL_MS = 15 * 60_000

export const MAX_SAFE_HOT_CHAT_VIEWS = 4
export const MAX_MOUNTED_CHAT_VIEWS = 8
export const MAX_HIDDEN_HOT_CHATGPT_VIEWS = 2

export const CHAT_HISTORY_PAGE_SIZE = 100
export const CHAT_HISTORY_MAX_MESSAGES = 300
export const CHAT_HISTORY_MAX_BYTES = 4 * 1024 * 1024

export const MAX_ATTACHMENT_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_ATTACHMENT_IMAGES_PER_MESSAGE = 8
export const MAX_ATTACHMENT_IMAGE_BYTES_PER_MESSAGE = 20 * 1024 * 1024
export const MAX_ATTACHMENT_TEXT_BYTES = 256 * 1024

export const TOOL_IMAGE_CACHE_BUDGET_BYTES = 64 * 1024 * 1024
export const TOOL_IMAGE_CACHE_HARD_TRIM_BYTES = 16 * 1024 * 1024

export const MEMORY_SOFT_MIN_BYTES = 1024 * 1024 * 1024
export const MEMORY_SOFT_MAX_BYTES = 2 * 1024 * 1024 * 1024
export const MEMORY_HARD_MIN_BYTES = 1536 * 1024 * 1024
export const MEMORY_HARD_MAX_BYTES = 3 * 1024 * 1024 * 1024
export const MEMORY_SOFT_RATIO = 0.12
export const MEMORY_HARD_RATIO = 0.18

export const PREPARE_EVICTION_TIMEOUT_MS = 1_500
export const MEMORY_RECLAIM_RETRY_MS = 30_000
export const RSS_SAMPLE_TIMEOUT_MS = 1_200

export const PRESSURE_SAMPLE_INTERVAL_MS = 30_000

export const EXTERNAL_RSS_SAMPLE_INTERVAL_MS = 5 * 60_000

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function memoryPressureLimits(physicalRamBytes: number): { soft: number; hard: number } {
  const ram = Number.isFinite(physicalRamBytes) && physicalRamBytes > 0 ? physicalRamBytes : MEMORY_SOFT_MAX_BYTES
  return {
    soft: Math.round(clamp(ram * MEMORY_SOFT_RATIO, MEMORY_SOFT_MIN_BYTES, MEMORY_SOFT_MAX_BYTES)),
    hard: Math.round(clamp(ram * MEMORY_HARD_RATIO, MEMORY_HARD_MIN_BYTES, MEMORY_HARD_MAX_BYTES)),
  }
}

export function classifyMemoryPressure(
  workingSetBytes: number,
  limits: { soft: number; hard: number }
): 'normal' | 'soft' | 'hard' {
  if (workingSetBytes >= limits.hard) return 'hard'
  if (workingSetBytes >= limits.soft) return 'soft'
  return 'normal'
}
