import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PictureInPicture2, X } from 'lucide-react'
import type { PopupSlot, PopupState } from '../../preload'
import type { FloatTab } from '../../shared/tool-tabs'
import {
  detachVariant,
  formatAccelerator,
  type EffectiveShortcuts,
  type ShortcutBinding,
  type ShortcutOs,
} from '../../shared/shortcuts'
import { BrowserChrome } from '@/components/BrowserChrome'

const TAB_TITLE_KEY: Record<FloatTab, string> = {
  browser: 'drawer.tabBrowser',
  vscode: 'drawer.tabCode',
  terminal: 'drawer.tabTerminal',
  plan: 'drawer.tabPlan',
  review: 'drawer.tabReview',
  notes: 'drawer.tabNotes',
  chatgpt: 'drawer.tabChatGpt',
}

export function PopupOverlay({ convId }: { convId: string | null }) {
  const { t } = useTranslation('ui')
  const [stack, setStack] = useState<PopupSlot[]>([])
  const [suppressed, setSuppressed] = useState(false)

  const [closeKey, setCloseKey] = useState('Esc')

  const [shortcuts, setShortcuts] = useState<{ os: ShortcutOs; map: EffectiveShortcuts } | null>(null)

  useEffect(() => {
    setStack([])
    setSuppressed(false)
    if (!convId) return
    let alive = true
    const apply = (s: PopupState): void => {
      setStack(s.stack)
      setSuppressed(s.suppressed)
    }
    void window.api.getPopupState(convId).then((s) => {
      if (alive && s.convId === convId) apply(s)
    })
    const off = window.api.onPopupState((s) => {
      if (s.convId === convId) apply(s)
      else if (s.convId === null) {
        setStack([])
        setSuppressed(s.suppressed)
      }
    })
    return () => {
      alive = false
      off()
    }
  }, [convId])

  useEffect(() => {
    const apply = (s: { os: ShortcutOs; close: ShortcutBinding; shortcuts: EffectiveShortcuts }) => {
      setCloseKey(formatAccelerator(s.close, s.os))
      setShortcuts({ os: s.os, map: s.shortcuts })
    }
    void window.api
      .getShortcuts()
      .then(apply)
      .catch(() => {})
    return window.api.onShortcutsChanged(apply)
  }, [])

  const detachKey = (tab: FloatTab): string => {
    const v = shortcuts ? detachVariant(shortcuts.map[tab]) : null
    return v ? formatAccelerator(v, shortcuts!.os) : ''
  }

  if (!convId || suppressed || stack.length === 0) return null

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/60" onMouseDown={() => window.api.popupCloseTop(convId)} />
      {stack.map((slot, i) => (
        <PopupFrame
          key={slot.tab}
          convId={convId}
          slot={slot}
          depth={i}
          title={t(TAB_TITLE_KEY[slot.tab])}
          closeHint={t('popup.closeHint', { key: closeKey })}
          detachKey={detachKey(slot.tab)}
        />
      ))}
    </div>
  )
}

function PopupFrame({
  convId,
  slot,
  depth,
  title,
  closeHint,
  detachKey,
}: {
  convId: string
  slot: PopupSlot
  depth: number
  title: string
  closeHint: string

  detachKey: string
}) {
  const { t } = useTranslation('ui')
  const { frame, chromeTop, browserChromeH, tab } = slot
  const titleH = Math.max(0, chromeTop - browserChromeH)
  return (
    <div
      className="absolute flex flex-col overflow-hidden rounded-xl bg-surface-elevated shadow-[0_0_0_1px_rgba(237,234,227,0.32),0_24px_64px_-12px_rgba(0,0,0,0.95),0_0_28px_rgba(237,234,227,0.05)]"
      style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height, zIndex: 10 + depth }}
    >
      <div
        className="flex shrink-0 items-center gap-2 border-b border-border-strong bg-surface-elevated px-3"
        style={{ height: titleH }}
      >
        <span className="truncate text-xs font-medium text-foreground">{title}</span>
        <span className="ml-auto hidden shrink-0 text-[11px] text-muted-foreground sm:inline">{closeHint}</span>
        <button
          type="button"
          onClick={() => {
            window.api.popupOpenFloating(convId, tab)
          }}
          className="flex shrink-0 items-center gap-1.5 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
          title={detachKey ? t('popup.openFloatingWithKey', { key: detachKey }) : t('popup.openFloating')}
        >
          <PictureInPicture2 className="size-3.5" />
          <span>{t('popup.openFloating')}</span>
        </button>
        <button
          type="button"
          onClick={() => window.api.popupClose(convId, tab)}
          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
          aria-label={closeHint}
          title={closeHint}
        >
          <X className="size-4" />
        </button>
      </div>

      {tab === 'browser' && (
        <div className="shrink-0 overflow-hidden" style={{ height: browserChromeH }}>
          <BrowserChrome convId={convId} />
        </div>
      )}

      <div className="min-h-0 flex-1" />
    </div>
  )
}
