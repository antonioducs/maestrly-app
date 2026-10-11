import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Laptop, RotateCcw, UserX, X } from 'lucide-react'
import type { ArtifactDeviceView, ArtifactPersonView } from '../../../shared/artifacts'
import { Button } from '@/components/ui/button'
import { relativeTime } from '@/components/sidebar/relative-time'
import { useLocale } from '@/lib/i18n'
import { deviceLabel } from './sharing-view'

type Pending = { personId: string; action: 'reset' | 'revoke' }

/** A question asked in place, where the action was, instead of a dialog over the dialog. */
export function InlineConfirm({
  text,
  confirmLabel,
  cancelLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  text: string
  confirmLabel: string
  cancelLabel: string
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div
      role="alertdialog"
      aria-label={text}
      className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-destructive/30 bg-destructive/[0.08] px-2.5 py-2"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        onCancel()
      }}
    >
      <p className="min-w-[180px] flex-1 text-xs text-foreground/85">{text}</p>
      <Button size="sm" variant="ghost" className="h-7" onClick={onCancel} disabled={busy}>
        {cancelLabel}
      </Button>
      <Button size="sm" variant="destructive" className="h-7" autoFocus onClick={onConfirm} disabled={busy}>
        {confirmLabel}
      </Button>
    </div>
  )
}

/** The people an artifact is shared with, the devices each one joined with, and what the owner can do about them. */
export function PeopleList({
  people,
  busy,
  onCopyLink,
  onResetLink,
  onRevokeDevice,
  onRevokePerson,
}: {
  people: ArtifactPersonView[]
  busy: boolean
  onCopyLink: (person: ArtifactPersonView) => void
  onResetLink: (person: ArtifactPersonView) => void
  onRevokeDevice: (person: ArtifactPersonView, device: ArtifactDeviceView) => void
  onRevokePerson: (person: ArtifactPersonView) => void
}) {
  const { t } = useTranslation('ui')
  const [locale] = useLocale()
  const [pending, setPending] = useState<Pending | null>(null)

  if (!people.length) return <p className="py-1 text-xs text-muted-foreground">{t('artifacts.share.noPeople')}</p>

  return (
    <ul className="grid gap-1.5" data-testid="artifact-people">
      {people.map((person) => {
        const name = person.name || t('artifacts.share.guestUnnamed')
        const asking = pending?.personId === person.id ? pending.action : null
        return (
          <li
            key={person.id}
            data-testid="artifact-person"
            className="rounded-lg border border-border-strong bg-black/[0.16] px-3 py-2.5"
          >
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-foreground">{name}</p>
                <p className="truncate text-[11.5px] text-muted-foreground">
                  {t(`artifacts.share.kind.${person.kind}`)}
                </p>
              </div>
              {person.kind === 'invited' && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  disabled={busy}
                  data-testid={person.linkAvailable ? 'artifact-person-copy' : 'artifact-person-reset'}
                  onClick={() =>
                    person.linkAvailable ? onCopyLink(person) : setPending({ personId: person.id, action: 'reset' })
                  }
                >
                  {person.linkAvailable ? <Copy className="size-3.5" /> : <RotateCcw className="size-3.5" />}
                  {person.linkAvailable ? t('artifacts.share.copyLink') : t('artifacts.share.resetLink')}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-muted-foreground hover:text-destructive"
                disabled={busy}
                data-testid="artifact-person-revoke"
                aria-label={`${t('artifacts.share.revokePerson')}: ${name}`}
                onClick={() => setPending({ personId: person.id, action: 'revoke' })}
              >
                <UserX className="size-3.5" /> {t('artifacts.share.revokePerson')}
              </Button>
            </div>
            {person.devices.length ? (
              <ul className="mt-2 grid gap-1" data-testid="artifact-person-devices">
                {person.devices.map((device) => {
                  const label = deviceLabel(t, device.label)
                  return (
                    <li key={device.id} className="flex items-center gap-2 text-xs text-foreground/75">
                      <Laptop className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">
                        {label}
                        <span className="text-muted-foreground">
                          {' · '}
                          {t('artifacts.share.lastSeen', { when: relativeTime(locale, device.lastSeenAt) })}
                        </span>
                      </span>
                      <button
                        type="button"
                        disabled={busy}
                        className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-white/[0.08] hover:text-foreground disabled:opacity-50"
                        aria-label={t('artifacts.share.revokeDevice', { device: label })}
                        title={t('artifacts.share.revokeDevice', { device: label })}
                        onClick={() => onRevokeDevice(person, device)}
                      >
                        <X className="size-3.5" aria-hidden="true" />
                      </button>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="mt-1.5 text-xs text-muted-foreground">{t('artifacts.share.noDevices')}</p>
            )}
            {asking && (
              <InlineConfirm
                text={
                  asking === 'reset' ? t('artifacts.share.confirmReset') : t('artifacts.share.confirmRevoke', { name })
                }
                confirmLabel={
                  asking === 'reset'
                    ? t('artifacts.share.confirmResetAction')
                    : t('artifacts.share.confirmRevokeAction')
                }
                cancelLabel={t('artifacts.share.cancel')}
                busy={busy}
                onCancel={() => setPending(null)}
                onConfirm={() => {
                  setPending(null)
                  if (asking === 'reset') onResetLink(person)
                  else onRevokePerson(person)
                }}
              />
            )}
          </li>
        )
      })}
    </ul>
  )
}
