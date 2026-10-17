import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Download,
  Eye,
  ExternalLink,
  File,
  Folder,
  FolderDown,
  FolderX,
  MoreHorizontal,
  Pencil,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import type { HostDirectoryError } from '@/lib/hosts/use-host-directory'
import type { HostFsEntry, HostFsListing } from '../../../shared/host-fs'
import { formatBytes } from '../chat/runtime-asset-presentation'

/** The entries of a host's folder, with what can be done with each. */
export function FileList({
  listing,
  loading,
  error,
  onOpenFolder,
  onDownload,
  onDownloadFolder,
  onOpen,
  onPreview,
  onRename,
  onDelete,
}: {
  listing: HostFsListing | null
  loading: boolean
  error: HostDirectoryError | null
  onOpenFolder: (entry: HostFsEntry) => void
  onDownload: (entry: HostFsEntry) => void
  /** Absent for a host that cannot move whole folders: folders then have no download. */
  onDownloadFolder?: (entry: HostFsEntry) => void
  onOpen: (entry: HostFsEntry) => void
  onPreview: (entry: HostFsEntry) => void
  /** Rejects with the reason the host refused the name. */
  onRename: (entry: HostFsEntry, name: string) => Promise<void>
  onDelete: (entry: HostFsEntry) => void
}) {
  const { t, i18n } = useTranslation('ui')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [renameError, setRenameError] = useState<string | null>(null)
  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'short', timeStyle: 'short' })

  const rename = async (entry: HostFsEntry) => {
    const next = name.trim()
    if (!next || next === entry.name) return setRenaming(null)
    try {
      await onRename(entry, next)
      setRenaming(null)
    } catch (cause) {
      setRenameError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <ul className="min-h-0 flex-1 overflow-y-auto py-1" aria-label={listing?.path} aria-busy={loading}>
      {listing?.entries.map((entry) => {
        const isFile = entry.kind === 'file'
        const downloadFolder = entry.kind === 'directory' ? onDownloadFolder : undefined
        return (
          <li
            key={entry.path}
            data-file-entry={entry.name}
            className="group flex items-center gap-2 px-2.5 py-1 text-xs hover:bg-accent/60"
          >
            {entry.kind === 'directory' ? (
              <Folder className="size-3.5 shrink-0 text-muted-foreground" />
            ) : isFile ? (
              <File className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <FolderX className="size-3.5 shrink-0 text-muted-foreground/60" />
            )}
            {renaming === entry.path ? (
              <form
                className="flex min-w-0 flex-1 flex-col gap-0.5"
                onSubmit={(event) => {
                  event.preventDefault()
                  void rename(entry)
                }}
              >
                <Input
                  autoFocus
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value)
                    setRenameError(null)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setRenaming(null)
                  }}
                  aria-label={t('files.renameLabel')}
                  className="h-6 text-xs"
                />
                {renameError && (
                  <span role="alert" className="text-[11px] text-destructive">
                    {renameError}
                  </span>
                )}
              </form>
            ) : entry.kind === 'directory' ? (
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left"
                onClick={() => onOpenFolder(entry)}
                title={entry.path}
              >
                {entry.name}
              </button>
            ) : (
              <span
                className={`min-w-0 flex-1 truncate ${isFile ? '' : 'text-muted-foreground/60'}`}
                title={isFile ? entry.path : t('hostFolder.unavailable')}
              >
                {entry.name}
              </span>
            )}
            {isFile && <span className="shrink-0 text-[11px] text-muted-foreground">{formatBytes(entry.size)}</span>}
            <span className="hidden w-28 shrink-0 text-right text-[11px] text-muted-foreground @sm:inline">
              {date.format(entry.modifiedAt)}
            </span>
            {isFile && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 shrink-0"
                aria-label={`${t('files.download')}: ${entry.name}`}
                title={t('files.download')}
                onClick={() => onDownload(entry)}
              >
                <Download className="size-3.5" />
              </Button>
            )}
            {downloadFolder && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 shrink-0"
                aria-label={`${t('files.downloadFolder')}: ${entry.name}`}
                title={t('files.downloadFolder')}
                onClick={() => downloadFolder(entry)}
              >
                <FolderDown className="size-3.5" />
              </Button>
            )}
            {entry.kind !== 'link' && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-6 shrink-0"
                    aria-label={`${t('files.more')}: ${entry.name}`}
                    title={t('files.more')}
                  >
                    <MoreHorizontal className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {downloadFolder && (
                    <DropdownMenuItem onClick={() => downloadFolder(entry)}>
                      <FolderDown /> {t('files.downloadFolder')}
                    </DropdownMenuItem>
                  )}
                  {isFile && (
                    <DropdownMenuItem onClick={() => onOpen(entry)}>
                      <ExternalLink /> {t('files.open')}
                    </DropdownMenuItem>
                  )}
                  {isFile && (
                    <DropdownMenuItem onClick={() => onPreview(entry)}>
                      <Eye /> {t('files.preview')}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    onClick={() => {
                      setRenaming(entry.path)
                      setName(entry.name)
                      setRenameError(null)
                    }}
                  >
                    <Pencil /> {t('files.rename')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onDelete(entry)}>
                    <Trash2 /> {t('files.delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </li>
        )
      })}
      {listing && listing.entries.length === 0 && !loading && (
        <li className="px-2.5 py-1 text-xs text-muted-foreground">{t('hostFolder.empty')}</li>
      )}
      {!listing && !error && <li className="px-2.5 py-1 text-xs text-muted-foreground">{t('hostFolder.loading')}</li>}
      {listing?.truncated && <li className="px-2.5 py-1 text-xs text-muted-foreground">{t('hostFolder.truncated')}</li>}
      {error && (
        <li role="alert" className="px-2.5 py-1 text-xs text-destructive">
          {t(`hostFolder.errors.${error}`)}
        </li>
      )}
    </ul>
  )
}
