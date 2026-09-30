import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronUp, Folder, FolderPlus, FolderX, HardDrive, Home, LoaderCircle } from 'lucide-react'
import { type HostFsListing, type HostFsRoot, hostFsErrorCode } from '../../shared/host-fs'
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
  const [roots, setRoots] = useState<HostFsRoot[]>([])
  const [listing, setListing] = useState<HostFsListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const request = useRef(0)

  const explain = useCallback(
    (cause: unknown) => setError(t(`hostFolder.errors.${hostFsErrorCode(cause) ?? 'unknown'}`)),
    [t]
  )
  const go = useCallback(
    async (path: string, includeHidden: boolean) => {
      const current = ++request.current
      setLoading(true)
      setError(null)
      try {
        const next = await api.hostFsList(path, { includeHidden })
        if (current === request.current) setListing(next)
      } catch (cause) {
        if (current === request.current) explain(cause)
      } finally {
        if (current === request.current) setLoading(false)
      }
    },
    [api, explain]
  )

  useEffect(() => {
    if (!open) return
    setListing(null)
    setRoots([])
    setNaming(false)
    setName('')
    setShowHidden(false)
    setError(null)
    let alive = true
    void api
      .hostFsRoots()
      .then((found) => {
        if (!alive) return
        setRoots(found)
        // The workspaces folder is where a server's projects are meant to live; its home otherwise.
        const first = found.find((root) => root.label === 'workspaces') ?? found[0]
        if (first) void go(first.path, false)
      })
      .catch((cause) => alive && explain(cause))
    return () => {
      alive = false
      request.current++
    }
  }, [open, api, go, explain])

  const createFolder = async () => {
    if (!listing || !name.trim()) return
    setError(null)
    try {
      const created = await api.hostFsMkdir(listing.path, name.trim())
      setNaming(false)
      setName('')
      await go(created, showHidden)
    } catch (cause) {
      explain(cause)
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
                onClick={() => void go(root.path, showHidden)}
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
            onClick={() => listing?.parent && void go(listing.parent, showHidden)}
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
                  onClick={() => void go(entry.path, showHidden)}
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
                onClick={() => {
                  setShowHidden(!showHidden)
                  if (listing) void go(listing.path, !showHidden)
                }}
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
