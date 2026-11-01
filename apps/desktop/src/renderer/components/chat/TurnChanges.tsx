import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, FileDiff, Redo2, Undo2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useHostApi } from '@/lib/hosts/host-context'
import { toolCategory } from '@/lib/agent-activity'
import type { ChatMessage } from '../../../shared/chat'
import {
  turnFileDisplayPath,
  type TurnFileChange,
  type TurnSnapshotDetail,
  type TurnSnapshotRoot,
  type TurnSnapshotSummary,
} from '../../../shared/turn-snapshots'
import { TurnFileDiff } from './TurnFileDiff'
import { UndoTurnDialog, type UndoTurnRequest } from './UndoTurnDialog'

/**
 * A turn's file changes under its answer: a chip with the totals that opens the list of files, their diffs, and
 * undoing (or redoing) the turn or one file. The snapshots come from the host that runs the conversation.
 */

/** What every turn of the conversation shares: where its snapshots live and whether undo can run now. */
interface TurnChangesScope {
  conversationId: string
  /** No undo here: the transcript is read-only. */
  readOnly: boolean
  /** A turn of this conversation is running; undo waits for it. */
  running: boolean
  refresh: () => void
}

/** One turn's changes, as the answer that turn wrote receives them. */
export interface TurnChangesEntry {
  record: TurnSnapshotSummary
  scope: TurnChangesScope
}

export interface TurnChangesState {
  /** By assistant message; an entry keeps its identity until its record changes, so answers do not re-render. */
  byMessage: ReadonlyMap<string, TurnChangesEntry>
}

/** Follows the snapshots of a conversation's turns on the host that runs it. */
export function useTurnChangesState(conversationId: string, running: boolean, readOnly = false): TurnChangesState {
  const api = useHostApi()
  const [records, setRecords] = useState<TurnSnapshotSummary[]>([])
  const refresh = useCallback(() => {
    // A host without snapshots (an older version, for one) just shows no changes.
    api
      .turnSnapshotsList(conversationId)
      .then((list) => setRecords(list.records))
      .catch(() => setRecords([]))
  }, [api, conversationId])
  useEffect(() => {
    setRecords([])
    refresh()
    return api.onTurnSnapshotsChanged(conversationId, refresh)
  }, [api, conversationId, refresh])
  return useMemo(() => {
    const scope: TurnChangesScope = { conversationId, readOnly, running, refresh }
    const byMessage = new Map<string, TurnChangesEntry>()
    for (const record of records)
      if (record.assistantMessageId) byMessage.set(record.assistantMessageId, { record, scope })
    return { byMessage }
  }, [conversationId, readOnly, running, records, refresh])
}

/** The turn's changes worth showing under `message`, if any. */
export function visibleTurnChanges(message: ChatMessage, entry: TurnChangesEntry | undefined): TurnChangesEntry | null {
  if (!entry || message.role !== 'assistant') return null
  const { record } = entry
  if (record.status === 'ready' || record.status === 'expired') return record.totals?.files ? entry : null
  if (record.status === 'unavailable') return touchesFiles(message) ? entry : null
  return null
}

/** The turn ran a command or wrote a file, so a missing snapshot is worth mentioning. */
function touchesFiles(message: ChatMessage): boolean {
  return message.parts.some((part) => {
    if (part.type !== 'tool') return false
    const category = toolCategory(part.toolName)
    return category === 'edit' || category === 'command'
  })
}

const STATUS_LETTER = { added: 'A', modified: 'M', deleted: 'D' } as const
const STATUS_CLASS = {
  added: 'border-status-ready/40 text-status-ready',
  modified: 'border-amber-400/40 text-amber-300',
  deleted: 'border-destructive/50 text-destructive',
} as const

/** 2 MiB of diffs per panel: each file shows at most 256 KiB. */
const MAX_OPEN_DIFFS = 8

function Totals({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="font-mono tabular-nums">
      <span className="text-status-ready">+{additions}</span> <span className="text-destructive">−{deletions}</span>
    </span>
  )
}

