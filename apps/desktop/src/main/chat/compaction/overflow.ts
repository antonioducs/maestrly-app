/** Chunk sizes, relative to the first attempt, tried when the summarizer rejects its input as too large. */
export const COMPACTION_OVERFLOW_LADDER = [0.7, 0.5, 0.35] as const

const OVERFLOW_MESSAGE =
  /context[ _-]?(?:length|window|limit)[ _-]?exceeded|exceeds? (?:the )?(?:model'?s? )?(?:maximum )?context|maximum context length|prompt is too long|input (?:is )?too long|too many (?:input )?tokens|request too large|payload too large|reduce the length of the (?:messages|input)/i

/** Whether a provider rejected a request because its input does not fit, anywhere in the error's cause chain. */
export function isContextOverflowError(error: unknown): boolean {
  const seen = new Set<unknown>()
  for (let current = error; current != null && !seen.has(current); ) {
    seen.add(current)
    const detail = current as { status?: unknown; statusCode?: unknown; message?: unknown; code?: unknown }
    if (Number(detail.statusCode ?? detail.status) === 413) return true
    if (typeof detail.code === 'string' && /context_length_exceeded/i.test(detail.code)) return true
    const message = typeof detail.message === 'string' ? detail.message : typeof current === 'string' ? current : ''
    if (OVERFLOW_MESSAGE.test(message)) return true
    current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined
  }
  return false
}
