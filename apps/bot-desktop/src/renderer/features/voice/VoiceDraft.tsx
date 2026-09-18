import { Loader2, Mic, Trash2 } from 'lucide-react'
import { Button, Surface, Textarea } from '../../ui'
import { useT } from '../../i18n'
import type { VoiceDraft as Draft } from './useVoiceDraft'

/**
 * What the person reviews before anything is sent.
 *
 * The card always names the destination, because a transcription can finish after the person
 * has moved on and "send" must never be ambiguous. The text is editable, sending is a separate
 * and explicit press, and discarding removes the recording rather than leaving it around.
 */
export function VoiceDraftCard({
  draft,
  targetName,
  busy,
  onEdit,
  onSend,
  onDiscard,
  onRetry,
}: {
  draft: Draft
  targetName: string
  busy: boolean
  onEdit: (text: string) => void
  onSend: () => void
  onDiscard: () => void
  onRetry: () => void
}) {
  const t = useT()
  const working = ['permission', 'recording', 'converting', 'uploading', 'transcribing'].includes(draft.stage)
  const label =
    draft.stage === 'permission'
      ? t('voicePermission')
      : draft.stage === 'recording'
        ? t('voiceRecording')
        : draft.stage === 'converting'
          ? t('voicePreparing')
          : draft.stage === 'uploading'
            ? t('voiceUploading')
            : t('voiceTranscribing')
  return (
    <Surface className="voice-draft" role="group" aria-label={t('voiceDraft')}>
      <header>
        <Mic size={15} aria-hidden="true" />
        <strong>{t('voiceDraft')}</strong>
        {/* Where this is going, always: a late transcription must not be sent by mistake. */}
        <span className="voice-target">{t('voiceTo')} {targetName}</span>
      </header>
      {working && (
        <p className="voice-progress" aria-live="polite">
          <Loader2 size={14} className="spin" aria-hidden="true" />
          {label}
        </p>
      )}
      {draft.stage === 'failed' && (
        <div className="voice-error" role="alert">
          <p>{draft.error}</p>
          <div className="voice-actions">
            <Button type="button" onClick={onRetry}>{t('voiceRetry')}</Button>
            <Button type="button" onClick={onDiscard}>{t('voiceDiscard')}</Button>
          </div>
        </div>
      )}
      {draft.stage === 'ready' && (
        <>
          <Textarea aria-label={t('voiceTranscript')} value={draft.text} onChange={(event) => onEdit(event.target.value)} rows={3} />
          <p className="voice-note">{t('voiceLocalNote')}</p>
          <div className="voice-actions">
            <Button className="primary" type="button" disabled={busy || !draft.text.trim()} onClick={onSend}>
              {t('voiceSend')}
            </Button>
            <Button type="button" onClick={onDiscard}>
              <Trash2 size={14} aria-hidden="true" />
              {t('voiceDiscard')}
            </Button>
          </div>
        </>
      )}
    </Surface>
  )
}
