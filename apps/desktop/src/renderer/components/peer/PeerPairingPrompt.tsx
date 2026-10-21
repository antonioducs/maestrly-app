import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { usePeerOverview } from '@/lib/peer/use-peer-overview'

const clock = (ms: number): string => {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/**
 * The code this computer shows when another of the owner's computers asks to use it, whatever the window shows; then
 * how that pairing ended. Closing it while the code shows declines the pairing.
 */
export function PeerPairingPrompt() {
  const { t, i18n } = useTranslation('ui')
  const overview = usePeerOverview()
  const prompt = overview?.prompt ?? null
  const paused = overview?.pairingPausedUntil ?? null
  const [now, setNow] = useState(() => Date.now())
  const time = useMemo(() => new Intl.DateTimeFormat(i18n.language, { timeStyle: 'short' }), [i18n.language])
  const waiting = prompt?.outcome === 'waiting'

  useEffect(() => {
    if (!waiting) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [waiting, prompt?.pairingId])

  if (!prompt) return null
  const name = prompt.name
  const close = () =>
    void (waiting ? window.api.peerPromptCancel(prompt.pairingId) : window.api.peerPromptDismiss(prompt.pairingId))

  let title: string
  let description: string
  if (waiting) {
    title = t('peerPrompt.waitingTitle', { name })
    description = t('peerPrompt.waitingDescription', { name })
  } else if (prompt.outcome === 'paired') {
    title = t('peerPrompt.pairedTitle', { name })
    description = t('peerPrompt.pairedDescription', { name })
  } else if (prompt.outcome === 'mismatch') {
    title = t('peerPrompt.mismatchTitle')
    description = paused
      ? t('peerPrompt.mismatchPausedDescription', { name, time: time.format(new Date(paused)) })
      : t('peerPrompt.mismatchDescription', { name })
  } else if (prompt.outcome === 'expired') {
    title = t('peerPrompt.expiredTitle')
    description = t('peerPrompt.expiredDescription', { name })
  } else {
    title = t('peerPrompt.cancelledTitle', { name })
    description = t('peerPrompt.cancelledDescription')
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent data-peer-prompt={prompt.outcome} className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {waiting && (
          <>
            <div className="flex flex-col items-center gap-3">
              <p className="text-xs text-muted-foreground">{t('peerPrompt.codeLabel')}</p>
              <p
                data-peer-code={prompt.code}
                aria-label={t('peerPrompt.codeAria', { code: prompt.code.split('').join(' ') })}
                className="flex gap-1.5 font-mono text-3xl font-semibold"
              >
                {prompt.code.split('').map((digit, index) => (
                  <span
                    key={index}
                    aria-hidden="true"
                    className={`grid h-14 w-10 place-items-center rounded-lg border border-border-strong bg-white/[0.04] ${index === 3 ? 'ml-2' : ''}`}
                  >
                    {digit}
                  </span>
                ))}
              </p>
              <p role="status" className="text-xs text-muted-foreground">
                {t('peerPrompt.expiresIn', { time: clock(prompt.expiresAt - now) })}
              </p>
            </div>
            <p className="flex items-start gap-2 rounded-md bg-artifact-warn/[0.08] px-2.5 py-2 text-xs leading-relaxed text-foreground">
              <AlertTriangle aria-hidden="true" className="mt-px size-3.5 shrink-0 text-artifact-warn" />
              {t('peerPrompt.warning', { name })}
            </p>
          </>
        )}
        <DialogFooter>
          <Button variant={waiting ? 'outline' : 'default'} autoFocus={!waiting} onClick={close}>
            {waiting ? t('common.cancel') : prompt.outcome === 'paired' ? t('peerPrompt.done') : t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
