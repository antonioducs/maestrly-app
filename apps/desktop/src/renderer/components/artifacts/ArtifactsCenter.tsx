import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AppWindow, ArrowUpRight, ChevronDown, ChevronRight, MessagesSquare, PanelLeft, Trash2, X } from 'lucide-react'
import type { ArtifactDetailView, ArtifactHostStatus, ArtifactListItem } from '../../../shared/artifacts'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { formatBytes } from '@/components/chat/runtime-asset-presentation'
import { relativeTime } from '@/components/sidebar/relative-time'
import { useLocale } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { useArtifacts } from './use-artifacts'

function openConversation(conversationId: string): void {
  window.dispatchEvent(new CustomEvent('maestrly:open-conversation', { detail: { conversationId } }))
}

function HostStatusLine({
  status,
  onStart,
  onChangePort,
}: {
  status: ArtifactHostStatus | null
  onStart: () => void
  onChangePort: () => void
}) {
  const { t } = useTranslation('ui')
  if (!status) return null
  if (status.state === 'running')
    return <p className="text-xs text-muted-foreground">{t('artifacts.hostRunning', { port: status.port })}</p>
  if (status.state === 'starting') return <p className="text-xs text-muted-foreground">{t('artifacts.hostStarting')}</p>
  if (!status.problem) return <p className="text-xs text-muted-foreground">{t('artifacts.hostStopped')}</p>
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-foreground"
    >
      <span className="flex-1">{t(`artifacts.problem.${status.problem}`, { port: status.port })}</span>
      {status.problem !== 'disabled' && (
        <Button size="sm" variant="outline" onClick={onStart}>
          {t('artifacts.start')}
        </Button>
      )}
      <Button size="sm" variant="outline" onClick={onChangePort}>
        {status.problem === 'port_in_use' ? t('artifacts.changePort') : t('artifacts.openSettings')}
      </Button>
    </div>
  )
}

