import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronRight, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useHostApi } from '@/lib/hosts/host-context'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  turnFileDisplayPath,
  type TurnRestoreFailure,
  type TurnRevertAction,
  type TurnRevertFile,
  type TurnRevertPreview,
  type TurnSnapshotRoot,
} from '../../../shared/turn-snapshots'
import { TurnFileDiff } from './TurnFileDiff'

/**
 * Reviewing an undo (or redo) before it touches the disk: every file with what happens to it, conflicts left out
 * until the person selects them, and other conversations that worked in the folder. Confirming writes only the
 * selected files; if any of them changed meanwhile, the review starts over.
 */

export interface UndoTurnRequest {
  recordId: string
  action: TurnRevertAction
  /** One file; the whole turn when absent. */
  files?: Array<{ root: number; path: string }>
  roots: TurnSnapshotRoot[]
}

type State =
  | { kind: 'preparing' }
  | { kind: 'ready'; token: string; preview: TurnRevertPreview; stale?: boolean }
  | { kind: 'confirming'; token: string; preview: TurnRevertPreview }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'busy' }
  | { kind: 'token-gone' }
  | { kind: 'failed'; failed: Array<{ root: number; path: string; reason: TurnRestoreFailure }> }

const keyOf = (file: { root: number; path: string }) => `${file.root}:${file.path}`

function defaultSelection(preview: TurnRevertPreview): Set<string> {
  return new Set(preview.files.filter((file) => !file.blocked && !file.conflict).map(keyOf))
}

function useNames() {
  const { i18n } = useTranslation()
  return useCallback(
    (items: Array<{ name: string }>) => {
      const names = items.map((item) => item.name)
      try {
        return new Intl.ListFormat(i18n.resolvedLanguage || i18n.language, { type: 'conjunction' }).format(names)
      } catch {
        return names.join(', ')
      }
    },
    [i18n.language, i18n.resolvedLanguage]
  )
}

