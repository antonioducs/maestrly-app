/** `m:ss`, or `h:mm:ss` from one hour; `--:--` while a duration is unknown (a live or unindexed stream). */
export function formatMediaTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--'
  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = String(total % 60).padStart(2, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`
}
