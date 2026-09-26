import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FleetBot, FleetLoginAttempt, FleetLoginKind, FleetLoginStartRequest } from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { createLoginOwnership } from '@/lib/fleet/provisioning'
import { fleetErrorMessage } from '@/lib/fleet/errors'

type LoginResult = 'completed' | 'cancelled' | 'failed'
export function BotLoginDialog({
  bot,
  kind,
  slot = 'auto',
  hint,
  open,
  onClose,
}: {
  bot: FleetBot
  kind: FleetLoginKind
  slot?: FleetLoginStartRequest['slot']
  hint?: string | null
  open: boolean
  onClose: (result: LoginResult) => void
}) {
  const { t } = useTranslation('fleet')
  const [attempt, setAttempt] = useState<FleetLoginAttempt | null>(null)
  const [method, setMethod] = useState<'browser' | 'device'>(kind === 'grok' ? 'device' : 'browser')
  const [revision, setRevision] = useState(0)
  const [paste, setPaste] = useState(false)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const ownership = useRef(createLoginOwnership<Awaited<ReturnType<typeof window.api.fleetLoginStart>>>())
  const generation = useRef(0)
  const liveAttempt = useRef<FleetLoginAttempt | null>(null)
  const primary = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const current = ++generation.current
    let timer: ReturnType<typeof setTimeout> | undefined
    let owned: FleetLoginAttempt | null = null
    setAttempt(null)
    setBusy(false)
    setError('')
    setCode('')
    setPaste(false)
    const active = () => current === generation.current
    const update = (value: FleetLoginAttempt) => {
      owned = value
      liveAttempt.current = value
      ownership.current.update(value)
      setAttempt(value)
    }
    const poll = async () => {
      if (!owned || !active()) return
      try {
        const value = await window.api.fleetLoginStatus(bot.id, owned.loginId)
        if (!active()) return
        update(value)
        setError('')
      } catch (cause) {
        if (active()) setError(fleetErrorMessage(cause))
      }
      if (active() && owned?.state === 'pending') timer = setTimeout(() => void poll(), 2000)
    }
    const lease = ownership.current.acquire(
      JSON.stringify([bot.id, kind, slot, method, revision]),
      () => window.api.fleetLoginStart(bot.id, { kind, slot, method }),
      (loginId) => window.api.fleetLoginCancel(bot.id, loginId)
    )
    void lease.result
      .then((result) => {
        if (!active()) return
        update(result.attempt)
        setPaste(result.relay === 'unavailable')
        if (result.attempt.state === 'pending') timer = setTimeout(() => void poll(), 2000)
      })
      .catch((cause) => {
        if (active()) setError(fleetErrorMessage(cause))
      })
    return () => {
      generation.current++
      clearTimeout(timer)
      liveAttempt.current = null
      lease.release()
    }
  }, [open, bot.id, kind, slot, method, revision])
  useEffect(() => {
    primary.current?.focus()
  }, [attempt?.loginId, attempt?.state, error])
  async function action(run: () => Promise<unknown>) {
    if (busy) return
    const current = generation.current
    setBusy(true)
    setError('')
    try {
      await run()
    } catch (cause) {
      if (current === generation.current) setError(fleetErrorMessage(cause))
    } finally {
      if (current === generation.current) setBusy(false)
    }
  }
  async function close() {
    if (busy) return
    const value = liveAttempt.current
    if (value?.state === 'pending') {
      await action(async () => {
        await window.api.fleetLoginCancel(bot.id, value.loginId)
        onClose('cancelled')
      })
    } else
      onClose(
        value?.state === 'completed' ? 'completed' : value && value.state !== 'cancelled' ? 'failed' : 'cancelled'
      )
  }
  const terminal = attempt && attempt.state !== 'pending'
  const failed = attempt?.state === 'failed' || attempt?.state === 'expired' || attempt?.state === 'cancelled'
  const provider = t(`login.provider.${kind}`)
  const host = (url: string) => {
    try {
      return new URL(url).host
    } catch {
      return ''
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) void close()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('login.title', { provider, bot: bot.name })}</DialogTitle>
          <DialogDescription>{hint ? t('provisioning.signInAs', { email: hint }) : provider}</DialogDescription>
        </DialogHeader>
        {!attempt && !error && <p role="status">{t('login.starting')}</p>}
        {attempt?.state === 'pending' && (
          <>
            {attempt.browser && (
              <div className="space-y-3">
                <p>{t('login.browserOpened', { host: host(attempt.browser.authUrl) })}</p>
                <Button
                  ref={primary}
                  disabled={busy}
                  onClick={() => void action(() => window.api.fleetLoginOpen(bot.id, attempt.loginId, 'auth'))}
                >
                  {t('login.openAgain')}
                </Button>
                {kind === 'codex' && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await window.api.fleetLoginCancel(bot.id, attempt.loginId)
                        setMethod('device')
                      })
                    }
                  >
                    {t('login.useCode')}
                  </Button>
                )}
              </div>
            )}
            {attempt.manual && (
              <div className="space-y-2">
                <Button variant="ghost" aria-expanded={paste} onClick={() => setPaste((value) => !value)}>
                  {t('login.pasteTitle')}
                </Button>
                {paste && (
                  <>
                    <p className="text-xs text-muted-foreground">{t('login.pasteHint')}</p>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void action(() => window.api.fleetLoginOpen(bot.id, attempt.loginId, 'manual'))}
                    >
                      {t('login.openLink')}
                    </Button>
                    <label className="block text-sm">
                      {t('login.code')}
                      <Input value={code} maxLength={2048} onChange={(event) => setCode(event.target.value)} />
                    </label>
                    <Button
                      disabled={busy || !code.trim()}
                      onClick={() =>
                        void action(async () => {
                          const current = generation.current
                          const value = await window.api.fleetLoginSubmitCode(bot.id, attempt.loginId, code.trim())
                          if (current === generation.current) {
                            ownership.current.update(value)
                            liveAttempt.current = value
                            setAttempt(value)
                            setCode('')
                          }
                        })
                      }
                    >
                      {t('login.sendCode')}
                    </Button>
                  </>
                )}
              </div>
            )}
            {attempt.device && (
              <div className="space-y-3">
                <p>{t('login.deviceTitle', { host: host(attempt.device.verificationUrl) })}</p>
                <p className="select-text font-mono text-3xl tracking-widest">{attempt.device.userCode}</p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void action(() => navigator.clipboard.writeText(attempt.device!.userCode))}
                  >
                    {t('login.copyCode')}
                  </Button>
                  <Button
                    ref={primary}
                    disabled={busy}
                    onClick={() => void action(() => window.api.fleetLoginOpen(bot.id, attempt.loginId, 'device'))}
                  >
                    {t('login.openPage')}
                  </Button>
                </div>
                {kind === 'codex' && <p className="text-xs text-muted-foreground">{t('login.codexDeviceHint')}</p>}
              </div>
            )}
            <p role="status" className="text-sm text-muted-foreground">
              {t('login.waiting')}
            </p>
          </>
        )}
        {attempt?.state === 'completed' && (
          <p role="status">
            {t('login.connected', {
              account: [attempt.account?.email ?? attempt.account?.label ?? provider, attempt.account?.plan]
                .filter(Boolean)
                .join(' · '),
            })}
          </p>
        )}
        {failed && (
          <p role="alert" className="text-sm text-destructive">
            {attempt.state === 'expired'
              ? t('login.expired')
              : t('login.failed', { error: attempt.error ?? t('login.cancel') })}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {(failed || (!attempt && error)) && (
          <Button ref={primary} disabled={busy} onClick={() => setRevision((value) => value + 1)}>
            {t('login.retry')}
          </Button>
        )}
        <DialogFooter>
          <Button
            ref={terminal ? primary : undefined}
            disabled={busy}
            variant={terminal ? 'default' : 'outline'}
            onClick={() => void close()}
          >
            {t(terminal ? 'login.done' : 'login.cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
