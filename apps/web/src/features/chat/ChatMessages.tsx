import { memo } from 'react'
import type { ProjectChatMessage } from '@maestrly/protocol'
import { Check, LoaderCircle, Wrench } from 'lucide-react'
import { Markdown } from '../../components/Markdown.js'
import { t, useLocale } from '../../i18n/index.js'
const Message = memo(function Message({ message, onCard }: { message: ProjectChatMessage; onCard(id: string): void }) {
  useLocale()
  return (
    <article className={'project-chat-message ' + message.role} data-message-id={message.id}>
      <small>{message.role === 'user' ? t('You') : t('Maestrly')}</small>
      {message.parts.map((p) =>
        p.type === 'tool' ? (
          <details className="project-chat-tool" key={p.id}>
            <summary>
              {p.state === 'completed' ? (
                <Check size={14} />
              ) : p.state === 'running' ? (
                <LoaderCircle size={14} />
              ) : (
                <Wrench size={14} />
              )}
              <code>{p.name}</code>
              <span>{t(p.state)}</span>
            </summary>
            {p.input ? <pre>{p.input}</pre> : null}
            {p.output ? <pre>{p.output}</pre> : null}
            {p.name.startsWith('board_') && p.output
              ? cardLinks(p.output).map((id) => (
                  <button key={id} className="quiet" onClick={() => onCard(id)}>
                    {t('Open card')} · {id.slice(0, 8)}
                  </button>
                ))
              : null}
          </details>
        ) : p.type === 'reasoning' ? (
          <details key={p.id}>
            <summary>{t('Reasoning summary')}</summary>
            <Markdown value={p.text} />
          </details>
        ) : (
          <Markdown key={p.id} value={p.text} />
        )
      )}
    </article>
  )
})
function cardLinks(output: string): string[] {
  try {
    const parsed = JSON.parse(output),
      items = Array.isArray(parsed.items) ? parsed.items : parsed.card ? [parsed.card] : []
    return [
      ...new Set(
        items
          .map((item: Record<string, unknown>) => item.id)
          .filter((id: unknown): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id))
      ),
    ] as string[]
  } catch {
    return []
  }
}
export function ChatMessages({ messages, onCard }: { messages: ProjectChatMessage[]; onCard(id: string): void }) {
  return (
    <>
      {messages.map((message) => (
        <Message key={message.id} message={message} onCard={onCard} />
      ))}
    </>
  )
}
