import { ArrowUp, Plus, Square, FileText, X } from 'lucide-react'
import { ComposerSurface } from '../../ui'
import { Button, Textarea } from '../../ui'
import { useT } from '../../i18n'
export function Composer({
  value,
  attachments,
  removeAttachment,
  onChange,
  send,
  stop,
  attach,
  active,
  cancelling,
  disabled,
  busy,
}: {
  value: string
  attachments: { path: string; name: string; size: number }[]
  removeAttachment: (path: string) => void
  onChange: (value: string) => void
  send: () => void
  stop: () => void
  attach: () => void
  active: boolean
  cancelling: boolean
  disabled: boolean
  busy: boolean
}) {
  const t = useT()
  return (
    <ComposerSurface as="form"
      className="composer"
      onSubmit={(event) => {
        event.preventDefault()
        if (!active && !disabled && !busy) send()
      }}
    >
      {!!attachments.length && <div className="composer-attachments" aria-label={t('attachments')}>
        {attachments.map(file => <div className="attachment-chip" key={file.path}>
          <FileText size={15} aria-hidden="true" />
          <span title={file.name}>{file.name}</span>
          <small>{Math.max(1, Math.ceil(file.size / 1024))} KB</small>
          <Button type="button" aria-label={t('removeAttachment') + ' ' + file.name} disabled={active || busy} onClick={() => removeAttachment(file.path)}><X size={12} aria-hidden="true" /></Button>
        </div>)}
      </div>}
      <Textarea
        aria-label={t('message')}
        placeholder={t('composerPlaceholder')}
        aria-describedby={disabled ? 'composer-reason' : undefined}
        readOnly={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            if (!active && !disabled && !busy && value.trim()) send()
          }
        }}
      />
      <div className="actions">
        <Button className="attach-button" type="button" title={t('attach')} aria-label={t('attach')} disabled={disabled || busy || active} onClick={attach}>
          <Plus size={18} aria-hidden="true" />
        </Button>
        {active ? (
          <Button type="button" disabled={disabled || cancelling || busy} onClick={stop}>
            <Square size={12} aria-hidden="true" />{t(cancelling ? 'stopping' : 'stop')}
          </Button>
        ) : (
          <Button className="send-button" aria-label={t('send')} title={t('send')} disabled={disabled || busy || !value.trim()}>
            <ArrowUp size={18} aria-hidden="true" />
          </Button>
        )}
      </div>
      {disabled && <p id="composer-reason">{t('connectionReason')}</p>}
    </ComposerSurface>
  )
}
