import { useRef, useState, type ReactNode } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import { t } from '../../i18n/index.js'
export function ChatComposer({
  draftKey,
  disabled,
  active,
  busy,
  toolbar,
  onSend,
  onStop,
}: {
  draftKey: string
  disabled: boolean
  active: boolean
  busy: boolean
  /** Inline controls rendered at the left of the send button (mode, effort, model). */
  toolbar?: ReactNode
  onSend(text: string, id: string): Promise<void>
  onStop(): void
}) {
  const [text, setText] = useState(() => {
    try {
      return sessionStorage.getItem(draftKey) ?? ''
    } catch {
      return ''
    }
  })
  const submitted = useRef<{ text: string; id: string } | null>(null),
    sending = useRef(false)
  function change(value: string) {
    setText(value)
    try {
      sessionStorage.setItem(draftKey, value)
    } catch {}
  }
  async function send() {
    if (sending.current || disabled || active || busy || !text.trim()) return
    sending.current = true
    if (submitted.current?.text !== text) submitted.current = { text, id: crypto.randomUUID() }
    try {
      await onSend(text, submitted.current.id)
      change('')
      submitted.current = null
    } catch {
      /* The draft and client message ID are retained for a safe retry. */
    } finally {
      sending.current = false
    }
  }
  return (
    <form
      className="project-chat-composer"
      onSubmit={(e) => {
        e.preventDefault()
        void send()
      }}
    >
      <textarea
        aria-label={t('Message the project')}
        placeholder={t('Ask about the code, plan work or find a card…')}
        value={text}
        maxLength={100000}
        rows={3}
        disabled={disabled}
        onChange={(e) => change(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void send()
          }
        }}
      />
      <div>
        {toolbar ?? <small>{t('Enter to send · Shift+Enter for a new line')}</small>}
        {active ? (
          <button type="button" className="quiet" disabled={busy} onClick={onStop}>
            <Square size={13} />
            {t('Stop response')}
          </button>
        ) : (
          <button className="primary" aria-label={t('Send message')} disabled={busy || disabled || !text.trim()}>
            <ArrowUp size={17} />
          </button>
        )}
      </div>
    </form>
  )
}
