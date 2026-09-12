import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Info, Loader2, ShieldAlert } from 'lucide-react'
import type { ConversationMigrationDialogState } from './flow'
import { canExecuteConversationMigration, missingSensitiveConfirmations } from './flow'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface Props {
  state: ConversationMigrationDialogState
  onDestinationBranchChange: (value: string) => void
  onPrepare: () => void
  onClose: () => void
  onEditBranch: () => void
  onIgnoredChange: (path: string, selected: boolean, sensitive: boolean) => void
  onSensitiveConfirmationChange: (path: string, confirmed: boolean) => void
  onExecute: () => void
}

export function ConversationMigrationDialog({
  state,
  onDestinationBranchChange,
  onPrepare,
  onClose,
  onEditBranch,
  onIgnoredChange,
  onSensitiveConfirmationChange,
  onExecute,
}: Props) {
  const { t } = useTranslation('ui')
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!state.preview || state.busy === 'executing') return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [state.preview, state.busy])

  const preview = state.preview
  const mutating = state.busy !== null
  const expired = !!preview && preview.expiresAt <= now
  const missingConfirmations = preview
    ? missingSensitiveConfirmations(preview, state.selectedIgnoredPaths, state.confirmedSensitivePaths)
    : []
  const phase = state.progress?.phase ?? (state.busy === 'executing' ? 'transferring' : null)

  return (
    <Dialog open={state.open} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-h-[88vh] max-w-2xl overflow-y-auto"
        closeLabel={t('common.close')}
        aria-busy={state.busy !== null}
        onEscapeKeyDown={(event) => mutating && event.preventDefault()}
        onPointerDownOutside={(event) => mutating && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t('conversationMigration.title')}</DialogTitle>
          <DialogDescription>
            {preview
              ? t('conversationMigration.previewDescription')
              : t('conversationMigration.description', { name: state.conversation?.name ?? '' })}
          </DialogDescription>
        </DialogHeader>

        {!preview ? (
          <div className="flex flex-col gap-4 py-1">
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border border-border p-3 text-xs">
              <span className="text-muted-foreground">{t('conversationMigration.currentBranch')}</span>
              <span className="font-mono">{state.conversation?.branch}</span>
              <span className="text-muted-foreground">{t('conversationMigration.currentFolder')}</span>
              <span className="truncate font-mono" title={state.conversation?.cwd}>
                {state.conversation?.cwd}
              </span>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="conversation-migration-branch">{t('conversationMigration.destinationBranch')}</Label>
              <Input
                id="conversation-migration-branch"
                autoFocus
                value={state.destinationBranch}
                placeholder={t('conversationMigration.branchPlaceholder')}
                disabled={state.busy !== null}
                onChange={(event) => onDestinationBranchChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && state.destinationBranch.trim() && !state.busy) onPrepare()
                }}
              />
              <p className="text-xs text-muted-foreground">{t('conversationMigration.prepareWarning')}</p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4 text-sm">
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border border-border p-3 text-xs">
              <span className="text-muted-foreground">{t('conversationMigration.source')}</span>
              <span className="font-mono">
                {preview.sourceBranch} · {shortOid(preview.sourceHeadOid)}
              </span>
              <span className="text-muted-foreground">{t('conversationMigration.destination')}</span>
              <span className="font-mono">{preview.destinationBranch}</span>
              <span className="text-muted-foreground">{t('conversationMigration.destinationFolder')}</span>
              <span className="truncate font-mono" title={preview.destinationCwd}>
                {preview.destinationCwd}
              </span>
            </div>

            {preview.blockers.length > 0 && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3" role="alert">
                <div className="mb-2 flex items-center gap-1.5 font-medium text-destructive">
                  <ShieldAlert className="size-4" /> {t('conversationMigration.blocked')}
                </div>
                <ul className="space-y-2 text-xs">
                  {preview.blockers.map((blocker, index) => (
                    <li key={`${blocker.code}-${index}`}>
                      {blocker.message}
                      {blocker.paths?.length ? (
                        <pre className="mt-1 whitespace-pre-wrap font-mono text-muted-foreground">
                          {blocker.paths.join('\n')}
                        </pre>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {preview.blockers.some((blocker) => BRANCH_BLOCKER_CODES.has(blocker.code)) && (
                  <Button variant="outline" size="sm" className="mt-3" disabled={mutating} onClick={onEditBranch}>
                    {t('conversationMigration.chooseAnotherBranch')}
                  </Button>
                )}
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-3">
              <ChangeList title={t('conversationMigration.staged')} files={preview.changes.staged} />
              <ChangeList title={t('conversationMigration.unstaged')} files={preview.changes.unstaged} />
              <ChangeList title={t('conversationMigration.untracked')} files={preview.changes.untracked} />
            </div>

            <section className="flex flex-col gap-2" aria-labelledby="migration-ignored-heading">
              <div>
                <h3 id="migration-ignored-heading" className="text-sm font-medium">
                  {t('conversationMigration.ignoredTitle')}
                </h3>
                <p className="text-xs text-muted-foreground">{t('conversationMigration.ignoredDescription')}</p>
              </div>
              {preview.ignored.length === 0 ? (
                <p className="rounded-md border border-border p-3 text-xs text-muted-foreground">
                  {t('conversationMigration.noIgnored')}
                </p>
              ) : (
                <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                  {preview.ignored.map((entry) => {
                    const selected = state.selectedIgnoredPaths.includes(entry.path)
                    const confirmed = state.confirmedSensitivePaths.includes(entry.path)
                    const details = (
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="break-all font-mono">{entry.path}</span>
                          <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {formatBytes(entry.size)}
                          </span>
                          {entry.sensitive && (
                            <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] text-amber-200">
                              {t('conversationMigration.sensitive')}
                            </span>
                          )}
                        </span>
                        {!entry.selectable && (
                          <span className="mt-1 block text-muted-foreground">
                            {t(`conversationMigration.ignoredReason.${entry.reasonCode ?? 'unsafe'}`)}
                          </span>
                        )}
                      </span>
                    )

                    if (!entry.selectable) {
                      return (
                        <div key={entry.path} className="rounded-md border border-border p-3 opacity-80">
                          <div className="flex items-start gap-2 text-xs">
                            <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                            {details}
                          </div>
                        </div>
                      )
                    }
                    return (
                      <div key={entry.path} className="rounded-md border border-border p-3">
                        <label className="flex items-start gap-2 text-xs">
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={selected}
                            disabled={state.busy !== null}
                            onChange={(event) => onIgnoredChange(entry.path, event.target.checked, entry.sensitive)}
                          />
                          {details}
                        </label>
                        {entry.sensitive && selected && (
                          <label className="mt-2 flex items-start gap-2 rounded border border-amber-400/30 bg-amber-400/10 p-2 text-xs text-amber-100">
                            <input
                              type="checkbox"
                              className="mt-0.5"
                              checked={confirmed}
                              disabled={state.busy !== null}
                              onChange={(event) => onSensitiveConfirmationChange(entry.path, event.target.checked)}
                            />
                            <span>{t('conversationMigration.confirmSensitive', { path: entry.path })}</span>
                          </label>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </section>

            {expired && (
              <div
                className="flex items-start gap-2 rounded-md border border-amber-400/30 bg-amber-400/10 p-3 text-xs text-amber-100"
                role="alert"
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                {t('conversationMigration.previewExpired')}
              </div>
            )}
            {missingConfirmations.length > 0 && (
              <p className="text-xs text-amber-200" role="alert">
                {t('conversationMigration.sensitiveMissing', { count: missingConfirmations.length })}
              </p>
            )}
            {state.busy === 'executing' && (
              <div
                className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/10 p-3 text-xs"
                role="status"
                aria-live="polite"
              >
                <Loader2 className="size-4 animate-spin" />
                {t(`conversationMigration.phase.${phase ?? 'transferring'}`)}
              </div>
            )}
          </div>
        )}

        {state.error && (
          <p className="text-sm text-destructive" role="alert">
            {state.error}
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={mutating || state.busy === 'canceling'}>
            {state.busy === 'canceling' ? t('conversationMigration.canceling') : t('common.cancel')}
          </Button>
          {preview && (
            <Button variant="outline" onClick={onEditBranch} disabled={mutating}>
              {t('conversationMigration.chooseAnotherBranch')}
            </Button>
          )}
          {!preview ? (
            <Button onClick={onPrepare} disabled={!state.destinationBranch.trim() || state.busy !== null}>
              {state.busy === 'preparing' && <Loader2 className="animate-spin" />}
              {state.busy === 'preparing' ? t('conversationMigration.preparing') : t('conversationMigration.prepare')}
            </Button>
          ) : (
            <Button onClick={onExecute} disabled={!canExecuteConversationMigration(state, now)}>
              {state.busy === 'executing' && <Loader2 className="animate-spin" />}
              {state.busy === 'executing' ? t('conversationMigration.migrating') : t('conversationMigration.execute')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const BRANCH_BLOCKER_CODES = new Set(['branch-exists', 'branch-in-worktree', 'branch-invalid'])

function ChangeList({ title, files }: { title: string; files: string[] }) {
  const { t } = useTranslation('ui')
  return (
    <section className="min-w-0 rounded-md border border-border p-2">
      <h3 className="mb-1 text-xs font-medium">
        {title} ({files.length})
      </h3>
      {files.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{t('conversationMigration.noChanges')}</p>
      ) : (
        <div className="max-h-28 overflow-y-auto font-mono text-[11px]">
          {files.map((file) => (
            <div key={file} className="truncate" title={file}>
              {file}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function shortOid(oid: string): string {
  return oid.slice(0, 10)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
