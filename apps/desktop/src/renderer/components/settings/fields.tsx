import { useEffect, useState } from 'react'

export function SettingLimitField({
  label,
  hint,
  value,
  emptyNote,
  placeholder,
  min = 1,
  onCommit,
}: {
  label: string
  hint: string
  value: number | undefined
  emptyNote: string
  placeholder: string
  min?: number
  onCommit: (v: number | null) => void
}) {
  const [draft, setDraft] = useState(value != null ? String(value) : '')
  useEffect(() => setDraft(value != null ? String(value) : ''), [value])
  const commit = () => {
    const t = draft.trim()
    if (t === '') return onCommit(null)
    const n = Number(t)
    if (!Number.isFinite(n) || n < min) {
      setDraft(value != null ? String(value) : '')
      return
    }
    onCommit(Math.floor(n))
  }
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="text-[11px] leading-snug text-muted-foreground">{hint}</div>
        {value == null && <div className="mt-1 text-[11px] leading-snug text-muted-foreground/80">{emptyNote}</div>}
      </div>
      <input
        type="number"
        min={min}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
        placeholder={placeholder}
        className="w-24 shrink-0 rounded-md border border-input bg-transparent px-2 py-1 text-sm text-foreground outline-none focus:border-primary/40"
      />
    </div>
  )
}