export function TurnChanges({ entry }: { entry: TurnChangesEntry }) {
  const { t } = useTranslation('chat')
  const [open, setOpen] = useState(false)
  const { record, scope } = entry

  if (record.status === 'unavailable') {
    const reason = record.unavailableReason ?? 'failed'
    return (
      <span
        data-testid="turn-changes-unavailable"
        title={t(`turnChanges.reasons.${reason}`)}
        className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground/80"
      >
        <Undo2 className="size-3 opacity-60" />
        {t('turnChanges.unavailable')}
      </span>
    )
  }

  const totals = record.totals!
  const allUndone = record.undone > 0 && record.undone >= totals.files
  return (
    <>
      <button
        type="button"
        data-testid="turn-changes-chip"
        aria-expanded={open}
        title={t('turnChanges.chipTitle')}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-white/[0.06] hover:text-foreground',
          open && 'bg-white/[0.04] text-foreground'
        )}
      >
        <FileDiff className="size-3.5 opacity-70" />
        {allUndone ? (
          <span>{t('turnChanges.undone')}</span>
        ) : (
          <>
            <span>{t('turnChanges.files', { count: totals.files })}</span>
            <Totals additions={totals.additions} deletions={totals.deletions} />
            {record.undone > 0 && (
              <span className="text-muted-foreground/80">
                · {t('turnChanges.partlyUndone', { count: record.undone })}
              </span>
            )}
          </>
        )}
        <ChevronRight className={cn('size-3 opacity-60 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="basis-full">
          <TurnChangesPanel record={record} scope={scope} />
        </div>
      )}
    </>
  )
}

