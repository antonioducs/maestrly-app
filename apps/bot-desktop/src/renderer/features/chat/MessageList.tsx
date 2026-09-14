import { Button } from '../../ui'
import { Fragment, useState } from 'react'
import type { BotMessage } from '@maestrly/host-protocol'
import { useT } from '../../i18n'
import { sanitizeMarkdown, type Inline } from './markdown'
import { canPreview, downloadBytes, type Attachment } from './files'
export function InlineText({ tokens }: { tokens: Inline[] }) {
  return tokens.map((token, index) => (
    <Fragment key={index}>
      {token.kind === 'bold' ? (
        <strong>{token.text}</strong>
      ) : token.kind === 'italic' ? (
        <em>{token.text}</em>
      ) : token.kind === 'code' ? (
        <code>{token.text}</code>
      ) : token.kind === 'link' ? (
        <span>
          {token.text}{' '}
          <Button
            className="link-icon"
            aria-label={token.href}
            onClick={() => void window.bot.openExternal(token.href!)}
          >
            ↗
          </Button>
        </span>
      ) : (
        token.text
      )}
    </Fragment>
  ))
}
export function Markdown({ text }: { text: string }) {
  return sanitizeMarkdown(text).map((block, index) =>
    block.kind === 'code' ? (
      <pre key={index}>
        <code>{block.text}</code>
      </pre>
    ) : block.kind === 'list' ? (
      <ul key={index}>
        {block.items?.map((item, i) => (
          <li key={i}>
            <InlineText tokens={item} />
          </li>
        ))}
      </ul>
    ) : (
      <p key={index}>
        <InlineText tokens={block.inline ?? []} />
      </p>
    )
  )
}
export function FileCard({
  botId,
  file,
  onPreview,
}: {
  botId: string
  file: Attachment
  onPreview: (name: string, text: string) => void
}) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const transfer = async (preview: boolean) => {
    setBusy(true)
    setError('')
    try {
      const bytes = await downloadBytes(botId, file)
      if (preview && canPreview(file) && bytes.length <= 256 * 1024) {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(
          Uint8Array.from(bytes, (char) => char.charCodeAt(0))
        )
        if (text.includes('\u0000')) throw new Error(t('transferError'))
        onPreview(file.name, text)
      } else await window.bot.saveFile({ name: file.name, dataBase64: btoa(bytes) })
    } catch (error) {
      setError(`${t('transferError')} ${String(error)}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <article className="file-card">
      <strong>{file.name}</strong>
      <div className="actions">
        {canPreview(file) && (
          <Button disabled={busy} onClick={() => void transfer(true)}>
            {t('preview')}
          </Button>
        )}
        <Button disabled={busy} onClick={() => void transfer(false)}>
          {t('download')}
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
    </article>
  )
}
export function MessageList({
  botId,
  messages,
  onPreview,
}: {
  botId: string
  messages: BotMessage[]
  onPreview: (name: string, text: string) => void
}) {
  return (
    <>
      {messages.map((message) => (
        <article className={`message ${message.role}`} key={message.id}>
          {message.role === 'assistant' ? <Markdown text={message.content} /> : <p>{message.content}</p>}
          {message.attachments.map((file) => (
            <FileCard key={file.path} botId={botId} file={file} onPreview={onPreview} />
          ))}
        </article>
      ))}
    </>
  )
}
