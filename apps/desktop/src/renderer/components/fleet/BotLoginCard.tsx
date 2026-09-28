import { useEffect, useId, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleCheck, Copy, ExternalLink, LogIn } from 'lucide-react'
import type { FleetLoginKind } from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { ProvisioningSubject } from '@/lib/fleet/environments'
import { provisioningErrorText } from '@/lib/fleet/provisioning'
import { loginHost, useBotLogin } from '@/lib/fleet/use-bot-login'
import { cn } from '@/lib/utils'

export type LoginCardStage = 'todo' | 'active' | 'done' | 'skipped'

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="size-4 animate-spin rounded-full border-2 border-foreground/15 border-t-foreground motion-reduce:animate-none"
    />
  )
}

/**
 * One subscription to sign in to, as a card in a list: it starts in the browser when the owner asks, shows what the
 * provider needs meanwhile (a code, a pasted answer), and ends connected, cancelled or skipped.
 */
export function BotLoginCard({
  subject,
  kind,
  label,
  email,
  stage,
  account,
  next,
  ready,
  blocked,
  onStart,
  onCancel,
  onSkip,
  onDone,
}: {
  subject: ProvisioningSubject
  kind: FleetLoginKind
  label: string
  email: string | null
  stage: LoginCardStage
  /** Who it connected as, once done. */
  account: string | null
  /** The next one to do: its button stands out. */
  next: boolean
  /** The environment can take a sign-in. */
  ready: boolean
  /** Another sign-in is running. */
  blocked: boolean
  onStart: () => void
  onCancel: () => void
  onSkip: () => void
  onDone: (account: string) => void
}) {
  const { t } = useTranslation('fleet')
  const titleId = useId()
  const login = useBotLogin({ subject, kind, active: stage === 'active' })
  const { attempt, error, busy } = login
  const provider = t(`login.provider.${kind}`)
  const done = useRef(onDone)
  done.current = onDone
  useEffect(() => {
    if (stage !== 'active' || attempt?.state !== 'completed') return
    done.current(
      [attempt.account?.email ?? attempt.account?.label ?? provider, attempt.account?.plan].filter(Boolean).join(' · ')
    )
  }, [stage, attempt?.state])
  const failed = attempt?.state === 'failed' || attempt?.state === 'expired' || attempt?.state === 'cancelled'
  const waiting = stage === 'active' && !failed && !error
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      className={cn(
        'flex flex-wrap items-center gap-3 rounded-xl border bg-foreground/[0.025] px-3.5 py-3',
        stage === 'active' ? 'border-border-strong' : 'border-border'
      )}
    >
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-foreground/5 text-foreground/75"
      >
        {stage === 'done' ? (
          <CircleCheck className="size-4 text-status-ready" />
        ) : waiting ? (
          <Spinner />
        ) : (
          <LogIn className="size-4" />
        )}
      </span>
      <div className="flex min-w-48 flex-1 flex-col gap-px">
        <strong id={titleId} className="text-[13.5px] font-medium">
          {label}
        </strong>
        <span className="text-xs text-muted-foreground" role={stage === 'active' ? 'status' : undefined}>
          {stage === 'done'
            ? t('login.connected', { account: account ?? provider })
            : stage === 'skipped'
              ? t('create.signIn.skipped')
              : stage === 'todo'
                ? ready
                  ? email
                    ? t('provisioning.signInAs', { email })
                    : t('create.signIn.withAccount')
                  : t('create.signIn.waitReady')
                : !attempt && !error
                  ? t('login.starting')
                  : attempt?.state === 'pending' && attempt.device
                    ? t('login.deviceTitle', { host: loginHost(attempt.device.verificationUrl) })
                    : attempt?.state === 'pending' && attempt.browser
                      ? t('login.browserOpened', { host: loginHost(attempt.browser.authUrl) })
                      : attempt?.state === 'pending'
                        ? t('login.waiting')
                        : ''}
        </span>
      </div>
      {(stage === 'todo' || stage === 'skipped') && ready && (
        <div className="flex gap-1.5">
          {stage === 'todo' && (
            <Button size="sm" variant="ghost" onClick={onSkip}>
              {t('create.signIn.skip')}
            </Button>
          )}
          <Button size="sm" variant={next ? 'default' : 'outline'} disabled={blocked} onClick={onStart}>
            <ExternalLink aria-hidden="true" />
            {t('create.signIn.start')}
          </Button>
        </div>
      )}
      {stage === 'active' && (
        <div className="flex flex-wrap gap-1.5">
          {attempt?.state === 'pending' && attempt.browser && (
            <Button size="sm" variant="outline" disabled={busy} onClick={login.openAuth}>
              {t('login.openAgain')}
            </Button>
          )}
          {(failed || (!attempt && error)) && (
            <Button size="sm" disabled={busy} onClick={login.retry}>
              {t('login.retry')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => login.close(onCancel)}>
            {t('login.cancel')}
          </Button>
        </div>
      )}
      {stage === 'active' && attempt?.state === 'pending' && attempt.device && (
        <div className="flex basis-full flex-wrap items-center gap-3 rounded-[9px] bg-black/25 px-3 py-2.5">
          <b className="select-text font-mono text-lg font-semibold tracking-[0.12em]">{attempt.device.userCode}</b>
          <span className="ml-auto flex gap-1.5">
            <Button size="sm" variant="ghost" disabled={busy} onClick={login.copyCode}>
              <Copy aria-hidden="true" />
              {t('login.copyCode')}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={login.openDevice}>
              {t('login.openPage')}
            </Button>
          </span>
          {kind === 'codex' && <p className="basis-full text-xs text-muted-foreground">{t('login.codexDeviceHint')}</p>}
        </div>
      )}
      {stage === 'active' && attempt?.state === 'pending' && attempt.browser && kind === 'codex' && (
        <Button size="sm" variant="ghost" className="-ml-2" disabled={busy} onClick={login.useDeviceCode}>
          {t('login.useCode')}
        </Button>
      )}
      {stage === 'active' && attempt?.state === 'pending' && attempt.manual && (
        <div className="flex basis-full flex-col gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="-ml-2 self-start"
            aria-expanded={login.paste}
            onClick={login.togglePaste}
          >
            {t('login.pasteTitle')}
          </Button>
          {login.paste && (
            <div className="flex flex-col gap-2 rounded-[9px] bg-black/25 p-3">
              <p className="text-xs text-muted-foreground">{t('login.pasteHint')}</p>
              <div className="flex flex-wrap items-end gap-2">
                <Button size="sm" variant="outline" disabled={busy} onClick={login.openManual}>
                  {t('login.openLink')}
                </Button>
                <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs">
                  {t('login.code')}
                  <Input value={login.code} maxLength={2048} onChange={(event) => login.setCode(event.target.value)} />
                </label>
                <Button size="sm" disabled={busy || !login.code.trim()} onClick={login.submitCode}>
                  {t('login.sendCode')}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
      {stage === 'active' && (failed || error) && (
        <p role="alert" className="basis-full text-xs text-destructive">
          {failed
            ? attempt.state === 'expired'
              ? t('login.expired')
              : t('login.failed', { error: attempt.error ?? t('login.cancel') })
            : provisioningErrorText(error, t)}
        </p>
      )}
    </div>
  )
}