function TurnChangesPanel({ record, scope: context }: { record: TurnSnapshotSummary; scope: TurnChangesScope }) {
  const { t } = useTranslation('chat')
  const api = useHostApi()
  const [detail, setDetail] = useState<TurnSnapshotDetail | null | 'failed'>(null)
  const [openDiffs, setOpenDiffs] = useState<string[]>([])
  const [request, setRequest] = useState<UndoTurnRequest | null>(null)
  // The list follows each undo and redo, which change the record's summary.
  useEffect(() => {
    let alive = true
    api
      .turnSnapshotDetail(context.conversationId, record.id)
      .then((value) => alive && setDetail(value ?? 'failed'))
      .catch(() => alive && setDetail('failed'))
    return () => {
      alive = false
    }
  }, [api, context.conversationId, record.id, record.undone, record.status])

  if (detail === null) return <p className="py-1 text-[12px] text-muted-foreground">{t('turnChanges.loading')}</p>
  if (detail === 'failed')
    return <p className="py-1 text-[12px] text-muted-foreground">{t('turnChanges.loadFailed')}</p>

  const expired = detail.status === 'expired'
  const canAct = !context.readOnly && !expired
  const pending = detail.files.filter((file) => file.revert !== 'undone')
  const undone = detail.files.filter((file) => file.revert === 'undone')
  const toggleDiff = (key: string) =>
    setOpenDiffs((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]))

  return (
    <div
      data-testid="turn-changes-panel"
      className="mt-1 flex min-w-0 flex-col overflow-hidden rounded-lg border border-border text-[12px]"
    >
      <ul className="flex flex-col divide-y divide-border">
        {detail.files.map((file) => {
          const key = `${file.root}:${file.path}`
          const shown = openDiffs.includes(key)
          return (
            <li key={key} className="min-w-0">
              <TurnFileRow
                file={file}
                roots={detail.roots}
                diffOpen={shown}
                onToggleDiff={() => toggleDiff(key)}
                action={
                  !canAct
                    ? null
                    : file.revert === 'undone'
                      ? { label: t('turnChanges.redoFile'), icon: 'redo' }
                      : { label: t('turnChanges.undoFile'), icon: 'undo' }
                }
                disabled={context.running}
                onAction={() =>
                  setRequest({
                    recordId: detail.id,
                    action: file.revert === 'undone' ? 'redo' : 'undo',
                    files: [{ root: file.root, path: file.path }],
                    roots: detail.roots,
                  })
                }
              />
              {shown &&
                (openDiffs.indexOf(key) < MAX_OPEN_DIFFS ? (
                  <TurnFileDiff
                    conversationId={context.conversationId}
                    recordId={detail.id}
                    file={file}
                    unavailable={expired}
                  />
                ) : (
                  <p className="px-2 pb-2 text-muted-foreground">{t('turnChanges.panelBudget')}</p>
                ))}
            </li>
          )
        })}
      </ul>
      {(detail.truncated || expired || canAct) && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border bg-white/[0.02] px-2 py-1.5">
          {detail.truncated && (
            <span className="text-muted-foreground">{t('turnChanges.truncated', { count: detail.files.length })}</span>
          )}
          {expired && <span className="text-muted-foreground">{t('turnChanges.expiredNote')}</span>}
          {canAct && (
            <div className="ml-auto flex items-center gap-1.5">
              {undone.length > 0 && (
                <button
                  type="button"
                  data-testid="turn-changes-redo"
                  disabled={context.running}
                  onClick={() => setRequest({ recordId: detail.id, action: 'redo', roots: detail.roots })}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground disabled:opacity-50"
                >
                  <Redo2 className="size-3.5" />
                  {t('turnChanges.redoTurn')}
                </button>
              )}
              {pending.length > 0 && (
                <button
                  type="button"
                  data-testid="turn-changes-undo"
                  disabled={context.running}
                  onClick={() => setRequest({ recordId: detail.id, action: 'undo', roots: detail.roots })}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-foreground hover:bg-white/[0.06] disabled:opacity-50"
                >
                  <Undo2 className="size-3.5" />
                  {undone.length > 0 ? t('turnChanges.undoRest', { count: pending.length }) : t('turnChanges.undoTurn')}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {request && (
        <UndoTurnDialog
          conversationId={context.conversationId}
          request={request}
          onClose={() => setRequest(null)}
          onDone={context.refresh}
        />
      )}
    </div>
  )
}

function TurnFileRow({
  file,
  roots,
  diffOpen,
  onToggleDiff,
  action,
  disabled,
  onAction,
}: {
  file: TurnFileChange & { revert?: 'undone' | 'redone' }
  roots: TurnSnapshotRoot[]
  diffOpen: boolean
  onToggleDiff: () => void
  action: { label: string; icon: 'undo' | 'redo' } | null
  disabled: boolean
  onAction: () => void
}) {
  const { t } = useTranslation('chat')
  const display = turnFileDisplayPath(roots, file)
  const undone = file.revert === 'undone'
  return (
    <div className="flex min-w-0 items-center gap-2 px-2 py-1">
      <button
        type="button"
        aria-expanded={diffOpen}
        title={diffOpen ? t('turnChanges.hideDiff') : t('turnChanges.showDiff')}
        onClick={onToggleDiff}
        className="flex min-w-0 flex-1 items-center gap-2 rounded text-left hover:text-foreground"
      >
        <ChevronRight className={cn('size-3 shrink-0 opacity-50 transition-transform', diffOpen && 'rotate-90')} />
        <span
          title={t(`turnChanges.status.${file.status}`)}
          className={cn(
            'inline-flex size-4 shrink-0 items-center justify-center rounded border font-mono text-[10px]',
            STATUS_CLASS[file.status]
          )}
        >
          {STATUS_LETTER[file.status]}
        </span>
        <span
          className={cn('truncate font-mono text-[11.5px] text-foreground/90', undone && 'line-through opacity-60')}
        >
          {display}
        </span>
      </button>
      {undone && <span className="shrink-0 text-[11px] text-muted-foreground">{t('turnChanges.undoneFile')}</span>}
      {file.large ? (
        <span className="shrink-0 text-[11px] text-muted-foreground" title={t('turnChanges.large')}>
          &gt;10 MB
        </span>
      ) : file.binary ? (
        <span className="shrink-0 text-[11px] text-muted-foreground">{t('turnChanges.binary')}</span>
      ) : (
        <span className="shrink-0 text-[11px]">
          <Totals additions={file.additions} deletions={file.deletions} />
        </span>
      )}
      {action && (
        <button
          type="button"
          title={action.label}
          aria-label={`${action.label}: ${display}`}
          disabled={disabled}
          onClick={onAction}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground disabled:opacity-50"
        >
          {action.icon === 'undo' ? <Undo2 className="size-3.5" /> : <Redo2 className="size-3.5" />}
        </button>
      )}
    </div>
  )
}