function ArtifactRow({
  item,
  onDelete,
  onError,
}: {
  item: ArtifactListItem
  onDelete: (item: ArtifactListItem) => void
  onError: (message: string) => void
}) {
  const { t } = useTranslation('ui')
  const [locale] = useLocale()
  const [detail, setDetail] = useState<ArtifactDetailView | null>(null)
  const [expanded, setExpanded] = useState(false)

  const open = (version?: number) =>
    window.api.artifacts.openExternal(item.id, version).catch((reason: unknown) => onError(String(reason)))
  const toggleVersions = async () => {
    if (expanded) return setExpanded(false)
    setExpanded(true)
    try {
      setDetail(await window.api.artifacts.detail(item.id))
    } catch (reason) {
      onError(String(reason))
    }
  }
  const conversation = item.conversation

  return (
    <li
      data-testid="artifact-row"
      data-artifact-id={item.id}
      className="space-y-2 rounded-lg border border-border bg-surface-elevated p-4 text-sm"
    >
      <div className="flex items-start gap-2">
        <AppWindow className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium text-foreground" title={item.title}>
              {item.title}
            </span>
            <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {t('artifacts.private')}
            </span>
          </div>
          {item.description && <p className="mt-0.5 text-xs text-muted-foreground">{item.description}</p>}
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>
              {t('artifacts.version', { version: item.currentVersion })} ·{' '}
              {t('artifacts.updated', { when: relativeTime(locale, item.updatedAt) })}
            </span>
            {conversation ? (
              conversation.exists ? (
                <button
                  type="button"
                  className="flex items-center gap-1 text-primary hover:underline"
                  onClick={() => openConversation(conversation.id)}
                >
                  <MessagesSquare className="size-3" />
                  {conversation.title ?? t('artifacts.untitledConversation')}
                </button>
              ) : (
                <span>
                  {conversation.title
                    ? t('artifacts.deletedConversation', { title: conversation.title })
                    : t('artifacts.deletedConversationUntitled')}
                </span>
              )
            ) : (
              <span>{t('artifacts.noConversation')}</span>
            )}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => void open()}>
          <ArrowUpRight className="size-3.5" /> {t('artifacts.openInBrowser')}
        </Button>
        {conversation?.exists && (
          <Button size="sm" variant="ghost" onClick={() => openConversation(conversation.id)}>
            {t('artifacts.goToConversation')}
          </Button>
        )}
        <Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => void toggleVersions()}>
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          {t('artifacts.versions', { count: item.versionCount })}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto text-destructive hover:text-destructive"
          data-testid="artifact-delete"
          onClick={() => onDelete(item)}
        >
          <Trash2 className="size-3.5" /> {t('artifacts.delete')}
        </Button>
      </div>
      {expanded && detail && (
        <ul className="space-y-1 border-t border-border pt-2">
          {detail.versions.map((version) => (
            <li key={version.number} className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="w-20 shrink-0 text-foreground">
                {t('artifacts.versionLabel', { version: version.number })}
              </span>
              <span className="min-w-0 flex-1 truncate" title={version.summary}>
                {version.summary ||
                  t('artifacts.fileSummary', { files: version.fileCount, size: formatBytes(version.totalBytes) })}
              </span>
              <span className="shrink-0">{relativeTime(locale, version.createdAt)}</span>
              <button
                type="button"
                className="shrink-0 rounded px-1.5 py-0.5 text-primary hover:bg-white/[0.06]"
                onClick={() => void open(version.number)}
              >
                {t('artifacts.openVersion')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

/** Every artifact on this computer: where it came from, its versions, and the owner's actions. */
export function ArtifactsCenter({
  onClose,
  onShowSidebar,
  onOpenSettings,
}: {
  onClose: () => void
  onShowSidebar?: () => void
  onOpenSettings: () => void
}) {
  const { t } = useTranslation('ui')
  const { items, status, loading, error, refresh } = useArtifacts()
  const [query, setQuery] = useState('')
  const [confirm, setConfirm] = useState<ArtifactListItem | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? items.filter((item) => item.title.toLowerCase().includes(needle)) : items
  }, [items, query])

  const start = async () => {
    setActionError(null)
    await window.api.artifacts.start().catch((reason: unknown) => setActionError(String(reason)))
    await refresh()
  }

  const remove = async (item: ArtifactListItem) => {
    setBusy(true)
    try {
      await window.api.artifacts.remove(item.id)
      setConfirm(null)
      await refresh()
    } catch (reason) {
      setActionError(String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col" data-testid="artifacts-center">
      <header
        className={cn(
          'drag flex h-10 shrink-0 items-center gap-2 hairline-b pr-3',
          onShowSidebar ? 'pl-[var(--tt-offset)]' : 'pl-3'
        )}
      >
        {onShowSidebar && (
          <Button
            variant="ghost"
            size="icon"
            className="no-drag size-7 text-muted-foreground"
            onClick={onShowSidebar}
            title={t('common.showWorkspaces')}
          >
            <PanelLeft className="size-4" />
          </Button>
        )}
        <AppWindow className="size-4 text-muted-foreground" />
        <span className="truncate text-[13px] font-medium text-foreground/90">{t('artifacts.title')}</span>
        <Button
          variant="ghost"
          size="icon"
          className="no-drag ml-auto size-7"
          onClick={onClose}
          title={t('common.close')}
        >
          <X className="size-4" />
        </Button>
      </header>
      <section className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-3xl space-y-5">
          <header className="space-y-2">
            <h1 className="text-xl font-semibold">{t('artifacts.title')}</h1>
            <p className="text-sm text-muted-foreground">{t('artifacts.description')}</p>
            <HostStatusLine status={status} onStart={() => void start()} onChangePort={onOpenSettings} />
          </header>
          {items.length > 0 && (
            <Input
              className="bg-surface-elevated"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('artifacts.search')}
              aria-label={t('artifacts.search')}
            />
          )}
          {(actionError || (error && status?.state === 'running')) && (
            <p role="alert" className="text-xs text-destructive">
              {t('artifacts.error', { message: actionError ?? error })}
            </p>
          )}
          {loading ? (
            <p className="text-sm text-muted-foreground">{t('artifacts.loading')}</p>
          ) : visible.length > 0 ? (
            <ul className="space-y-3">
              {visible.map((item) => (
                <ArtifactRow key={item.id} item={item} onDelete={setConfirm} onError={setActionError} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              {items.length ? t('artifacts.noMatch') : t('artifacts.empty')}
            </p>
          )}
        </div>
      </section>
      {confirm && (
        <ConfirmDialog
          title={t('artifacts.deleteTitle')}
          message={t('artifacts.deleteMessage', { title: confirm.title, count: confirm.versionCount })}
          confirmLabel={t('artifacts.delete')}
          destructive
          busy={busy}
          onCancel={() => {
            if (!busy) setConfirm(null)
          }}
          onConfirm={() => void remove(confirm)}
        />
      )}
    </div>
  )
}
