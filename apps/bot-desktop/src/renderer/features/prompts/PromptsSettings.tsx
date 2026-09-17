import { useEffect, useState } from 'react'
import type { Bot, BotPrompt } from '@maestrly/host-protocol'
import { Button, Input, Select, Textarea } from '../../ui'
import { useT } from '../../i18n'

/**
 * Stored commands: a name the person types after `/`, and the text it expands to.
 * `$ARGUMENTS` in the text is replaced by whatever follows the command in the message.
 */
export function PromptsSettings({ bots, connected }: { bots: Bot[]; connected: boolean }) {
  const t = useT()
  const [prompts, setPrompts] = useState<BotPrompt[]>([])
  const [editing, setEditing] = useState<Partial<BotPrompt> | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const load = async () => {
    const lists = await Promise.all([
      window.bot.prompt({ method: 'prompt.list', params: { scope: 'host' } }),
      ...bots.map((bot) => window.bot.prompt({ method: 'prompt.list', params: { scope: 'bot', botId: bot.id } })),
    ])
    setPrompts(lists.flatMap((page) => page.prompts))
  }
  useEffect(() => {
    if (connected) void load().catch((failure) => setError(String(failure)))
  }, [connected, bots.map((bot) => bot.id).join(',')])
  const save = async () => {
    if (!editing?.name || !editing.template) return
    setBusy(true)
    setError('')
    try {
      await window.bot.prompt({
        method: 'prompt.upsert',
        params: {
          ...(editing.id ? { id: editing.id, expectedRevision: editing.revision } : {}),
          scope: editing.scope ?? 'host',
          ...(editing.scope === 'bot' ? { botId: editing.botId } : {}),
          name: editing.name,
          description: editing.description ?? '',
          template: editing.template,
        },
      })
      setEditing(null)
      await load()
    } catch (failure) {
      setError(String(failure))
    } finally {
      setBusy(false)
    }
  }
  const remove = async (prompt: BotPrompt) => {
    setBusy(true)
    setError('')
    try {
      await window.bot.prompt({ method: 'prompt.delete', params: { id: prompt.id, expectedRevision: prompt.revision } })
      await load()
    } catch (failure) {
      setError(String(failure))
    } finally {
      setBusy(false)
    }
  }
  const botName = (id?: string) => bots.find((bot) => bot.id === id)?.name ?? '—'
  return (
    <section className="prompts-settings" aria-label={t('commands')}>
      <h2>{t('commands')}</h2>
      <p>{t('commandsHelp')}</p>
      {!connected && <p>{t('connectionReason')}</p>}
      <ul className="prompt-list">
        {prompts.map((prompt) => (
          <li key={prompt.id} className="prompt-row">
            <div>
              <strong>/{prompt.name}</strong>
              {prompt.description && <span className="muted"> — {prompt.description}</span>}
              <small className="muted"> · {prompt.scope === 'host' ? t('scopeHost') : botName(prompt.botId)}</small>
            </div>
            <div className="actions">
              <Button disabled={busy} onClick={() => setEditing(prompt)}>
                {t('edit')}
              </Button>
              <Button disabled={busy} onClick={() => void remove(prompt)}>
                {t('delete')}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {!editing && (
        <Button disabled={!connected || busy} onClick={() => setEditing({ scope: 'host', name: '', description: '', template: '' })}>
          {t('newCommand')}
        </Button>
      )}
      {editing && (
        <form
          className="prompt-editor"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <label>
            {t('name')}
            <Input
              aria-label={t('commandName')}
              value={editing.name ?? ''}
              pattern="[a-z0-9][a-z0-9-]{0,63}"
              required
              onChange={(event) => setEditing({ ...editing, name: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })}
            />
          </label>
          <label>
            {t('description')}
            <Input aria-label={t('description')} value={editing.description ?? ''} onChange={(event) => setEditing({ ...editing, description: event.target.value })} />
          </label>
          {!editing.id && (
            <label>
              {t('scope')}
              <Select
                aria-label={t('scope')}
                value={editing.scope === 'bot' ? (editing.botId ?? '') : 'host'}
                onValueChange={(value) => setEditing(value === 'host' ? { ...editing, scope: 'host', botId: undefined } : { ...editing, scope: 'bot', botId: value })}
              >
                <option value="host">{t('scopeHost')}</option>
                {bots.map((bot) => (
                  <option key={bot.id} value={bot.id}>
                    {bot.name}
                  </option>
                ))}
              </Select>
            </label>
          )}
          <label>
            {t('template')}
            <Textarea aria-label={t('template')} required value={editing.template ?? ''} onChange={(event) => setEditing({ ...editing, template: event.target.value })} />
          </label>
          <p className="muted">{t('templateHint')}</p>
          <div className="actions">
            <Button type="button" disabled={busy} onClick={() => setEditing(null)}>
              {t('cancel')}
            </Button>
            <Button className="primary" type="submit" disabled={busy || !editing.name || !editing.template}>
              {t('save')}
            </Button>
          </div>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
