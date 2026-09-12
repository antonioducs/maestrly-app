import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Download } from 'lucide-react'

export function ChatImageLightbox({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  const { t } = useTranslation('chat')
  const [ownedSrc, setOwnedSrc] = useState(src)
  useEffect(() => {
    let owned: string | null = null
    let cancelled = false
    setOwnedSrc(src)
    if (src.startsWith('blob:')) {
      void fetch(src)
        .then((response) => response.blob())
        .then((blob) => {
          if (cancelled) return
          owned = URL.createObjectURL(blob)
          setOwnedSrc(owned)
        })
        .catch(() => {
          if (!cancelled) setOwnedSrc(src)
        })
    } else {
      setOwnedSrc(src)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      cancelled = true
      document.removeEventListener('keydown', onKey)
      if (owned) URL.revokeObjectURL(owned)
    }
  }, [onClose, src])

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-8"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div className="absolute right-4 top-4 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
        <a
          href={ownedSrc}
          download={name || t('lightbox.defaultFilename')}
          title={t('lightbox.download')}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
        >
          <Download className="h-4 w-4" />
        </a>
        <button
          type="button"
          onClick={onClose}
          title={t('lightbox.close')}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <img
        src={ownedSrc}
        alt={name}
        onClick={(e) => e.stopPropagation()}
        className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
      />
    </div>
  )
}