export function UndoTurnDialog({
  conversationId,
  request,
  onClose,
  onDone,
}: {
  conversationId: string
  request: UndoTurnRequest
  onClose: () => void
  onDone: () => void
}) {
  const { t } = useTranslation('chat')
  const api = useHostApi()
  const names = useNames()
  const [state, setState] = useState<State>({ kind: 'preparing' })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [openDiffs, setOpenDiffs] = useState<Set<string>>(new Set())

  const show = useCallback((token: string, preview: TurnRevertPreview, stale = false) => {
    setSelected(defaultSelection(preview))
    setOpenDiffs(new Set())
    setState({ kind: 'ready', token, preview, stale })
  }, [])

  const prepare = useCallback(() => {
    setState({ kind: 'preparing' })
    api
      .turnRevertPrepare({
        conversationId,
        recordId: request.recordId,
        action: request.action,
        ...(request.files ? { files: request.files } : {}),
      })
      .then((result) => {
        if (result.status === 'ready') show(result.token, result.preview)
        else if (result.status === 'busy') setState({ kind: 'busy' })
        else setState({ kind: 'unavailable', reason: result.reason })
      })
      .catch(() => setState({ kind: 'unavailable', reason: 'failed' }))
  }, [api, conversationId, request, show])

  useEffect(prepare, [prepare])

  const preview = state.kind === 'ready' || state.kind === 'confirming' ? state.preview : null
  const chosen = useMemo(
    () => (preview ? preview.files.filter((file) => !file.blocked && selected.has(keyOf(file))) : []),
    [preview, selected]
  )
  const overwriting = chosen.filter((file) => file.conflict)

  const confirm = () => {
    if (state.kind !== 'ready' || !chosen.length) return
    const refs = (files: TurnRevertFile[]) => files.map(({ root, path }) => ({ root, path }))
    setState({ kind: 'confirming', token: state.token, preview: state.preview })
    api
      .turnRevertConfirm({ token: state.token, files: refs(chosen), overwrite: refs(overwriting) })
      .then((result) => {
        if (result.status === 'reverted') {
          onDone()
          if (result.failed.length) setState({ kind: 'failed', failed: result.failed })
          else onClose()
        } else if (result.status === 'stale') show(result.token, result.preview, true)
        else if (result.status === 'busy') setState({ kind: 'busy' })
        else setState({ kind: 'token-gone' })
      })
      .catch(() => setState({ kind: 'unavailable', reason: 'failed' }))
  }

  const undo = request.action === 'undo'
  const confirming = state.kind === 'confirming'
  const toggle = (key: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })

  return (
    <Dialog open onOpenChange={(open) => !open && !confirming && onClose()}>
      <DialogContent
        data-testid="undo-turn-dialog"
        className="max-h-[88vh] max-w-3xl overflow-y-auto"
        closeLabel={t('turnChanges.dialog.close')}
        aria-busy={state.kind === 'preparing' || confirming}
        onEscapeKeyDown={(event) => confirming && event.preventDefault()}
        onPointerDownOutside={(event) => confirming && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t(undo ? 'turnChanges.dialog.undoTitle' : 'turnChanges.dialog.redoTitle')}</DialogTitle>
          <DialogDescription>
            {t(undo ? 'turnChanges.dialog.undoDescription' : 'turnChanges.dialog.redoDescription')}
          </DialogDescription>
        </DialogHeader>

        {state.kind === 'preparing' && (
          <p className="text-sm text-muted-foreground">{t('turnChanges.dialog.preparing')}</p>
        )}
        {state.kind === 'unavailable' && (
          <p className="text-sm text-muted-foreground">
            {t(`turnChanges.reasons.${state.reason}`, { defaultValue: t('turnChanges.reasons.failed') })}
          </p>
        )}
        {state.kind === 'busy' && <Banner tone="warning">{t('turnChanges.dialog.busy')}</Banner>}
        {state.kind === 'token-gone' && <Banner tone="warning">{t('turnChanges.dialog.tokenGone')}</Banner>}
        {state.kind === 'failed' && (
          <div className="flex flex-col gap-2" role="alert">
            <p className="text-sm font-medium text-destructive">{t('turnChanges.dialog.failedTitle')}</p>
            <ul className="flex flex-col gap-1 text-xs">
              {state.failed.map((file) => (
                <li key={keyOf(file)} className="flex min-w-0 gap-2">
                  <span className="truncate font-mono">{turnFileDisplayPath(request.roots, file)}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {t(`turnChanges.dialog.failure.${file.reason}`)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {preview && (
          <div className="flex min-w-0 flex-col gap-3 text-sm">
            {state.kind === 'ready' && state.stale && <Banner tone="warning">{t('turnChanges.dialog.stale')}</Banner>}
            {preview.othersRunning.length > 0 && (
              <Banner tone="warning">
                {t('turnChanges.dialog.othersRunning', { names: names(preview.othersRunning) })}
              </Banner>
            )}
            {preview.overlap.length > 0 && (
              <Banner tone="info">{t('turnChanges.dialog.overlap', { names: names(preview.overlap) })}</Banner>
            )}
            <ul
              data-testid="undo-turn-files"
              className="flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border"
            >
              {preview.files.map((file) => {
                const key = keyOf(file)
                const checked = !file.blocked && selected.has(key)
                const diffOpen = openDiffs.has(key)
                const display = turnFileDisplayPath(request.roots, file)
                return (
                  <li
                    key={key}
                    data-testid="undo-turn-file"
                    data-path={file.path}
                    className={cn('min-w-0', file.conflict && 'bg-amber-400/[0.05]')}
                  >
                    <div className="flex min-w-0 items-start gap-2 px-2 py-1.5">
                      <Checkbox
                        checked={checked}
                        disabled={!!file.blocked || confirming}
                        label={display}
                        warn={!!file.conflict}
                        onChange={(on) => toggle(key, on)}
                      />
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className={cn(
                              'shrink-0 rounded border px-1 text-[10px] uppercase tracking-wide',
                              file.effect === 'delete'
                                ? 'border-destructive/50 text-destructive'
                                : file.effect === 'recreate'
                                  ? 'border-status-ready/40 text-status-ready'
                                  : 'border-border text-muted-foreground'
                            )}
                          >
                            {t(`turnChanges.dialog.effect.${file.effect}`)}
                          </span>
                          <span className={cn('truncate font-mono text-xs', file.blocked && 'opacity-60')}>
                            {display}
                          </span>
                          {!file.blocked && (
                            <button
                              type="button"
                              aria-expanded={diffOpen}
                              title={diffOpen ? t('turnChanges.hideDiff') : t('turnChanges.showDiff')}
                              onClick={() =>
                                setOpenDiffs((current) => {
                                  const next = new Set(current)
                                  if (!next.delete(key)) next.add(key)
                                  return next
                                })
                              }
                              className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
                            >
                              <ChevronRight className={cn('size-3.5 transition-transform', diffOpen && 'rotate-90')} />
                            </button>
                          )}
                        </div>
                        {file.conflict && (
                          <p className="flex items-start gap-1 text-xs text-amber-300">
                            <TriangleAlert className="mt-0.5 size-3 shrink-0" />
                            <span>
                              {t(`turnChanges.dialog.conflict.${file.conflict}`)}
                              {file.maybeFrom?.length
                                ? ` · ${t('turnChanges.dialog.maybeFrom', { names: names(file.maybeFrom) })}`
                                : ''}
                              {!checked && ` — ${t('turnChanges.dialog.conflictHint')}`}
                            </span>
                          </p>
                        )}
                        {file.blocked && (
                          <p className="text-xs text-muted-foreground">
                            {t(`turnChanges.dialog.blocked.${file.blocked}`)}
                          </p>
                        )}
                      </div>
                    </div>
                    {diffOpen && state.kind !== 'confirming' && (
                      <TurnFileDiff
                        conversationId={conversationId}
                        recordId={request.recordId}
                        file={file}
                        token={state.kind === 'ready' ? state.token : undefined}
                      />
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        <DialogFooter>
          {(state.kind === 'busy' || state.kind === 'token-gone') && (
            <Button variant="outline" onClick={prepare}>
              {t('turnChanges.dialog.reviewAgain')}
            </Button>
          )}
          <Button variant="ghost" disabled={confirming} onClick={onClose}>
            {preview ? t('turnChanges.dialog.cancel') : t('turnChanges.dialog.close')}
          </Button>
          {preview && (
            <Button
              data-testid="undo-turn-confirm"
              variant={overwriting.length ? 'destructive' : 'default'}
              disabled={!chosen.length || confirming}
              onClick={confirm}
            >
              {t(undo ? 'turnChanges.dialog.undoConfirm' : 'turnChanges.dialog.redoConfirm', { count: chosen.length })}
              {overwriting.length > 0 && ` ${t('turnChanges.dialog.overwrites', { count: overwriting.length })}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Banner({ tone, children }: { tone: 'warning' | 'info'; children: ReactNode }) {
  return (
    <div
      role={tone === 'warning' ? 'alert' : 'note'}
      className={cn(
        'rounded-md border px-3 py-2 text-xs',
        tone === 'warning'
          ? 'border-amber-400/30 bg-amber-400/10 text-amber-100'
          : 'border-border bg-white/[0.03] text-muted-foreground'
      )}
    >
      {children}
    </div>
  )
}

function Checkbox({
  checked,
  disabled,
  label,
  warn,
  onChange,
}: {
  checked: boolean
  disabled: boolean
  label: string
  warn: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded border transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40',
        checked
          ? warn
            ? 'border-amber-400 bg-amber-400 text-black'
            : 'border-primary bg-primary text-primary-foreground'
          : warn
            ? 'border-amber-400/60'
            : 'border-input'
      )}
    >
      {checked && <Check className="size-3" strokeWidth={3} />}
    </button>
  )
}
