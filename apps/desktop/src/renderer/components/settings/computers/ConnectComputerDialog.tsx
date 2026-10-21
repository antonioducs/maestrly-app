import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import type { HostId } from '../../../../shared/host-key'
import { type PeerConnectError, peerHostId } from '../../../../shared/peer'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

type Step =
  | { kind: 'address' }
  | { kind: 'code'; pairingId: string; name: string; expiresAt: number }
  | { kind: 'paired'; deviceId: string; name: string }

/** What the owner reads when a step fails, by what the other computer or the network said. */
const ERROR_KEY: Record<PeerConnectError, string> = {
  address: 'settings.computers.connectDialog.errors.address',
  unreachable: 'settings.computers.connectDialog.errors.unreachable',
  busy: 'settings.computers.connectDialog.errors.busy',
  cooldown: 'settings.computers.connectDialog.errors.cooldown',
  version: 'settings.computers.connectDialog.errors.version',
  'rate-limited': 'settings.computers.connectDialog.errors.rateLimited',
  expired: 'settings.computers.connectDialog.errors.expired',
  mismatch: 'settings.computers.connectDialog.errors.mismatch',
  used: 'settings.computers.connectDialog.errors.used',
  unavailable: 'settings.computers.connectDialog.errors.unavailable',
  invalid: 'settings.computers.connectDialog.errors.invalid',
  self: 'settings.computers.connectDialog.errors.self',
}

/** Errors after which the code can no longer be used: a new one is asked for. */
const NEEDS_NEW_CODE: ReadonlySet<PeerConnectError> = new Set(['expired', 'mismatch', 'used'])

/**
 * Pairs this computer with another of the owner's: its address, then the 6-digit code it shows, typed here. The code
 * allows one try; a wrong or expired one asks the other computer for a new code at the same address.
 */
export function ConnectComputerDialog({
  initialAddress,
  onOpenHost,
  onClose,
}: {
  initialAddress: string
  onOpenHost: (hostId: HostId) => void
  onClose: () => void
}) {
  const { t } = useTranslation('ui')
  const [address, setAddress] = useState(initialAddress)
  const [step, setStep] = useState<Step>({ kind: 'address' })
  const [code, setCode] = useState('')
  const [error, setError] = useState<PeerConnectError | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const pending = useRef<string | null>(null)

  useEffect(() => {
    if (step.kind !== 'code') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [step.kind])

  // Closing before the code was typed lets the other computer close its own dialog.
  useEffect(
    () => () => {
      if (pending.current) void window.api.peerConnectCancel(pending.current)
    },
    []
  )

  const expired = step.kind === 'code' && now >= step.expiresAt
  const shownError = error ?? (expired ? 'expired' : null)

  const start = async () => {
    setBusy(true)
    setError(null)
    setCode('')
    try {
      const started = await window.api.peerConnectStart(address)
      if (!started.ok) {
        setStep({ kind: 'address' })
        return setError(started.error)
      }
      pending.current = started.pairingId
      setNow(Date.now())
      setStep({ kind: 'code', pairingId: started.pairingId, name: started.name, expiresAt: started.expiresAt })
    } finally {
      setBusy(false)
    }
  }

  const pair = async () => {
    if (step.kind !== 'code' || code.length !== 6) return
    setBusy(true)
    setError(null)
    pending.current = null
    try {
      const finished = await window.api.peerConnectCode(step.pairingId, code)
      if (!finished.ok) return setError(finished.error)
      setStep({ kind: 'paired', deviceId: finished.deviceId, name: finished.name })
    } finally {
      setBusy(false)
    }
  }

  const errorText = shownError
    ? t(ERROR_KEY[shownError], {
        address: address.trim(),
        name: step.kind === 'code' ? step.name : t('settings.computers.connectDialog.thatComputer'),
      })
    : null

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent data-peer-connect-dialog={step.kind} className="max-w-md">
        {step.kind === 'address' && (
          <form
            className="contents"
            onSubmit={(event) => {
              event.preventDefault()
              void start()
            }}
          >
            <DialogHeader>
              <DialogTitle>{t('settings.computers.connectDialog.title')}</DialogTitle>
              <DialogDescription>{t('settings.computers.connectDialog.description')}</DialogDescription>
            </DialogHeader>
            <label className="block space-y-1 text-sm">
              <span>{t('settings.computers.connectDialog.addressLabel')}</span>
              <Input
                autoFocus
                className="bg-surface-elevated"
                value={address}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                placeholder={t('settings.computers.connectDialog.addressPlaceholder')}
                aria-invalid={error === 'address'}
                aria-describedby="peer-address-help"
                onChange={(event) => {
                  setAddress(event.target.value)
                  setError(null)
                }}
              />
            </label>
            <p id="peer-address-help" className="text-xs text-muted-foreground">
              {t('settings.computers.connectDialog.addressHelp')}
            </p>
            {errorText && (
              <p role="alert" className="rounded-md border border-destructive/40 p-3 text-xs text-destructive">
                {errorText}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={busy || !address.trim()}>
                {busy && <Loader2 className="animate-spin" />}
                {t('settings.computers.connectDialog.connect')}
              </Button>
            </DialogFooter>
          </form>
        )}

        {step.kind === 'code' && (
          <form
            className="contents"
            onSubmit={(event) => {
              event.preventDefault()
              void pair()
            }}
          >
            <DialogHeader>
              <DialogTitle>{t('settings.computers.connectDialog.codeTitle', { name: step.name })}</DialogTitle>
              <DialogDescription>
                {t('settings.computers.connectDialog.codeDescription', { name: step.name })}
              </DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              value={code}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              disabled={busy || (!!shownError && NEEDS_NEW_CODE.has(shownError))}
              aria-label={t('settings.computers.connectDialog.codeLabel')}
              aria-invalid={!!shownError}
              placeholder="••••••"
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              className="mx-auto h-14 w-56 text-center font-mono text-3xl tracking-[0.4em] placeholder:tracking-[0.4em]"
            />
            {errorText && (
              <p role="alert" className="rounded-md border border-destructive/40 p-3 text-xs text-destructive">
                {errorText}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  if (pending.current) void window.api.peerConnectCancel(pending.current)
                  pending.current = null
                  setError(null)
                  setStep({ kind: 'address' })
                }}
              >
                {t('settings.computers.connectDialog.back')}
              </Button>
              {shownError && NEEDS_NEW_CODE.has(shownError) ? (
                <Button type="button" disabled={busy} onClick={() => void start()}>
                  {busy && <Loader2 className="animate-spin" />}
                  {t('settings.computers.connectDialog.newCode')}
                </Button>
              ) : (
                <Button type="submit" disabled={busy || code.length !== 6}>
                  {busy && <Loader2 className="animate-spin" />}
                  {busy ? t('settings.computers.connectDialog.pairing') : t('settings.computers.connectDialog.pair')}
                </Button>
              )}
            </DialogFooter>
          </form>
        )}

        {step.kind === 'paired' && (
          <>
            <DialogHeader>
              <DialogTitle>{t('settings.computers.connectDialog.pairedTitle', { name: step.name })}</DialogTitle>
              <DialogDescription>
                {t('settings.computers.connectDialog.pairedDescription', { name: step.name })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                {t('common.close')}
              </Button>
              <Button autoFocus onClick={() => onOpenHost(peerHostId(step.deviceId))}>
                {t('settings.computers.connectDialog.open', { name: step.name })}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
