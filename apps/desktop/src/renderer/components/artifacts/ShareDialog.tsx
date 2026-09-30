import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Check, Copy, Loader2 } from 'lucide-react'
import {
  type ArtifactListItem,
  type ArtifactPersonView,
  type ArtifactSharingPatch,
  type ArtifactSharingView,
  type ArtifactVisibility,
  DEFAULT_ARTIFACT_SETTINGS,
  MAX_ACCESS_CODE_CHARS,
  MAX_ARTIFACT_NAME_CHARS,
} from '../../../shared/artifacts'
import { SettingsSwitch } from '@/components/fleet/SettingsSwitch'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useLocale } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { InlineConfirm, PeopleList } from './PeopleList'
import { EXPIRY_CHOICES, expiryChoice, expiryFromDays, validateAccessCode, validatePersonName } from './sharing-view'

const VISIBILITIES: readonly ArtifactVisibility[] = ['private', 'people', 'link']
const NEVER = 'never'
const CUSTOM = 'custom'
const STATUS_MS = 4_000

const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason))

const fieldClass =
  'h-8 min-w-0 flex-1 rounded-md border border-border-strong bg-black/[0.2] px-2.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-ring aria-[invalid=true]:border-destructive/60'

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="py-4 hairline-t first:pt-1 first:shadow-none">
      <h3 className="text-xs font-semibold text-foreground/85">{title}</h3>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      <div className="mt-2.5">{children}</div>
    </section>
  )
}

