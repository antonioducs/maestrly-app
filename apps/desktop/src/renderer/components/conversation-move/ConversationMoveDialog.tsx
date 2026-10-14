import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowRightLeft, CheckCircle2, GitBranch, Loader2, RotateCcw, ShieldAlert } from 'lucide-react'
import type { MovePreview } from '../../../preload'
import type { HostId } from '../../../shared/host-key'
import { IgnoredEntriesChecklist, formatBytes } from '@/components/conversation-migration/IgnoredEntriesChecklist'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { canExecuteMove, missingMoveConfirmations, type MoveFlowState, previewOf } from '@/lib/conversation-move/flow'

interface Props {
  state: MoveFlowState
  hostLabel: (hostId: HostId) => string
  onClose: () => void
  onExecute: () => void
  onBranchChange: (value: string) => void
  onApplyBranch: () => void
  onToggleIgnored: (path: string) => void
  onConfirmSensitive: (path: string) => void
  onResolve: (action: 'continue' | 'rollback') => void
}

export function ConversationMoveDialog({
  state,
  hostLabel,
  onClose,
  onExecute,
  onBranchChange,
  onApplyBranch,
  onToggleIgnored,
  onConfirmSensitive,
  onResolve,
}: Props) {
  const { t } = useTranslation('ui')
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (state.kind !== 'preview') return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [state.kind])

  const preview = previewOf(state)
  const busy = state.kind === 'preparing' || state.kind === 'executing'
  const targetHostId = state.kind === 'preparing' ? state.targetHostId : preview?.targetHostId
  const target = targetHostId ? hostLabel(targetHostId) : ''
  const name = state.kind === 'preparing' ? state.conversationName : (preview?.conversationName ?? '')

  return (
    <Dialog open={state.kind !== 'idle'} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-h-[88vh] max-w-2xl overflow-y-auto"
        closeLabel={t('common.close')}
        aria-busy={busy}
        onEscapeKeyDown={(event) => busy && event.preventDefault()}
        onPointerDownOutside={(event) => busy && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeft className="size-4" /> {t('conversationMove.title', { target })}
          </DialogTitle>
          <DialogDescription>{t('conversationMove.description', { name })}</DialogDescription>
        </DialogHeader>

        {state.kind === 'preparing' && (
          <div className="flex items-center gap-2 py-6 text-sm" role="status" aria-live="polite">
            <Loader2 className="size-4 animate-spin" /> {t('conversationMove.preparing')}
          </div>
        )}

        {state.kind === 'preview' && (
          <PreviewBody
            preview={state.preview}
            selected={state.selected}
            confirmed={state.confirmed}
            branchDraft={state.branchDraft}
            expired={state.preview.expiresAt <= now}
            onBranchChange={onBranchChange}
            onApplyBranch={onApplyBranch}
            onToggleIgnored={onToggleIgnored}
            onConfirmSensitive={onConfirmSensitive}
          />
        )}

        {state.kind === 'executing' && (
          <Progress
            phase={state.event?.phase ?? 'freezing'}
            transfer={state.event?.transfer}
            clone={state.event?.clone}
          />
        )}

        {state.kind === 'done' && (
          <div className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm" role="status">
            {state.result.status === 'completed' ? (
              <>
                <span className="flex items-center gap-2 font-medium">
                  <CheckCircle2 className="size-4 text-emerald-400" /> {t('conversationMove.done', { target })}
                </span>
                <span className="text-xs text-muted-foreground">{t('conversationMove.doneDetails')}</span>
              </>
            ) : (
              <span className="flex items-center gap-2">
                <RotateCcw className="size-4" /> {t('conversationMove.rolledBack')}
              </span>
            )}
          </div>
        )}

        {state.kind === 'error' && (
          <div
            className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
            role="alert"
          >
            <span className="flex items-center gap-2 font-medium text-destructive">
              <ShieldAlert className="size-4" />
              {state.recovery
                ? t('conversationMove.stoppedAt', { phase: t(`conversationMove.phase.${state.recovery.phase}`) })
                : t('conversationMove.failed')}
            </span>
            <span className="text-xs">
              {t(`conversationMove.error.${state.recovery?.errorCode ?? 'unknown'}`, {
                defaultValue: state.message || state.recovery?.message || '',
              })}
            </span>
            {state.recovery?.errorCode && state.message && (
              <details className="text-xs text-muted-foreground">
                <summary>{t('conversationMove.details')}</summary>
                <pre className="mt-1 whitespace-pre-wrap font-mono">{state.message}</pre>
              </details>
            )}
            {state.recovery && !state.recovery.canRollback && (
              <span className="text-xs text-muted-foreground">{t('conversationMove.onlyContinue')}</span>
            )}
          </div>
        )}

        <DialogFooter>
          {state.kind === 'error' && state.recovery ? (
            <>
              <Button variant="ghost" onClick={onClose}>
                {t('conversationMove.actions.later')}
              </Button>
              <Button variant="outline" disabled={!state.recovery.canRollback} onClick={() => onResolve('rollback')}>
                <RotateCcw /> {t('conversationMove.actions.rollback')}
              </Button>
              <Button disabled={!state.recovery.canContinue} onClick={() => onResolve('continue')}>
                <GitBranch /> {t('conversationMove.actions.continue')}
              </Button>
            </>
          ) : state.kind === 'done' || state.kind === 'error' ? (
            <Button onClick={onClose}>{t('common.close')}</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                {t('common.cancel')}
              </Button>
              <Button onClick={onExecute} disabled={!canExecuteMove(state, now)}>
                {state.kind === 'executing' && <Loader2 className="animate-spin" />}
                {state.kind === 'executing' ? t('conversationMove.actions.moving') : t('conversationMove.actions.move')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PreviewBody({
  preview,
  selected,
  confirmed,
  branchDraft,
  expired,
  onBranchChange,
  onApplyBranch,
  onToggleIgnored,
  onConfirmSensitive,
}: {
  preview: MovePreview
  selected: string[]
  confirmed: string[]
  branchDraft: string
  expired: boolean
  onBranchChange: (value: string) => void
  onApplyBranch: () => void
  onToggleIgnored: (path: string) => void
  onConfirmSensitive: (path: string) => void
}) {
  const { t } = useTranslation('ui')
  const { target } = preview
  const missing = missingMoveConfirmations(preview, selected, confirmed)
  const branchEdited = !!target && branchDraft.trim() !== target.branch
  const workspace = target?.workspace
  return (
    <div className="flex flex-col gap-4 text-sm">
      {preview.blockers.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3" role="alert">
          <div className="mb-2 flex items-center gap-1.5 font-medium text-destructive">
            <ShieldAlert className="size-4" /> {t('conversationMove.blockersTitle')}
          </div>
          <ul className="space-y-2 text-xs">
            {preview.blockers.map((blocker, index) => (
              <li key={`${blocker.code}-${index}`}>
                {t(`conversationMove.blocker.${blocker.code}`, { defaultValue: blocker.message })}
                <details className="mt-1 text-muted-foreground">
                  <summary>{t('conversationMove.details')}</summary>
                  <pre className="mt-1 whitespace-pre-wrap font-mono">
                    {[blocker.message, ...(blocker.paths ?? [])].join('\n')}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
        </div>
      )}

      {workspace && (
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border border-border p-3 text-xs">
          <span className="text-muted-foreground">{t('conversationMove.project.label')}</span>
          <span className="break-all">
            {workspace.kind === 'existing'
              ? t('conversationMove.project.existing', { name: workspace.name, path: workspace.path })
              : workspace.kind === 'clone'
                ? t('conversationMove.project.clone', { url: workspace.remoteUrl, folder: workspace.parentPath })
                : t('conversationMove.project.adopt', { path: workspace.path })}
          </span>
          <span className="text-muted-foreground">{t('conversationMove.source')}</span>
          <span className="font-mono">
            {preview.source.branch} · {preview.source.headOid.slice(0, 10)}
          </span>
          <span className="text-muted-foreground">{t('conversationMove.transcriptLabel')}</span>
          <span>
            {t('conversationMove.transcript', {
              messages: preview.transcript.messages,
              files: preview.transcript.files,
              size: formatBytes(preview.transcript.fileBytes),
            })}
          </span>
        </div>
      )}

      {target && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="conversation-move-branch">{t('conversationMove.branch.label')}</Label>
          <div className="flex gap-2">
            <Input
              id="conversation-move-branch"
              value={branchDraft}
              onChange={(event) => onBranchChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && branchEdited && branchDraft.trim()) onApplyBranch()
              }}
            />
            <Button variant="outline" disabled={!branchEdited || !branchDraft.trim()} onClick={onApplyBranch}>
              {t('conversationMove.branch.apply')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t(`conversationMove.branch.action.${target.branchAction}`)}</p>
          {preview.warnings.includes('branch-renamed') && (
            <p className="text-xs text-amber-200">{t('conversationMove.branch.renamed')}</p>
          )}
        </div>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">{t('conversationMove.changes.title')}</h3>
        <ul className="grid gap-1 rounded-md border border-border p-3 text-xs sm:grid-cols-2">
          <li>{t('conversationMove.changes.commitsAhead', { count: preview.source.commitsAhead })}</li>
          <li>{t('conversationMove.changes.staged', { count: preview.source.changes.staged.length })}</li>
          <li>{t('conversationMove.changes.unstaged', { count: preview.source.changes.unstaged.length })}</li>
          <li>{t('conversationMove.changes.untracked', { count: preview.source.changes.untracked.length })}</li>
        </ul>
      </section>

      {preview.ignored.length > 0 && (
        <section className="flex flex-col gap-2" aria-labelledby="move-ignored-heading">
          <div>
            <h3 id="move-ignored-heading" className="text-sm font-medium">
              {t('conversationMove.ignored.title')}
            </h3>
            <p className="text-xs text-muted-foreground">{t('conversationMove.ignored.description')}</p>
          </div>
          <IgnoredEntriesChecklist
            entries={preview.ignored}
            selected={selected}
            confirmed={confirmed}
            disabled={false}
            onToggle={(path) => onToggleIgnored(path)}
            onConfirm={(path) => onConfirmSensitive(path)}
          />
        </section>
      )}

      {preview.warnings.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">{t('conversationMove.warningsTitle')}</h3>
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            {preview.warnings
              .filter((warning) => warning !== 'branch-renamed')
              .map((warning) => (
                <li key={warning}>{t(`conversationMove.warning.${warning}`)}</li>
              ))}
          </ul>
        </section>
      )}

      {expired && (
        <div
          className="flex items-start gap-2 rounded-md border border-amber-400/30 bg-amber-400/10 p-3 text-xs text-amber-100"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {t('conversationMove.expired')}
        </div>
      )}
      {missing.length > 0 && (
        <p className="text-xs text-amber-200" role="alert">
          {t('conversationMove.sensitiveMissing', { count: missing.length })}
        </p>
      )}
    </div>
  )
}

function Progress({
  phase,
  transfer,
  clone,
}: {
  phase: string
  transfer?: { doneBytes: number; size: number }
  clone?: { phase: string; percent?: number }
}) {
  const { t } = useTranslation('ui')
  const percent =
    phase === 'transferring' && transfer && transfer.size > 0
      ? Math.round((transfer.doneBytes / transfer.size) * 100)
      : phase === 'preparing-target' && clone?.percent !== undefined
        ? Math.round(clone.percent)
        : null
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-primary/30 bg-primary/10 p-3 text-xs"
      role="status"
      aria-live="polite"
    >
      <span className="flex items-center gap-2">
        <Loader2 className="size-4 animate-spin" /> {t(`conversationMove.phase.${phase}`)}
      </span>
      {percent !== null && (
        <div className="h-1.5 overflow-hidden rounded bg-white/10" aria-label={`${percent}%`}>
          <div className="h-full bg-primary transition-[width]" style={{ width: `${Math.min(100, percent)}%` }} />
        </div>
      )}
      {phase === 'transferring' && transfer && (
        <span className="text-muted-foreground">
          {t('conversationMove.transferProgress', {
            done: formatBytes(transfer.doneBytes),
            total: formatBytes(transfer.size),
          })}
        </span>
      )}
    </div>
  )
}
