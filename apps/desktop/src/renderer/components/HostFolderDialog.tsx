import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronUp, Folder, FolderPlus, FolderX, HardDrive, Home, LoaderCircle } from 'lucide-react'
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
import { cn } from '@/lib/utils'
import { useHostApi } from '@/lib/hosts/host-context'
import { useHostDirectory } from '@/lib/hosts/use-host-directory'
import { defaultRoot } from '@/components/files/files-model'

interface Props {
  open: boolean
  /** `open` picks a project's folder; `parent` picks where a new project is created. */
  purpose: 'open' | 'parent'
  onPick: (path: string) => void
  onClose: () => void
}

/**
 * Chooses a folder of the host the dialog renders in, from the places that host allows. A server has no desktop to
 * show a native folder dialog on, so its folders are browsed here instead.
 */
export function HostFolderDialog({ open, purpose, onPick, onClose }: Props) {
  const { t } = useTranslation('ui')
  const api = useHostApi()
  // The workspaces folder is where a server's projects are meant to live; its home otherwise.
  const directory = useHostDirectory({ enabled: open, includeFiles: false, start: defaultRoot })
  const { roots, listing, loading, showHidden, go } = directory
  const error = directory.error && t(`hostFolder.errors.${directory.error}`)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')

  useEffect(() => {
    if (!open) return
    setNaming(false)
    setName('')
  }, [open])

  const createFolder = async () => {
    if (!listing || !name.trim()) return
    directory.setError(null)
    try {
      const created = await api.hostFsMkdir(listing.path, name.trim())
      setNaming(false)
      setName('')
      await go(created)
    } catch (cause) {
      directory.explain(cause)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t(purpose === 'open' ? 'hostFolder.titleOpen' : 'hostFolder.titleParent')}</DialogTitle>
          <DialogDescription>{t('hostFolder.description')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('hostFolder.roots')}>
          {roots.map((root) => {
            const Icon = root.label === 'home' ? Home : HardDrive
            const current = listing?.path === root.path || listing?.path.startsWith(`${root.path}/`)
            return (
              <Button
                key={root.path}
                type="button"
                variant={current ? 'secondary' : 'ghost'}
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

        <div className="flex items-center gap-1.5">
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
            data-testid="host-folder-path"
            className="min-w-0 flex-1 truncate rounded bg-white/[0.04] px-2 py-1 text-xs"
            title={listing?.path}
          >
            {listing?.path ?? ''}
          </code>
          {loading && <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" />}
        </div>

        <ul
          className="h-56 overflow-y-auto rounded-md border border-border/60 py-1"
          aria-label={listing?.path}
          aria-busy={loading}
        >
          {listing?.entries.map((entry) =>
            entry.kind === 'directory' ? (
              <li key={entry.path}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-2.5 py-1 text-left text-xs hover:bg-accent"
                  onClick={() => void go(entry.path)}
                >
                  <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{entry.name}</span>
                </button>
              </li>
            ) : (
              <li
                key={entry.path}
                className="flex items-center gap-2 px-2.5 py-1 text-xs text-muted-foreground/60"
                title={t('hostFolder.unavailable')}
              >
                <FolderX className="size-3.5 shrink-0" />
                <span className="truncate">{entry.name}</span>
              </li>
            )
          )}
          {listing && listing.entries.length === 0 && !loading && (
            <li className="px-2.5 py-1 text-xs text-muted-foreground">{t('hostFolder.empty')}</li>
          )}
          {!listing && !error && (
            <li className="px-2.5 py-1 text-xs text-muted-foreground">{t('hostFolder.loading')}</li>
          )}
          {listing?.truncated && (
            <li className="px-2.5 py-1 text-xs text-muted-foreground">{t('hostFolder.truncated')}</li>
          )}
        </ul>

        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {naming ? (
            <form
              className="flex min-w-0 flex-1 items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                void createFolder()
              }}
            >
              <Input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('hostFolder.newFolderName')}
                aria-label={t('hostFolder.newFolderName')}
                className="h-7 text-xs"
              />
              <Button type="submit" size="sm" className="h-7 px-2 text-xs" disabled={!name.trim()}>
                {t('hostFolder.create')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setNaming(false)}
              >
                {t('hostFolder.cancel')}
              </Button>
            </form>
          ) : (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs"
                disabled={!listing}
                onClick={() => setNaming(true)}
              >
                <FolderPlus className="size-3.5" />
                {t('hostFolder.newFolder')}
              </Button>
              <button
                type="button"
                role="switch"
                aria-checked={showHidden}
                className={cn(
                  'rounded px-2 py-1 text-xs',
                  showHidden ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'
                )}
                onClick={directory.toggleHidden}
              >
                {t('hostFolder.showHidden')}
              </button>
            </>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('hostFolder.cancel')}
          </Button>
          <Button type="button" disabled={!listing} onClick={() => listing && onPick(listing.path)}>
            {t('hostFolder.choose')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
