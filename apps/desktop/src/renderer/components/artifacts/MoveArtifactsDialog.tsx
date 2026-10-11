import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowRight, ArrowUpRight, Check, Circle, Info, Loader2, RotateCw } from 'lucide-react'
import type {
  ArtifactServerStatus,
  LegacyArtifactView,
  LegacyMoveError,
  LegacyMoveState,
} from '../../../shared/artifacts'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { formatBytes } from '@/components/chat/runtime-asset-presentation'
import { cn } from '@/lib/utils'
import { moveDialogModel } from './artifacts-view'

const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason))

/** One artifact of this computer, as the move lists it. */
export function LegacyArtifactRow({ item, trailing }: { item: LegacyArtifactView; trailing?: React.ReactNode }) {
  const { t } = useTranslation('ui')
  const meta = [
    t('artifacts.versionCount', { count: item.versionCount }),
    item.commentCount ? t('artifacts.legacy.commentCount', { count: item.commentCount }) : null,
    formatBytes(item.storageBytes),
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <li className="flex items-center gap-2.5 py-2 hairline-t first:shadow-none">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12.5px] font-medium text-foreground">{item.title}</p>
        <p className="text-[11px] text-muted-foreground">{meta}</p>
      </div>
      {trailing}
    </li>
  )
}

export function SharedTag() {
  const { t } = useTranslation('ui')
  return (
    <span className="shrink-0 rounded-full border border-border-strong px-1.5 text-[10.5px] leading-[18px] text-muted-foreground">
      {t('artifacts.legacy.shared')}
    </span>
  )
}

function Fact({ icon, children, warn }: { icon: React.ReactNode; children: React.ReactNode; warn?: boolean }) {
  return (
    <li className="flex gap-2 text-xs leading-relaxed text-foreground/80">
      <span className={cn('mt-0.5 shrink-0 text-muted-foreground [&_svg]:size-3.5', warn && 'text-artifact-warn')}>
        {icon}
      </span>
      <span>{children}</span>
    </li>
  )
}

/** Why a move stopped, in the owner's words. */
function failureText(t: ReturnType<typeof useTranslation>['t'], error: LegacyMoveError | null): string {
  if (error?.code === 'quota_exceeded')
    return t('artifacts.move.failed.quota', {
      needed: formatBytes(error.neededBytes ?? 0),
      free: formatBytes(error.freeBytes ?? 0),
    })
  if (error?.code === 'host_unavailable') return t('artifacts.move.failed.unreachable')
  if (error?.reason === 'verify_failed') return t('artifacts.move.failed.verify')
  return t('artifacts.move.failed.other', { code: error?.code ?? 'internal' })
}

/**
 * Moves this computer's artifacts to the bot server. The move runs in the main process, so this dialog can close and
 * open again on it; while it runs, it can only be stopped after the artifact being moved.
 */
