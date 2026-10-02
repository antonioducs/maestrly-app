import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { MemorySettings } from '@/components/chat/MemorySettings'
import type { ChatConfig } from '../../../shared/chat'

export function PersonalMemorySettingsDialog({
  onClose,
  onRestoreFocus,
}: {
  onClose: () => void
  onRestoreFocus: () => void
}) {
  const { t } = useTranslation('chat')
  const [config, setConfig] = useState<ChatConfig | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [catalogRevision, setCatalogRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const dirtyRef = useRef(false)
  const busyRef = useRef(false)

  useEffect(() => {
    let active = true
    let request = 0
    const refresh = async () => {
      const current = ++request
      setLoadError(false)
      try {
        const next = await window.api.chatConfig()
        if (active && current === request) setConfig(next)
      } catch {
        if (active && current === request) setLoadError(true)
      }
    }
    const unsubscribe = window.api.onChatModelsCatalogChanged(() => {
      setCatalogRevision((revision) => revision + 1)
      void refresh()
    })
    void refresh()
    return () => {
      active = false
      unsubscribe()
    }
  }, [attempt])

  const requestClose = () => {
    if (busyRef.current || confirmDiscard) return
    if (dirtyRef.current) setConfirmDiscard(true)
    else onClose()
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) requestClose()
      }}
    >
      <DialogContent
        showClose={false}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          onRestoreFocus()
        }}
        className="flex max-h-[calc(100dvh-24px)] w-[calc(100vw-24px)] max-w-[540px] flex-col gap-0 overflow-hidden rounded-xl p-0"
      >
        <DialogHeader className="shrink-0 border-b border-border px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <DialogTitle className="text-[13px] font-medium">{t('personalMemorySettings.dialogTitle')}</DialogTitle>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              disabled={busy}
              onClick={requestClose}
              aria-label={t('personalMemorySettings.close')}
            >
              <X className="size-4" />
            </Button>
          </div>
        </DialogHeader>
        <DialogDescription className="shrink-0 px-5 pt-5 pb-2 text-xs">
          {t('personalMemorySettings.description')}
        </DialogDescription>
        {loadError ? (
          <div role="alert" className="px-5 py-3 text-xs text-destructive">
            {t('personalMemorySettings.loadFailed')}
            <Button size="sm" variant="outline" className="ml-2" onClick={() => setAttempt((value) => value + 1)}>
              {t('personalMemorySettings.retry')}
            </Button>
          </div>
        ) : !config ? (
          <p role="status" className="px-5 py-5 text-xs text-muted-foreground">
            {t('personalMemorySettings.loading')}
          </p>
        ) : null}
        {config && (
          <MemorySettings
            config={config}
            catalogRevision={catalogRevision}
            scope="personal"
            presentation="dialog"
            onChanged={() => {}}
            onDirtyChange={(dirty) => {
              dirtyRef.current = dirty
            }}
            onBusyChange={(saving) => {
              busyRef.current = saving
              setBusy(saving)
            }}
            onCancel={requestClose}
            onSaved={onClose}
          />
        )}
        <Dialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
          <DialogContent showClose={false} className="w-[calc(100vw-24px)] max-w-sm rounded-xl">
            <DialogHeader>
              <DialogTitle className="text-[13px] font-medium">{t('personalMemorySettings.discardTitle')}</DialogTitle>
              <DialogDescription className="text-xs">
                {t('personalMemorySettings.discardDescription')}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => setConfirmDiscard(false)}>
                {t('personalMemorySettings.keepEditing')}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  if (!busyRef.current) onClose()
                }}
              >
                {t('personalMemorySettings.discard')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  )
}
