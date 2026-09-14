import { Button, Textarea } from '../../ui'
import { useEffect, useState } from 'react'
import type { BotMemory as Memory } from '@maestrly/host-protocol'
import { useT } from '../../i18n'
export function BotMemory({ botId }: { botId: string }) {
  const t = useT()
  const [memories, setMemories] = useState<Memory[]>([])
  const [content, setContent] = useState('')
  const [editing, setEditing] = useState<Memory>()
  const [error, setError] = useState('')
  const refresh = async () => setMemories(await window.bot.bot({ method: 'bot.memory.list', params: { botId } }))
  useEffect(() => {
    void refresh().catch((error) => setError(String(error)))
  }, [botId])
  const run = async (action: () => Promise<unknown>) => {
    try {
      await action()
      await refresh()
      setError('')
    } catch (error) {
      setError(String(error))
      await refresh()
    }
  }
  return (
    <section>
      <p>{t('memoryExplain')}</p>
      {!memories.length && <p>{t('noMemory')}</p>}
      {memories.map((memory) => (
        <article key={memory.id}>
          <p>{memory.content}</p>
          <Button
            onClick={() => {
              setEditing(memory)
              setContent(memory.content)
            }}
          >
            {t('edit')}
          </Button>
          <Button
            onClick={() =>
              void run(() =>
                window.bot.bot({
                  method: 'bot.memory.delete',
                  params: { botId, memoryId: memory.id, expectedRevision: memory.revision },
                })
              )
            }
          >
            {t('remove')}
          </Button>
        </article>
      ))}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void run(async () => {
            await window.bot.bot({
              method: 'bot.memory.upsert',
              params: {
                botId,
                content,
                ...(editing ? { memoryId: editing.id, expectedRevision: editing.revision } : {}),
              },
            })
            setEditing(undefined)
            setContent('')
          })
        }}
      >
        <label>
          {t('memory')}
          <Textarea
            aria-label={t('memory')}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            maxLength={8192}
          />
        </label>
        <Button disabled={!content.trim()}>{t(editing ? 'save' : 'add')}</Button>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
