import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatPairingLink, type FleetPairingCodeResponse } from '@maestrly/bot-fleet-protocol'
import { SUPPORT_LINKS } from '../../../../shared/support'
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
import { fleetErrorMessage } from '@/lib/fleet/errors'
import { initialPhoneAddress, phoneAddressError, secondsLeft } from '@/lib/fleet/pair-phone'
import { cn } from '@/lib/utils'
import { QrCode } from './QrCode'
import { useFleetServerId } from '@/lib/fleet/server-context'

const formatTime = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

export function PairPhoneDialog({ serverUrl, onClose }: { serverUrl: string | null; onClose: () => void }) {
  const serverId = useFleetServerId()
  const { t } = useTranslation('fleet')
  const [address, setAddress] = useState(() => initialPhoneAddress(serverUrl))
  const [touched, setTouched] = useState(false)
  const [pairing, setPairing] = useState<FleetPairingCodeResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const create = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      setPairing(await window.api.fleetCreatePairing(serverId))
      setNow(Date.now())
    } catch (cause) {
      const message = fleetErrorMessage(cause)
      setError(message.includes('Update the bot server') ? t('botServer.pairPhone.updateServer') : message)
    } finally {
      setBusy(false)
    }
  }, [t])

  useEffect(() => {
    void create()
  }, [create])

  useEffect(() => {
    if (!pairing) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [pairing])

  const addressProblem = phoneAddressError(address)
  const addressMessage =
    addressProblem === null
      ? null
      : addressProblem === 'Phones connect to the bot server over HTTPS'
        ? t('botServer.pairPhone.addressNeedsHttps')
        : t('botServer.pairPhone.addressInvalid')
  const left = pairing ? secondsLeft(pairing.expiresAt, now) : 0
  const expired = pairing !== null && left === 0
  const link = pairing && addressProblem === null ? formatPairingLink(address.trim(), pairing.code) : null

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('botServer.pairPhone.title')}</DialogTitle>
          <DialogDescription>{t('botServer.pairPhone.description')}</DialogDescription>
        </DialogHeader>
        <label className="block space-y-1 text-sm">
          <span>{t('botServer.pairPhone.addressLabel')}</span>
          <Input
            className="bg-surface-elevated"
            type="url"
            value={address}
            placeholder="https://bots.example.ts.net"
            aria-invalid={touched && addressMessage !== null}
            aria-describedby="pair-phone-address-help"
            onChange={(event) => setAddress(event.target.value)}
            onBlur={() => setTouched(true)}
          />
        </label>
        {touched && addressMessage && (
          <p role="alert" className="text-xs text-destructive">
            {addressMessage}
          </p>
        )}
        <p id="pair-phone-address-help" className="text-xs text-muted-foreground">
          {t('botServer.pairPhone.addressHelp')}{' '}
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground"
            onClick={() => void window.api.openExternalUrl(`${SUPPORT_LINKS.docs}/mobile.md`)}
          >
            {t('botServer.pairPhone.learnMore')}
          </button>
        </p>
        {error && (
          <p role="alert" className="rounded-md border border-destructive/40 p-3 text-xs text-destructive">
            {error}
          </p>
        )}
        {pairing && (
          <div className="flex flex-col items-center gap-3">
            {link ? (
              <QrCode
                text={link}
                label={t('botServer.pairPhone.qrLabel')}
                className={cn('size-56 rounded-md', expired && 'opacity-25')}
              />
            ) : (
              <div className="flex size-56 items-center justify-center rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
                {t('botServer.pairPhone.addressFirst')}
              </div>
            )}
            <p className="text-xs text-muted-foreground">{t('botServer.pairPhone.codeLabel')}</p>
            <p className={cn('font-mono text-2xl tracking-[0.2em]', expired && 'text-muted-foreground line-through')}>
              {pairing.code}
            </p>
            <p role="status" className="text-xs text-muted-foreground">
              {expired
                ? t('botServer.pairPhone.expired')
                : t('botServer.pairPhone.expiresIn', { time: formatTime(left) })}
            </p>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => void create()}>
            {t('botServer.pairPhone.newCode')}
          </Button>
          <Button onClick={onClose}>{t('botServer.pairPhone.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
