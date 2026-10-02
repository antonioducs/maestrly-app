import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { FleetLoginKind, FleetLoginStartRequest } from '@maestrly/bot-fleet-protocol'
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
import { provisioningErrorText } from '@/lib/fleet/provisioning'
import type { ProvisioningSubject } from '@/lib/fleet/environments'
import { loginHost, useBotLogin, type LoginResult } from '@/lib/fleet/use-bot-login'

/** Signs an environment (shared by its bots) or, before environments, a bot in to a provider on the server. */
export function BotLoginDialog({
  subject,
  kind,
  slot = 'auto',
  hint,
  open,
  onClose,
}: {
  subject: ProvisioningSubject
  kind: FleetLoginKind
  slot?: FleetLoginStartRequest['slot']
  hint?: string | null
  open: boolean
  onClose: (result: LoginResult) => void
}) {
  const { t } = useTranslation('fleet')
  const login = useBotLogin({ subject, kind, slot, active: open })
  const { attempt, error, busy } = login
  const primary = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    primary.current?.focus()
  }, [attempt?.loginId, attempt?.state, error])
  const close = () => login.close(onClose)
  const terminal = attempt && attempt.state !== 'pending'
  const failed = attempt?.state === 'failed' || attempt?.state === 'expired' || attempt?.state === 'cancelled'
  const provider = t(`login.provider.${kind}`)
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('login.title', { provider, bot: subject.name })}</DialogTitle>
          <DialogDescription>{hint ? t('provisioning.signInAs', { email: hint }) : provider}</DialogDescription>
        </DialogHeader>
        {!attempt && !error && <p role="status">{t('login.starting')}</p>}
        {attempt?.state === 'pending' && (
          <>
            {attempt.browser && (
              <div className="space-y-3">
                <p>{t('login.browserOpened', { host: loginHost(attempt.browser.authUrl) })}</p>
                <Button ref={primary} disabled={busy} onClick={login.openAuth}>
                  {t('login.openAgain')}
                </Button>
                {kind === 'codex' && (
                  <Button variant="outline" disabled={busy} onClick={login.useDeviceCode}>
                    {t('login.useCode')}
                  </Button>
                )}
              </div>
            )}
            {attempt.manual && (
              <div className="space-y-2">
                <Button variant="ghost" aria-expanded={login.paste} onClick={login.togglePaste}>
                  {t('login.pasteTitle')}
                </Button>
                {login.paste && (
                  <>
                    <p className="text-xs text-muted-foreground">{t('login.pasteHint')}</p>
                    <Button variant="outline" disabled={busy} onClick={login.openManual}>
                      {t('login.openLink')}
                    </Button>
                    <label className="block text-sm">
                      {t('login.code')}
                      <Input
                        value={login.code}
                        maxLength={2048}
                        onChange={(event) => login.setCode(event.target.value)}
                      />
                    </label>
                    <Button disabled={busy || !login.code.trim()} onClick={login.submitCode}>
                      {t('login.sendCode')}
                    </Button>
                  </>
                )}
              </div>
            )}
            {attempt.device && (
              <div className="space-y-3">
                <p>{t('login.deviceTitle', { host: loginHost(attempt.device.verificationUrl) })}</p>
                <p className="select-text font-mono text-3xl tracking-widest">{attempt.device.userCode}</p>
                <div className="flex gap-2">
                  <Button variant="outline" disabled={busy} onClick={login.copyCode}>
                    {t('login.copyCode')}
                  </Button>
                  <Button ref={primary} disabled={busy} onClick={login.openDevice}>
                    {t('login.openPage')}
                  </Button>
                </div>
                {kind === 'codex' && <p className="text-xs text-muted-foreground">{t('login.codexDeviceHint')}</p>}
              </div>
            )}
            <p role="status" className="text-sm text-muted-foreground">
              {t(login.preparing ? 'login.preparingGoogle' : 'login.waiting')}
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
            {provisioningErrorText(error, t)}
          </p>
        )}
        {(failed || (!attempt && error)) && (
          <Button ref={primary} disabled={busy} onClick={login.retry}>
            {t('login.retry')}
          </Button>
        )}
        <DialogFooter>
          <Button ref={terminal ? primary : undefined} variant={terminal ? 'default' : 'outline'} onClick={close}>
            {t(terminal ? 'login.done' : 'login.cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
