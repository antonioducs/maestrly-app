import { useState } from 'react'
import { api } from '../../app/api.js'
import { t, dateTime, errorText } from '../../i18n/index.js'
export function RunEvents({
  organizationId,
  cardId,
  runId,
}: {
  organizationId: string
  cardId: string
  runId: string
}) {
  const [items, setItems] = useState<
      Array<{ id: string; type: string; createdAt: string; data: Record<string, unknown> }>
    >([]),
    [offset, setOffset] = useState(0),
    [more, setMore] = useState(true),
    [error, setError] = useState('')
  async function load(start = offset) {
    try {
      const result = await api<{ items: typeof items; more: boolean }>(
        `/api/v1/organizations/${organizationId}/cards/${cardId}/execution-events?runId=${runId}&offset=${start}`
      )
      setItems((current) => (start ? [...current, ...result.items] : result.items))
      setOffset(start + result.items.length)
      setMore(result.more)
    } catch (caught) {
      setError((caught as Error).message)
    }
  }
  return (
    <details
      className="run-log"
      onToggle={(e) => {
        if (e.currentTarget.open && !items.length) void load(0)
      }}
    >
      <summary>{t('Execution log')}</summary>
      {items.map((item) => (
        <article key={item.id}>
          <small>
            {dateTime(item.createdAt)} · {t(item.type)}
          </small>
          <pre>{String(item.data.text ?? item.data.role ?? JSON.stringify(item.data))}</pre>
        </article>
      ))}
      {more ? (
        <button className="quiet" onClick={() => void load()}>
          {t('Load more')}
        </button>
      ) : null}
      {error ? <p role="alert">{errorText(error)}</p> : null}
    </details>
  )
}
