import { useEffect, useState } from 'react'
import { useChatUi } from '../provider'
import { formatResponseDuration, responseDurationMs } from './types'

/** Elapsed response time; counts live while the response has started and not finished. */
export function ResponseDuration({ startedAt, durationMs }: { startedAt?: number; durationMs?: number }) {
  const { labels } = useChatUi()
  const [, tick] = useState(0)
  const live = startedAt != null && durationMs == null
  useEffect(() => {
    if (!live) return
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [live])
  const duration = durationMs ?? (startedAt != null ? responseDurationMs(startedAt) : undefined)
  if (duration == null) return null
  const text = formatResponseDuration(duration)
  return (
    <span
      title={labels.responseDuration(Math.floor(duration / 1000))}
      className="font-mono text-[11px] tabular-nums text-muted-foreground/70"
      data-response-duration
    >
      {text}
    </span>
  )
}
