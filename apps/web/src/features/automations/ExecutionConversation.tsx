import { useEffect, useState } from 'react'
import { api } from '../../app/api.js'
import { Markdown } from '../../components/Markdown.js'
import { t, useLocale, errorText } from '../../i18n/index.js'
interface Message {
  id: string
  role: string
  text: string
  createdAt: number
  tools: Array<{ name: string; state: string }>
}
export function ExecutionConversation({
  organizationId,
  cardId,
  runId,
}: {
  organizationId: string
  cardId: string
  runId: string
}) {
  useLocale()
  const [open, setOpen] = useState(false),
    [messages, setMessages] = useState<Message[]>([]),
    [error, setError] = useState('')
  useEffect(() => {
    if (!open) return
    let active = true,
      cursor = 0,
      busy = false
    const load = async () => {
      if (busy) return
      busy = true
      try {
        let more = true
        while (active && more) {
          const result = await api<{ items: Array<{ type: string; data: Message }>; more: boolean }>(
            `/api/v1/organizations/${organizationId}/cards/${cardId}/execution-events?runId=${encodeURIComponent(runId)}&offset=${cursor}`
          )
          if (!active) return
          cursor += result.items.length
          more = result.more && result.items.length > 0
          const updates = result.items.filter(
            (item) =>
              item.type === 'maestrly.message' &&
              item.data &&
              typeof item.data.id === 'string' &&
              typeof item.data.text === 'string' &&
              ['user', 'assistant'].includes(item.data.role)
          )
          if (updates.length)
            setMessages((current) => {
              const map = new Map(current.map((m) => [m.id, m]))
              for (const item of updates)
                map.set(item.data.id, {
                  ...item.data,
                  tools: Array.isArray(item.data.tools)
                    ? item.data.tools.filter((t) => t && typeof t.name === 'string' && typeof t.state === 'string')
                    : [],
                })
              return [...map.values()].sort((a, b) => a.createdAt - b.createdAt)
            })
        }
        setError('')
      } catch (e) {
        if (active) setError((e as Error).message)
      } finally {
        busy = false
      }
    }
    void load()
    const timer = setInterval(() => void load(), 2000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [open, organizationId, cardId, runId])
  return (
    <details className="run-conversation" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{t('Execution conversation')}</summary>
      {messages.map((message) => (
        <article key={message.id} className={'execution-message ' + message.role}>
          <small>{t(message.role === 'user' ? 'Task' : 'Agent')}</small>
          <Markdown value={message.text} />
          {message.tools?.map((tool, index) => (
            <div className="execution-tool" key={index}>
              <code>{tool.name}</code>
              <span>{t(tool.state)}</span>
            </div>
          ))}
        </article>
      ))}
      {open && !messages.length ? (
        <p className="form-note">{t('Conversation messages will appear here when the desktop executor starts.')}</p>
      ) : null}
      {error ? (
        <p role="alert" className="form-error">
          {errorText(error)}
        </p>
      ) : null}
    </details>
  )
}
