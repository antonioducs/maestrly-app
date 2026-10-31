import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { GitCompare } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Unified diff rendering shared by the Review tab and a turn's file changes. */

export interface DiffFile {
  path: string
  lines: { kind: 'add' | 'del' | 'ctx' | 'hunk' | 'meta'; text: string }[]
}

/** A multi-file unified diff, one card per file whose header opens the file. */
export function UnifiedDiffView({
  diff,
  onOpenFile,
}: {
  diff: string
  onOpenFile: (p: string, line?: number) => void
}) {
  const { t } = useTranslation('ui')
  const files = useMemo(() => parseUnifiedDiff(diff), [diff])
  return (
    <div className="flex flex-col gap-3">
      {files.map((f, i) => (
        <div key={i} className="overflow-hidden rounded-lg border border-border">
          <button
            onClick={() => onOpenFile(f.path)}
            className="flex w-full items-center gap-1.5 border-b border-border bg-white/[0.03] px-2 py-1.5 text-left font-mono text-[11.5px] text-foreground/90 hover:bg-white/[0.06]"
            title={t('review.openInVsCode')}
          >
            <GitCompare className="size-3.5 shrink-0 opacity-50" />
            <span className="truncate">{f.path}</span>
          </button>
          <DiffLines lines={f.lines} />
        </div>
      ))}
    </div>
  )
}

const unq = (s: string) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s)

/** Splits a unified diff (as `git diff` prints it) into files and classified lines. */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = []
  let cur: DiffFile | null = null
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      cur = { path: '', lines: [] }
      files.push(cur)
      const m = raw.match(/ b\/(.+)$/)
      if (m) cur.path = unq(m[1])
      continue
    }
    if (!cur) continue
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).trim()
      if (p !== '/dev/null') cur.path = unq(p).replace(/^b\//, '')
      cur.lines.push({ kind: 'meta', text: raw })
    } else if (raw.startsWith('--- ')) {
      const p = raw.slice(4).trim()
      if (!cur.path && p !== '/dev/null') cur.path = unq(p).replace(/^a\//, '') // Deleted files use the a/ path.
      cur.lines.push({ kind: 'meta', text: raw })
    } else if (raw.startsWith('@@')) cur.lines.push({ kind: 'hunk', text: raw })
    else if (
      raw.startsWith('index ') ||
      raw.startsWith('new file') ||
      raw.startsWith('deleted file') ||
      raw.startsWith('old mode') ||
      raw.startsWith('new mode') ||
      raw.startsWith('similarity ') ||
      raw.startsWith('rename ') ||
      raw.startsWith('copy ') ||
      raw.startsWith('Binary ') ||
      raw.startsWith('\\ ')
    )
      cur.lines.push({ kind: 'meta', text: raw })
    else if (raw.startsWith('+')) cur.lines.push({ kind: 'add', text: raw.slice(1) })
    else if (raw.startsWith('-')) cur.lines.push({ kind: 'del', text: raw.slice(1) })
    else cur.lines.push({ kind: 'ctx', text: raw.startsWith(' ') ? raw.slice(1) : raw })
  }
  return files
}

/** The lines of one file's diff, colored by kind. */
export function DiffLines({ lines, className }: { lines: DiffFile['lines']; className?: string }) {
  return (
    <div className={cn('font-mono text-[12px] leading-relaxed', className)}>
      {lines.map((r, j) => (
        <div
          key={j}
          className={cn(
            'flex gap-2 whitespace-pre-wrap break-words px-2 py-px',
            r.kind === 'add' && 'bg-status-ready/10 text-status-ready',
            r.kind === 'del' && 'bg-destructive/10 text-destructive',
            r.kind === 'ctx' && 'text-foreground/45',
            r.kind === 'hunk' && 'bg-primary/5 text-primary/70',
            r.kind === 'meta' && 'text-foreground/30'
          )}
        >
          <span className="select-none opacity-60">{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '}</span>
          <span className="min-w-0 flex-1">{r.text || ' '}</span>
        </div>
      ))}
    </div>
  )
}
