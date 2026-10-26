import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Trash2 } from 'lucide-react'
import type { ArtifactResponseView } from '../../../shared/artifacts'
import { Button } from '@/components/ui/button'
import { relativeTime } from '@/components/sidebar/relative-time'
import { useLocale } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { InlineConfirm } from './PeopleList'
import { responseAuthor, responsePreview } from './responses-view'

function ResponseItem({
  response,
  busy,
  onDelete,
}: {
  response: ArtifactResponseView
  busy: boolean
  onDelete: () => void
}) {
  const { t } = useTranslation('ui')
  const [locale] = useLocale()
  const [open, setOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const preview = responsePreview(response.data)
  return (
    <li
      data-testid="artifact-response"
      className="grid gap-1.5 rounded-lg border border-border-strong bg-black/[0.16] p-2.5"
    >
      <p className="flex items-baseline gap-2 text-[12.5px]">
        <span
          className={cn(
            'min-w-0 truncate font-semibold text-foreground',
            response.author.kind === 'guest' && 'font-medium'
          )}
        >
          {responseAuthor(t, response.author)}
        </span>
        <span className="shrink-0 text-[11.5px] text-muted-foreground">{relativeTime(locale, response.updatedAt)}</span>
        <span className="shrink-0 rounded-full bg-white/[0.06] px-1.5 font-mono text-[11px] leading-[18px] text-muted-foreground">
          {t('artifacts.comments.version', { version: response.version })}
        </span>
        <button
          type="button"
          className="ml-auto shrink-0 text-muted-foreground hover:text-destructive disabled:opacity-50"
          disabled={busy}
          aria-label={t('artifacts.responses.delete')}
          title={t('artifacts.responses.delete')}
          data-testid="artifact-response-delete"
          onClick={() => setDeleting(true)}
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
        </button>
      </p>
      {/* People outside the app wrote this: it is shown as plain text, never rendered. */}
      {!open && (
        <div className="grid gap-0.5">
          <dl className="grid gap-0.5 text-[12.5px] text-foreground/80">
            {preview.fields.map((field) => (
              <div key={field.key} className="flex min-w-0 gap-1.5">
                <dt className="shrink-0 text-muted-foreground">{field.key}:</dt>
                <dd className="min-w-0 truncate">{field.value}</dd>
              </div>
            ))}
          </dl>
          {preview.more > 0 && (
            <p className="text-[11.5px] text-muted-foreground">
              {t('artifacts.responses.more', { count: preview.more })}
            </p>
          )}
        </div>
      )}
      {open && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/[0.2] p-2 text-[11.5px] text-foreground/85">
          {JSON.stringify(response.data, null, 2)}
        </pre>
      )}
      <button
        type="button"
        className="justify-self-start text-xs text-primary hover:underline"
        data-testid="artifact-response-toggle"
        onClick={() => setOpen(!open)}
      >
        {open ? t('artifacts.responses.hide') : t('artifacts.responses.showAll')}
      </button>
      {deleting && (
        <InlineConfirm
          text={t('artifacts.responses.confirmDelete')}
          confirmLabel={t('artifacts.responses.delete')}
          cancelLabel={t('artifacts.comments.cancel')}
          busy={busy}
          onCancel={() => setDeleting(false)}
          onConfirm={() => {
            setDeleting(false)
            onDelete()
          }}
        />
      )}
    </li>
  )
}

/** What people sent from an artifact page, one response each: the owner reads, deletes and exports them here. */
export function ResponseList({
  responses,
  busy,
  onDelete,
  onExport,
}: {
  responses: ArtifactResponseView[]
  busy: boolean
  onDelete: (responseId: string) => void
  onExport: (format: 'csv' | 'json') => void
}) {
  const { t } = useTranslation('ui')
  return (
    <>
      <ul className="grid gap-1.5">
        {responses.map((response) => (
          <ResponseItem key={response.id} response={response} busy={busy} onDelete={() => onDelete(response.id)} />
        ))}
      </ul>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => onExport('csv')}
          data-testid="artifact-responses-export-csv"
        >
          <Download className="size-3.5" /> {t('artifacts.responses.exportCsv')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => onExport('json')}
          data-testid="artifact-responses-export-json"
        >
          <Download className="size-3.5" /> {t('artifacts.responses.exportJson')}
        </Button>
      </div>
    </>
  )
}
