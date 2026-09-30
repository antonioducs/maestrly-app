import { useEffect, useState } from 'react'
import type { ArtifactListItem } from '../../../shared/artifacts'
import { cn } from '@/lib/utils'

// Thumbnails of one version never change, so each is fetched once per session.
const cache = new Map<string, string>()

function useThumbnail(id: string, version: number | null): string | null {
  const key = version === null ? null : `${id}:${version}`
  const [url, setUrl] = useState<string | null>(() => (key ? (cache.get(key) ?? null) : null))
  useEffect(() => {
    if (!key || version === null) return setUrl(null)
    const cached = cache.get(key)
    if (cached) return setUrl(cached)
    let alive = true
    window.api.artifacts
      .thumbnail(id, version)
      .then((thumbnail) => {
        if (!thumbnail) return
        cache.set(key, thumbnail.dataUrl)
        if (alive) setUrl(thumbnail.dataUrl)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [id, key, version])
  return url
}

/** A page outline standing in for a preview that is not captured yet. */
export function PagePlaceholder({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn('artifact-page-placeholder absolute inset-0', className)}>
      <div className="artifact-page-chrome">
        <i />
        <i />
        <i />
      </div>
      <div className="artifact-page-lines">
        <i />
        <i />
        <i />
        <i />
      </div>
    </div>
  )
}

/** The preview of an artifact's newest captured version, or a page outline until one exists. */
export function ArtifactThumbnail({ item, version }: { item: ArtifactListItem; version?: number }) {
  const shown = version ?? item.thumbnailVersion
  const url = useThumbnail(item.id, shown)
  if (!url) return <PagePlaceholder />
  return (
    <img
      src={url}
      alt=""
      draggable={false}
      data-testid="artifact-thumbnail"
      className="absolute inset-0 size-full object-cover object-top"
    />
  )
}