/** Who can open an artifact: its visibility, the people invited to it, and the link for anyone. */
export function ShareDialog({
  item,
  onClose,
  onOpenSettings,
}: {
  item: ArtifactListItem
  onClose: () => void
  onOpenSettings: () => void
}) {
  const { t } = useTranslation('ui')
  const [locale] = useLocale()
  const [sharing, setSharing] = useState<ArtifactSharingView | null>(null)
  const [defaultExpiryDays, setDefaultExpiryDays] = useState(DEFAULT_ARTIFACT_SETTINGS.linkExpiryDays)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [codeError, setCodeError] = useState<string | null>(null)
  const [manualLink, setManualLink] = useState<string | null>(null)
  const [confirmAll, setConfirmAll] = useState(false)
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const id = item.id

  const load = useCallback(async () => {
    try {
      setSharing(await window.api.artifacts.sharing(id))
    } catch (reason) {
      setError(t('artifacts.share.failed', { message: message(reason) }))
    }
  }, [id, t])

  // Devices join and leave while the dialog is open.
  useEffect(() => {
    void load()
    void window.api.artifacts
      .getSettings()
      .then((settings) => setDefaultExpiryDays(settings.linkExpiryDays))
      .catch(() => {})
    const off = window.api.artifacts.onChanged(() => void load())
    return () => {
      off()
      if (statusTimer.current) clearTimeout(statusTimer.current)
    }
  }, [load])

  const say = (text: string) => {
    setStatus(text)
    if (statusTimer.current) clearTimeout(statusTimer.current)
    statusTimer.current = setTimeout(() => setStatus(null), STATUS_MS)
  }

  /** Runs one owner action; a failure is shown in the dialog, which stays as it was. */
  const attempt = async <T,>(action: () => Promise<T>): Promise<{ value: T } | null> => {
    if (busy) return null
    setBusy(true)
    setError(null)
    try {
      return { value: await action() }
    } catch (reason) {
      setError(t('artifacts.share.failed', { message: message(reason) }))
      return null
    } finally {
      setBusy(false)
    }
  }

  const act = async (action: () => Promise<void>): Promise<boolean> => {
    const done = await attempt(action)
    if (done) await load()
    return done !== null
  }

  const patch = async (change: ArtifactSharingPatch): Promise<boolean> => {
    const done = await attempt(() => window.api.artifacts.setSharing(id, change))
    if (done) setSharing(done.value)
    return done !== null
  }

  const copy = async (link: string, done: string) => {
    try {
      await navigator.clipboard.writeText(link)
      setManualLink(null)
      say(done)
    } catch {
      // Without clipboard access the owner still gets the link, to copy by hand.
      setManualLink(link)
    }
  }

  const changeVisibility = (visibility: ArtifactVisibility) => {
    if (!sharing || visibility === sharing.visibility) return
    // A link for anyone starts with the default expiry unless one is already running.
    const stale = sharing.linkExpiresAt === null || sharing.linkExpiresAt <= Date.now()
    void patch(
      visibility === 'link' && stale
        ? { visibility, linkExpiresAt: expiryFromDays(defaultExpiryDays, Date.now()) }
        : { visibility }
    )
  }

  const invite = async (event: FormEvent) => {
    event.preventDefault()
    const validity = validatePersonName(name)
    if (validity !== 'ok') {
      setNameError(validity === 'empty' ? t('artifacts.share.nameEmpty') : t('artifacts.share.nameTooLong'))
      nameRef.current?.focus()
      return
    }
    const invited = name.trim()
    const created = await attempt(() => window.api.artifacts.createInvite(id, invited))
    if (!created) return
    setName('')
    await load()
    await copy(created.value.link, t('artifacts.share.linkCopiedFor', { name: invited }))
  }

  const copyPersonLink = async (person: ArtifactPersonView) => {
    const found = await attempt(() => window.api.artifacts.inviteLink(id, person.id))
    if (!found) return
    // The token was stored only in memory and the app restarted since: the list now offers a reset instead.
    if (!found.value) return void load()
    await copy(found.value, t('artifacts.share.linkCopiedFor', { name: person.name }))
  }

  const resetPersonLink = async (person: ArtifactPersonView) => {
    const reset = await attempt(() => window.api.artifacts.resetInvite(id, person.id))
    if (!reset) return
    await load()
    await copy(reset.value, t('artifacts.share.linkCopiedFor', { name: person.name }))
  }

  const saveCode = async (event: FormEvent) => {
    event.preventDefault()
    const validity = validateAccessCode(code)
    if (validity !== 'ok')
      return setCodeError(
        validity === 'too_short' ? t('artifacts.share.codeTooShort') : t('artifacts.share.codeTooLong')
      )
    if (!(await patch({ accessCode: code }))) return
    setCode('')
    say(t('artifacts.share.codeSaved'))
  }

  const dateFormat = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' })
  const now = Date.now()
  const expiry = sharing ? expiryChoice(sharing.linkExpiresAt, now) : null
  const expired = sharing?.linkExpiresAt != null && sharing.linkExpiresAt <= now
  const expiryValue = expiry === null ? NEVER : expiry === 'custom' ? CUSTOM : String(expiry)
  const pageLink = sharing ? `${sharing.publicBase ?? sharing.localBase}/a/${id}` : ''

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="flex max-h-[min(86vh,760px)] max-w-[560px] flex-col gap-0 p-0"
        data-testid="artifact-share"
        aria-busy={busy}
      >
        <DialogHeader className="shrink-0 px-5 pb-3 pt-5 pr-12">
          <DialogTitle className="truncate text-base leading-snug">
            {t('artifacts.share.title', { title: item.title })}
          </DialogTitle>
          <DialogDescription className="text-[13px]">{t('artifacts.share.description')}</DialogDescription>
        </DialogHeader>

        {!sharing ? (
          <div className="flex min-h-[180px] items-center justify-center gap-2 px-5 text-xs text-muted-foreground">
            {error ? (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            ) : (
              <>
                <Loader2 className="size-3.5 animate-spin" /> {t('artifacts.share.loading')}
              </>
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-5">
            <Section title={t('artifacts.share.whoCanOpen')}>
              <Select
                value={sharing.visibility}
                onValueChange={(value) => changeVisibility(value as ArtifactVisibility)}
                disabled={busy}
              >
                <SelectTrigger
                  className="h-9 border-border-strong bg-black/[0.18] text-[13px]"
                  aria-label={t('artifacts.share.whoCanOpen')}
                  data-testid="artifact-share-visibility"
                >
                  <SelectValue>{t(`artifacts.visibility.${sharing.visibility}`)}</SelectValue>
                </SelectTrigger>
                <SelectContent className="backdrop-blur-xl">
                  {VISIBILITIES.map((visibility) => (
                    <SelectItem
                      key={visibility}
                      value={visibility}
                      textValue={t(`artifacts.visibility.${visibility}`)}
                      data-testid={`artifact-share-visibility-${visibility}`}
                      className="items-start py-2"
                    >
                      <span className="block text-[13px]">{t(`artifacts.visibility.${visibility}`)}</span>
                      <span className="block max-w-[44ch] whitespace-normal text-xs text-muted-foreground">
                        {t(`artifacts.visibility.${visibility}Hint`)}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1.5 text-xs text-muted-foreground">
                {t(`artifacts.visibility.${sharing.visibility}Hint`)}
              </p>
            </Section>

            <Section title={t('artifacts.share.people')} hint={t('artifacts.share.peopleHint')}>
              <form className="mb-2.5 flex items-start gap-2" onSubmit={(event) => void invite(event)} noValidate>
                <div className="min-w-0 flex-1">
                  <input
                    ref={nameRef}
                    value={name}
                    maxLength={MAX_ARTIFACT_NAME_CHARS}
                    disabled={busy}
                    placeholder={t('artifacts.share.namePlaceholder')}
                    aria-label={t('artifacts.share.nameLabel')}
                    aria-invalid={Boolean(nameError)}
                    aria-describedby={nameError ? 'artifact-share-name-error' : undefined}
                    data-testid="artifact-share-name"
                    onChange={(event) => {
                      setName(event.target.value)
                      setNameError(null)
                    }}
                    className={cn(fieldClass, 'w-full')}
                  />
                  {nameError && (
                    <p id="artifact-share-name-error" role="alert" className="mt-1 text-xs text-destructive">
                      {nameError}
                    </p>
                  )}
                </div>
                <Button type="submit" size="sm" disabled={busy} data-testid="artifact-share-create">
                  {t('artifacts.share.createLink')}
                </Button>
              </form>
              {manualLink && (
                <div className="mb-2.5 rounded-md border border-artifact-warn/30 bg-artifact-warn/[0.07] p-2.5">
                  <p className="mb-1.5 text-xs text-foreground/85">{t('artifacts.share.copyFailed')}</p>
                  <input
                    readOnly
                    value={manualLink}
                    aria-label={t('artifacts.share.manualCopy')}
                    onFocus={(event) => event.currentTarget.select()}
                    className={cn(fieldClass, 'w-full font-mono text-[11.5px]')}
                  />
                </div>
              )}
              <PeopleList
                people={sharing.people}
                busy={busy}
                onCopyLink={(person) => void copyPersonLink(person)}
                onResetLink={(person) => void resetPersonLink(person)}
                onRevokeDevice={(_person, device) => void act(() => window.api.artifacts.revokeDevice(id, device.id))}
                onRevokePerson={(person) => void act(() => window.api.artifacts.revokePerson(id, person.id))}
              />
              {sharing.visibility === 'private' && sharing.people.length > 0 && (
                <p className="mt-2 text-xs text-muted-foreground">{t('artifacts.share.privateNote')}</p>
              )}
            </Section>

            {sharing.visibility === 'link' && (
              <Section title={t('artifacts.share.anyone')}>
                <div className="grid gap-3.5">
                  <div>
                    <label className="mb-1 block text-xs text-foreground/75" htmlFor="artifact-share-expiry">
                      {t('artifacts.share.expiry')}
                    </label>
                    <Select
                      value={expiryValue}
                      disabled={busy}
                      onValueChange={(value) => {
                        if (value === CUSTOM) return
                        void patch({
                          linkExpiresAt: expiryFromDays(value === NEVER ? null : Number(value), Date.now()),
                        })
                      }}
                    >
                      <SelectTrigger
                        id="artifact-share-expiry"
                        className="h-8 w-auto min-w-[200px] border-border-strong bg-black/[0.18] text-[13px]"
                        data-testid="artifact-share-expiry"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="backdrop-blur-xl">
                        {expiry === 'custom' && sharing.linkExpiresAt !== null && (
                          <SelectItem value={CUSTOM}>
                            {t('artifacts.share.expiryOn', { date: dateFormat.format(sharing.linkExpiresAt) })}
                          </SelectItem>
                        )}
                        {EXPIRY_CHOICES.map((days) => (
                          <SelectItem key={days ?? NEVER} value={days === null ? NEVER : String(days)}>
                            {days === null
                              ? t('artifacts.share.expiryNever')
                              : t('artifacts.share.expiryDays', { count: days })}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {expired && sharing.linkExpiresAt !== null && (
                      <p role="alert" className="mt-1.5 flex items-start gap-1.5 text-xs text-artifact-warn">
                        <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                        {t('artifacts.share.expired', { date: dateFormat.format(sharing.linkExpiresAt) })}
                      </p>
                    )}
                  </div>
                  <form onSubmit={(event) => void saveCode(event)} noValidate>
                    <label className="mb-1 block text-xs text-foreground/75" htmlFor="artifact-share-code">
                      {t('artifacts.share.code')}
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        id="artifact-share-code"
                        value={code}
                        maxLength={MAX_ACCESS_CODE_CHARS}
                        disabled={busy}
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={t('artifacts.share.codePlaceholder')}
                        aria-invalid={Boolean(codeError)}
                        aria-describedby="artifact-share-code-help"
                        data-testid="artifact-share-code"
                        onChange={(event) => {
                          setCode(event.target.value)
                          setCodeError(null)
                        }}
                        className={cn(fieldClass, 'font-mono')}
                      />
                      <Button type="submit" size="sm" variant="outline" disabled={busy || !code}>
                        {t('artifacts.share.codeSave')}
                      </Button>
                      {sharing.hasAccessCode && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            void patch({ accessCode: null }).then((ok) => ok && say(t('artifacts.share.codeRemoved')))
                          }
                        >
                          {t('artifacts.share.codeRemove')}
                        </Button>
                      )}
                    </div>
                    <p
                      id="artifact-share-code-help"
                      role={codeError ? 'alert' : undefined}
                      className={cn('mt-1 text-xs', codeError ? 'text-destructive' : 'text-muted-foreground')}
                    >
                      {codeError ??
                        (sharing.hasAccessCode ? t('artifacts.share.codeSet') : t('artifacts.share.codeHint'))}
                    </p>
                  </form>
                </div>
              </Section>
            )}

            {sharing.visibility !== 'private' && (
              <Section
                title={t('artifacts.share.pageLink')}
                hint={
                  sharing.visibility === 'people'
                    ? t('artifacts.share.pageLinkHintPeople')
                    : t('artifacts.share.pageLinkHintLink')
                }
              >
                <div className="flex items-center gap-2">
                  <input
                    readOnly
                    value={pageLink}
                    aria-label={t('artifacts.share.pageLink')}
                    data-testid="artifact-share-link"
                    onFocus={(event) => event.currentTarget.select()}
                    className={cn(fieldClass, 'font-mono text-[11.5px]')}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void copy(pageLink, t('artifacts.share.linkCopied'))}
                  >
                    <Copy className="size-3.5" /> {t('artifacts.share.copyLink')}
                  </Button>
                </div>
                {sharing.publicBase ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t('artifacts.share.addressPublic', { address: sharing.publicBase })}
                  </p>
                ) : (
                  <div
                    className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-artifact-warn/30 bg-artifact-warn/[0.07] px-2.5 py-2"
                    data-testid="artifact-share-local"
                  >
                    <AlertTriangle className="size-3.5 shrink-0 text-artifact-warn" aria-hidden="true" />
                    <p className="min-w-[200px] flex-1 text-xs text-foreground/85">
                      {t('artifacts.share.addressLocal')}
                    </p>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7"
                      onClick={() => {
                        onClose()
                        onOpenSettings()
                      }}
                    >
                      {t('artifacts.share.addressSettings')}
                    </Button>
                  </div>
                )}
                <p className="mt-2 text-xs text-muted-foreground">{t('artifacts.share.awake')}</p>
              </Section>
            )}

            {sharing.visibility !== 'private' && (
              <section className="flex items-start justify-between gap-3 py-4 hairline-t">
                <div className="min-w-0">
                  <h3 className="text-xs font-semibold text-foreground/85">{t('artifacts.comments.allow')}</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">{t('artifacts.comments.allowHint')}</p>
                </div>
                <SettingsSwitch
                  checked={sharing.commentsEnabled}
                  label={t('artifacts.comments.allow')}
                  disabled={busy}
                  onChange={() => void patch({ commentsEnabled: !sharing.commentsEnabled })}
                />
              </section>
            )}

            <section className="py-3 hairline-t">
              {confirmAll ? (
                <InlineConfirm
                  text={t('artifacts.share.confirmRevokeAll')}
                  confirmLabel={t('artifacts.share.confirmRevokeAllAction')}
                  cancelLabel={t('artifacts.share.cancel')}
                  busy={busy}
                  onCancel={() => setConfirmAll(false)}
                  onConfirm={() => {
                    setConfirmAll(false)
                    void act(() => window.api.artifacts.revokeAllSessions(id)).then(
                      (ok) => ok && say(t('artifacts.share.revokedAll'))
                    )
                  }}
                />
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="-ml-2 h-7 text-muted-foreground hover:text-destructive"
                  disabled={busy}
                  data-testid="artifact-share-revoke-all"
                  onClick={() => setConfirmAll(true)}
                >
                  {t('artifacts.share.revokeAll')}
                </Button>
              )}
            </section>
          </div>
        )}

        <div className="flex shrink-0 items-center gap-3 px-5 py-3 hairline-t">
          <p
            role={error ? 'alert' : 'status'}
            aria-live="polite"
            data-testid="artifact-share-status"
            className={cn('min-w-0 flex-1 text-xs', error ? 'text-destructive' : 'text-foreground/80')}
          >
            {sharing && error ? (
              error
            ) : status ? (
              <span className="flex items-center gap-1.5">
                <Check className="size-3.5 shrink-0 text-status-ready" aria-hidden="true" /> {status}
              </span>
            ) : null}
          </p>
          <Button size="sm" onClick={onClose}>
            {t('artifacts.share.done')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
