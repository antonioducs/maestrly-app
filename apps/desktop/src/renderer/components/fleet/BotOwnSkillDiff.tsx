import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { diffLines } from 'diff'
import type { FleetBotOwnSkillFile } from '@maestrly/bot-fleet-protocol'
import { cn } from '@/lib/utils'

/** Unchanged lines kept around each change; longer unchanged runs fold into one line. */
const CONTEXT = 3

type Row = { kind: 'add' | 'del' | 'ctx' | 'fold'; text: string }

function rowsOf(before: string, after: string): Row[] {
  const rows: Row[] = []
  for (const part of diffLines(before, after)) {
    const kind = part.added ? 'add' : part.removed ? 'del' : 'ctx'
    for (const line of part.value.replace(/\n$/, '').split('\n')) rows.push({ kind, text: line })
  }
  const keep = rows.map(() => false)
  rows.forEach((row, index) => {
    if (row.kind === 'ctx') return
    for (let near = Math.max(0, index - CONTEXT); near <= Math.min(rows.length - 1, index + CONTEXT); near++)
      keep[near] = true
  })
  const out: Row[] = []
  for (let index = 0; index < rows.length; index++) {
    if (keep[index]) {
      out.push(rows[index])
      continue
    }
    let end = index
    while (end + 1 < rows.length && !keep[end + 1]) end++
    out.push({ kind: 'fold', text: String(end - index + 1) })
    index = end
  }
  return out
}

/** The files that differ between two sets of a skill's files, each as a line diff. */
export function BotOwnSkillDiff({
  before,
  after,
}: {
  before: readonly FleetBotOwnSkillFile[]
  after: readonly FleetBotOwnSkillFile[]
}) {
  const { t } = useTranslation('fleet')
  const changes = useMemo(() => {
    const was = new Map(before.map((file) => [file.path, file.content]))
    const now = new Map(after.map((file) => [file.path, file.content]))
    const paths = [...new Set([...was.keys(), ...now.keys()])].sort((a, b) =>
      a === 'SKILL.md' ? -1 : b === 'SKILL.md' ? 1 : a.localeCompare(b)
    )
    return paths.flatMap((path) => {
      const old = was.get(path)
      const next = now.get(path)
      if (old === next) return []
      const state = old === undefined ? 'added' : next === undefined ? 'removed' : 'changed'
      return [{ path, state, rows: rowsOf(old ?? '', next ?? '') }]
    })
  }, [before, after])
  if (!changes.length) return <p className="text-[13px] text-muted-foreground">{t('ownSkills.diff.none')}</p>
  return (
    <div className="flex flex-col gap-3">
      {changes.map((change) => (
        <div key={change.path} className="overflow-hidden rounded-lg border border-border">
          <div className="flex items-center gap-2 border-b border-border bg-foreground/[0.03] px-2.5 py-1.5 text-xs">
            <span className="font-mono">{change.path}</span>
            <span className="text-muted-foreground">{t(`ownSkills.diff.${change.state}`)}</span>
          </div>
          <div className="max-h-80 overflow-auto font-mono text-[12px] leading-relaxed">
            {change.rows.map((row, index) =>
              row.kind === 'fold' ? (
                <div key={index} className="select-none px-2 py-px text-muted-foreground">
                  {t('ownSkills.diff.unchanged', { count: Number(row.text) })}
                </div>
              ) : (
                <div
                  key={index}
                  className={cn(
                    'flex gap-2 whitespace-pre-wrap break-words px-2 py-px',
                    row.kind === 'add' && 'bg-status-ready/10 text-status-ready',
                    row.kind === 'del' && 'bg-destructive/10 text-destructive',
                    row.kind === 'ctx' && 'text-foreground/55'
                  )}
                >
                  <span className="select-none opacity-60" aria-hidden="true">
                    {row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '}
                  </span>
                  <span className="sr-only">
                    {row.kind === 'add'
                      ? t('ownSkills.diff.addedLine')
                      : row.kind === 'del'
                        ? t('ownSkills.diff.removedLine')
                        : ''}
                  </span>
                  <span>{row.text || ' '}</span>
                </div>
              )
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