export function MoveArtifactsDialog({
  items,
  server,
  move,
  onClose,
  onRaiseLimit,
  onOpenCenter,
}: {
  items: LegacyArtifactView[]
  server: ArtifactServerStatus | null
  move: LegacyMoveState
  onClose: () => void
  /** Leads to the server's storage limit. */
  onRaiseLimit: () => void
  onOpenCenter?: () => void
}) {
  const { t } = useTranslation('ui')
  // A result shows only for a move started here; a running or failed one shows whenever the dialog opens.
  const [started, setStarted] = useState(false)
  const [enabling, setEnabling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const model = moveDialogModel(items, server)
  const running = move.phase === 'running' || enabling
  const stage = running
    ? 'running'
    : move.phase === 'failed'
      ? 'failed'
      : move.phase === 'done' && started
        ? 'done'
        : 'confirm'

  const start = async () => {
    setError(null)
    setStarted(true)
    try {
      if (model.enableFirst) {
        setEnabling(true)
        await window.api.artifacts.setServerHost({ enabled: true })
      }
      await window.api.artifacts.legacyMove()
    } catch (reason) {
      setError(t('artifacts.move.startFailed', { message: message(reason) }))
    } finally {
      setEnabling(false)
    }
  }

  const all = move.items.length ? move.items : items
  const left = all.filter((item) => !move.moved.includes(item.id))
  const movedItems = all.filter((item) => move.moved.includes(item.id))

  let title: string
  let body: React.ReactNode
  let actions: React.ReactNode
  if (stage === 'confirm') {
    title = t('artifacts.move.title', { count: items.length })
    body = (
      <>
        <ul className="rounded-[10px] border border-border bg-white/[0.02] px-3" data-testid="artifacts-move-list">
          {items.map((item) => (
            <LegacyArtifactRow key={item.id} item={item} trailing={item.shared ? <SharedTag /> : null} />
          ))}
        </ul>
        <ul className="flex flex-col gap-2">
          <Fact icon={<Check />}>{t('artifacts.move.facts.content')}</Fact>
          <Fact icon={<Check />}>{t('artifacts.move.facts.safe')}</Fact>
          {model.enableFirst && <Fact icon={<Info />}>{t('artifacts.move.facts.enable')}</Fact>}
          {model.shared.length > 0 && (
            <Fact icon={<AlertTriangle />} warn>
              {model.shared.length === 1
                ? t('artifacts.move.facts.sharedOne', { title: model.shared[0]!.title })
                : t('artifacts.move.facts.sharedMany', { count: model.shared.length })}
            </Fact>
          )}
        </ul>
        {model.freeBytes !== null &&
          (model.fits ? (
            <p className="text-xs text-muted-foreground">
              {t('artifacts.move.space', {
                needed: formatBytes(model.neededBytes),
                free: formatBytes(model.freeBytes),
              })}
            </p>
          ) : (
            <div
              role="alert"
              className="flex gap-2.5 rounded-[10px] border border-destructive/30 bg-destructive/[0.08] px-3 py-2.5 text-xs"
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p>
                  {t('artifacts.move.spaceShort', {
                    missing: formatBytes(model.neededBytes - model.freeBytes),
                    needed: formatBytes(model.neededBytes),
                    free: formatBytes(model.freeBytes),
                  })}
                </p>
                <Button size="sm" variant="outline" className="mt-2" onClick={onRaiseLimit}>
                  {t('artifacts.move.raise')}
                </Button>
              </div>
            </div>
          ))}
        {model.blocked && (
          <p role="alert" className="text-xs text-artifact-warn">
            {t(`artifacts.legacy.blocked.${model.blocked}`)}
          </p>
        )}
      </>
    )
    actions = (
      <>
        <Button variant="outline" onClick={onClose}>
          {t('artifacts.move.cancel')}
        </Button>
        <Button
          data-testid="artifacts-move-confirm"
          disabled={!model.fits || model.blocked !== null || items.length === 0}
          onClick={() => void start()}
        >
          <ArrowRight className="size-3.5" /> {t('artifacts.move.confirm', { count: items.length })}
        </Button>
      </>
    )
  } else if (stage === 'running') {
    const done = move.moved.length
    title = enabling ? t('artifacts.move.enabling') : t('artifacts.move.running')
    body = (
      <>
        <div
          className="h-1 overflow-hidden rounded-full bg-white/[0.08]"
          role="progressbar"
          aria-label={t('artifacts.move.running')}
          aria-valuemin={0}
          aria-valuemax={all.length}
          aria-valuenow={done}
        >
          <i
            className="block h-full rounded-full bg-primary transition-[width]"
            style={{ width: `${Math.max(1.5, (done / Math.max(1, all.length)) * 100)}%` }}
          />
        </div>
        <ul className="rounded-[10px] border border-border bg-white/[0.02] px-3" data-testid="artifacts-move-progress">
          {all.map((item) => {
            const current = move.current?.id === item.id ? move.current : null
            const trailing = move.moved.includes(item.id) ? (
              <span className="flex items-center gap-1 text-[11px] text-status-ready">
                <Check className="size-3.5" /> {t('artifacts.move.moved')}
              </span>
            ) : current ? (
              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />{' '}
                {t(`artifacts.move.step.${current.step}`)}
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <Circle className="size-3" aria-hidden="true" /> {t('artifacts.move.queued')}
              </span>
            )
            return <LegacyArtifactRow key={item.id} item={item} trailing={trailing} />
          })}
        </ul>
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {t('artifacts.move.progress', { done, total: all.length })}
        </p>
      </>
    )
    actions = (
      <>
        <span className="mr-auto text-[11.5px] text-muted-foreground">{t('artifacts.move.closeNote')}</span>
        <Button
          variant="outline"
          disabled={move.stopping || enabling}
          onClick={() => void window.api.artifacts.legacyStop()}
        >
          {move.stopping ? t('artifacts.move.stopping') : t('artifacts.move.stop')}
        </Button>
      </>
    )
  } else if (stage === 'done') {
    const sharedMoved = movedItems.filter((item) => item.shared)
    title = left.length
      ? t('artifacts.move.partialTitle', { moved: movedItems.length, total: all.length })
      : t('artifacts.move.doneTitle', { count: movedItems.length })
    body = (
      <div className="flex gap-2.5 text-[12.5px] leading-relaxed" data-testid="artifacts-move-result">
        <Check className="mt-0.5 size-4 shrink-0 text-status-ready" aria-hidden="true" />
        <div className="flex flex-col gap-1.5">
          <p>
            {movedItems.length
              ? t('artifacts.move.doneText', { count: movedItems.length })
              : t('artifacts.move.nothingMoved')}
          </p>
          {sharedMoved.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {sharedMoved.length === 1
                ? t('artifacts.move.privateOne', { title: sharedMoved[0]!.title })
                : t('artifacts.move.privateMany', { count: sharedMoved.length })}
            </p>
          )}
          {left.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {left.length === 1
                ? t('artifacts.move.leftOne', { title: left[0]!.title })
                : t('artifacts.move.leftMany', { count: left.length })}
            </p>
          )}
        </div>
      </div>
    )
    actions = (
      <>
        {movedItems.length > 0 && onOpenCenter && (
          <Button variant="outline" onClick={onOpenCenter}>
            <ArrowUpRight className="size-3.5" /> {t('artifacts.move.openCenter')}
          </Button>
        )}
        <Button onClick={onClose}>{t('artifacts.move.finish')}</Button>
      </>
    )
  } else {
    title = t('artifacts.move.failedTitle')
    body = (
      <div
        role="alert"
        className="flex gap-2.5 rounded-[10px] border border-destructive/30 bg-destructive/[0.08] px-3 py-2.5 text-xs leading-relaxed"
        data-testid="artifacts-move-failed"
      >
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p>
            {failureText(t, move.error)}{' '}
            {movedItems.length > 0 && t('artifacts.move.alreadyMoved', { count: movedItems.length })}{' '}
            {left.length === 1
              ? t('artifacts.move.keptOne', { title: left[0]!.title })
              : t('artifacts.move.keptMany', { count: left.length })}
          </p>
          {move.error?.code === 'quota_exceeded' && (
            <Button size="sm" variant="outline" className="mt-2" onClick={onRaiseLimit}>
              {t('artifacts.move.raise')}
            </Button>
          )}
        </div>
      </div>
    )
    actions = (
      <>
        <Button variant="outline" onClick={onClose}>
          {t('artifacts.move.close')}
        </Button>
        <Button disabled={model.blocked !== null} onClick={() => void start()}>
          <RotateCw className="size-3.5" /> {t('artifacts.move.retry')}
        </Button>
      </>
    )
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !running && onClose()}>
      <DialogContent
        showClose={!running}
        data-testid="artifacts-move-dialog"
        {...(stage === 'confirm' && server?.state === 'ready' ? {} : { 'aria-describedby': undefined })}
        className="flex max-h-[min(640px,calc(100dvh-24px))] max-w-[500px] flex-col gap-3.5 overflow-hidden p-5"
        // While moving, nothing dismisses the dialog by accident.
        onEscapeKeyDown={(event) => running && event.preventDefault()}
        onPointerDownOutside={(event) => running && event.preventDefault()}
        onInteractOutside={(event) => running && event.preventDefault()}
      >
        <div>
          <DialogTitle className="text-[15px]">{title}</DialogTitle>
          {stage === 'confirm' && server?.state === 'ready' && (
            <DialogDescription className="mt-1 text-xs">{t('artifacts.move.destination')}</DialogDescription>
          )}
        </div>
        <div className="flex min-h-0 flex-col gap-3.5 overflow-y-auto">{body}</div>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>
      </DialogContent>
    </Dialog>
  )
}
