import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MAX_ARTIFACT_NAME_CHARS, type ArtifactAccessRequestView } from '../../../shared/artifacts'
import { Button } from '@/components/ui/button'
import { relativeTime } from '@/components/sidebar/relative-time'
import { useLocale } from '@/lib/i18n'
import { validatePersonName } from './sharing-view'

function RequestRow({
  request,
  busy,
  onDecide,
}: {
  request: ArtifactAccessRequestView
  busy: boolean
  onDecide: (approve: boolean, name: string) => void
}) {
  const { t } = useTranslation('ui')
  const [locale] = useLocale()
  // The name is whatever the visitor typed; the owner confirms or corrects it before it becomes the person's name.
  const [name, setName] = useState(request.name)
  const valid = validatePersonName(name) === 'ok'
  return (
    <li
      data-testid="artifact-request"
      className="rounded-lg border border-artifact-warn/30 bg-artifact-warn/[0.07] px-3 py-2.5"
    >
      <div className="flex items-center gap-2">
        <input
          value={name}
          maxLength={MAX_ARTIFACT_NAME_CHARS}
          disabled={busy}
          aria-label={t('artifacts.requests.nameLabel', { name: request.name })}
          aria-invalid={!valid}
          data-testid="artifact-request-name"
          onChange={(event) => setName(event.target.value)}
          className="h-7 min-w-0 flex-1 rounded-md border border-border-strong bg-black/[0.2] px-2 text-[13px] font-medium text-foreground outline-none focus:border-ring aria-[invalid=true]:border-destructive/60"
        />
        <span className="shrink-0 text-[11.5px] text-muted-foreground">
          {t('artifacts.requests.asked', { when: relativeTime(locale, request.createdAt) })}
        </span>
      </div>
      {request.message && (
        <p className="mt-1.5 whitespace-pre-wrap break-words text-xs text-foreground/80">{request.message}</p>
      )}
      <div className="mt-2 flex justify-end gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          className="h-7"
          disabled={busy}
          data-testid="artifact-request-deny"
          onClick={() => onDecide(false, request.name)}
        >
          {t('artifacts.requests.deny')}
        </Button>
        <Button
          size="sm"
          className="h-7"
          disabled={busy || !valid}
          data-testid="artifact-request-approve"
          onClick={() => onDecide(true, name.trim())}
        >
          {t('artifacts.requests.approve')}
        </Button>
      </div>
    </li>
  )
}

/** People waiting for the owner to let them in. */
export function AccessRequests({
  requests,
  busy,
  onDecide,
}: {
  requests: ArtifactAccessRequestView[]
  busy: boolean
  onDecide: (request: ArtifactAccessRequestView, approve: boolean, name: string) => void
}) {
  return (
    <ul className="grid gap-1.5" data-testid="artifact-requests">
      {requests.map((request) => (
        <RequestRow
          key={request.id}
          request={request}
          busy={busy}
          onDecide={(approve, name) => onDecide(request, approve, name)}
        />
      ))}
    </ul>
  )
}
