import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronUp, HardDrive, Home, LoaderCircle, RefreshCw, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { hasDraggedFiles } from '@/lib/attachment-kind'
import { useHostApi, useHostId } from '@/lib/hosts/host-context'
import { useHostDirectory } from '@/lib/hosts/use-host-directory'
import { usePanelMemoryEviction } from '@/lib/panel-memory-eviction'
import { cn } from '@/lib/utils'
import { type HostFsEntry, type HostFsUsage, hostFsErrorCode } from '../../../shared/host-fs'
import type { HostTransferUploadResult } from '../../../shared/host-transfers'
import { formatBytes } from '../chat/runtime-asset-presentation'
import { FileList } from './FileList'
import { FilePreviewDialog } from './FilePreviewDialog'
import { defaultRoot, uploadsLandedIn } from './files-model'
import { TransferList } from './TransferList'
import { useHostTransfers } from './use-host-transfers'

// Transfers live in this computer's main process: the panel holds nothing that eviction would lose.
const evictable = () => ({ safe: true })

/** The files of a host, for a conversation that runs there: browse, preview, rename, delete, and move files. */
export function FilesPanel({ conv }: { conv: string }) {
  const { t } = useTranslation('ui')
  const api = useHostApi()
  const hostId = useHostId()
  usePanelMemoryEviction(conv, 'files', evictable)
  const start = useCallback(
    async (roots: Parameters<typeof defaultRoot>[0]) =>
      (await api.hostFsConversationFolder(conv).catch(() => null)) ?? defaultRoot(roots),
    [api, conv]
  )
  const directory = useHostDirectory({ includeFiles: true, start })
  const { roots, listing, loading, go, reload } = directory
  const transfers = useHostTransfers(hostId)
  const current = listing?.path ?? null
  const [usage, setUsage] = useState<HostFsUsage | null>(null)
  const [preview, setPreview] = useState<HostFsEntry | null>(null)
  const [deleting, setDeleting] = useState<HostFsEntry | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const previous = useRef(transfers)

  useEffect(() => {
    if (!current) return
    let alive = true
    api.hostFsUsage(current).then(
      (value) => alive && setUsage(value),
      () => alive && setUsage(null)
    )
    return () => {
      alive = false
    }
  }, [api, current])
  // An upload that lands in the folder on screen appears in it.
  useEffect(() => {
    if (current && uploadsLandedIn(previous.current, transfers, current)) void reload()
    previous.current = transfers
  }, [transfers, current, reload])

  const hostError = (cause: unknown) => t(`hostFolder.errors.${hostFsErrorCode(cause) ?? 'unknown'}`)
  const started = (run: Promise<unknown>) => {
    setNotice(null)
    run.catch(() => setNotice(t('files.actionFailed')))
  }
  const uploaded = (result: HostTransferUploadResult) =>
    setNotice(result.skipped.length ? t('files.skipped', { names: result.skipped.join(', ') }) : null)
  const drop = async (files: File[]) => {
    if (!current || !files.length) return
    try {
      uploaded(await window.api.transfersUploadFiles(hostId, current, files))
    } catch {
      setNotice(t('files.actionFailed'))
    }
  }
  const onDrag = (event: DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(Array.from(event.dataTransfer.types))) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDragging(true)
  }

  return (
    <div
      className="@container relative flex h-full flex-col text-foreground"
      onDragEnter={onDrag}
      onDragOver={onDrag}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={(event) => {
        if (!hasDraggedFiles(Array.from(event.dataTransfer.types))) return
        event.preventDefault()
        setDragging(false)
        void drop(Array.from(event.dataTransfer.files))
      }}
    >
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-2 py-1.5">
        <div className="flex items-center gap-1" role="group" aria-label={t('hostFolder.roots')}>
          {roots.map((root) => {
            const Icon = root.label === 'home' ? Home : HardDrive
            const inside = current === root.path || current?.startsWith(`${root.path}/`)
            return (
              <Button
                key={root.path}
                type="button"
                variant={inside ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs"
                onClick={() => void go(root.path)}
                title={root.path}
              >
                <Icon className="size-3.5" />
                {t(root.label === 'home' ? 'hostFolder.rootHome' : 'hostFolder.rootWorkspaces')}
              </Button>
            )
          })}
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="ml-auto h-7 gap-1.5 px-2 text-xs"
          disabled={!current}
          onClick={() => {
            if (!current) return
            window.api.transfersUploadPick(hostId, current).then(uploaded, () => setNotice(t('files.actionFailed')))
          }}
        >
          <Upload className="size-3.5" />
          {t('files.upload')}
        </Button>
      </div>

      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          disabled={!listing?.parent || loading}
          onClick={() => listing?.parent && void go(listing.parent)}
          title={t('hostFolder.up')}
          aria-label={t('hostFolder.up')}
        >
          <ChevronUp className="size-4" />
        </Button>
        <code
          data-testid="files-path"
          className="min-w-0 flex-1 truncate rounded bg-white/[0.04] px-2 py-1 text-xs"
          title={current ?? undefined}
        >
          {current ?? ''}
        </code>
        {loading && <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" />}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          disabled={!current}
          onClick={() => void reload()}
          title={t('files.refresh')}
          aria-label={t('files.refresh')}
        >
          <RefreshCw className="size-3.5" />
        </Button>
        <button
          type="button"
          role="switch"
          aria-checked={directory.showHidden}
          className={cn(
            'shrink-0 rounded px-2 py-1 text-xs',
            directory.showHidden ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'
          )}
          onClick={directory.toggleHidden}
        >
          {t('hostFolder.showHidden')}
        </button>
      </div>
      {usage && (
        <p className="px-2.5 pb-1 text-[11px] text-muted-foreground">
          {t('files.usage', { free: formatBytes(usage.free), total: formatBytes(usage.total) })}
        </p>
      )}
      {notice && (
        <p role="status" className="px-2.5 pb-1 text-[11px] text-amber-200/90">
          {notice}
        </p>
      )}

      <FileList
        listing={listing}
        loading={loading}
        error={directory.error}
        onOpenFolder={(entry) => void go(entry.path)}
        onDownload={(entry) => started(window.api.transfersDownload(hostId, entry.path))}
        onOpen={(entry) => started(window.api.transfersOpen(hostId, entry.path))}
        onPreview={setPreview}
        onRename={async (entry, name) => {
          try {
            await api.hostFsRename(entry.path, name)
          } catch (cause) {
            throw new Error(hostError(cause))
          }
          await reload()
        }}
        onDelete={(entry) => {
          setDeleteError(null)
          setDeleting(entry)
        }}
      />
      <TransferList transfers={transfers} />

      {dragging && (
        <div className="pointer-events-none absolute inset-1 flex items-center justify-center rounded-lg border-2 border-dashed border-primary/60 bg-background/80 p-4 text-center text-xs">
          {t('files.dropHere', { folder: current ?? '' })}
        </div>
      )}
      {preview && <FilePreviewDialog entry={preview} onClose={() => setPreview(null)} />}
      {deleting && (
        <ConfirmDialog
          title={t('files.deleteTitle', { name: deleting.name })}
          message={t(deleting.kind === 'directory' ? 'files.deleteFolderMessage' : 'files.deleteFileMessage')}
          confirmLabel={t('files.delete')}
          destructive
          busy={deleteBusy}
          error={deleteError}
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            setDeleteBusy(true)
            try {
              await api.hostFsDelete(deleting.path)
              setDeleting(null)
              await reload()
            } catch (cause) {
              setDeleteError(hostError(cause))
            } finally {
              setDeleteBusy(false)
            }
          }}
        />
      )}
    </div>
  )
}
