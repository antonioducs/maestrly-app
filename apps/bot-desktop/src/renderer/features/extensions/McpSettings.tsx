import { useState } from 'react'
import type { McpServer } from '@maestrly/host-protocol'
import { Button, Checkbox, Input, Select, Textarea } from '../../ui'
import { useT } from '../../i18n'
import type { useExtensions } from './useExtensions'

type Draft = {
  id?: string
  name: string
  transport: 'stdio' | 'http'
  command: string
  args: string
  url: string
  headers: string
  enabled: boolean
  /** Keys already stored on the Host; a value typed here replaces, an empty one keeps. */
  storedKeys: string[]
  env: { key: string; value: string }[]
}
const blank = (): Draft => ({ name: '', transport: 'stdio', command: '', args: '', url: '', headers: '', enabled: true, storedKeys: [], env: [] })
const fromServer = (server: McpServer): Draft => ({
  id: server.id,
  name: server.name,
  transport: server.transport,
  command: server.command ?? '',
  args: server.args.join('\n'),
  url: server.url ?? '',
  headers: Object.entries(server.headers ?? {})
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n'),
  enabled: server.enabled,
  storedKeys: server.envKeys,
  env: server.envKeys.map((key) => ({ key, value: '' })),
})
const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean)

/**
 * MCP servers of one bot. The form shows what the Host stores — names of variables, never
 * their values — and sends values write-only: a value left empty keeps what is stored, a key
 * removed from the list is deleted on the Host.
 */
export function McpSettings({ extensions, connected }: { extensions: ReturnType<typeof useExtensions>; connected: boolean }) {
  const t = useT()
  const [draft, setDraft] = useState<Draft | null>(null)
  const { state, busy, change } = extensions
  const save = async () => {
    if (!draft) return
    const env: Record<string, string> = {}
    for (const row of draft.env) if (row.key && row.value) env[row.key] = row.value
    // A stored key no longer listed is removed with an empty value.
    for (const key of draft.storedKeys) if (!draft.env.some((row) => row.key === key)) env[key] = ''
    const headers = Object.fromEntries(
      lines(draft.headers)
        .map((line) => line.split(/:\s*/, 2))
        .filter(([name, value]) => name && value)
    )
    const server = {
      ...(draft.id ? { id: draft.id } : {}),
      name: draft.name,
      transport: draft.transport,
      ...(draft.transport === 'stdio' ? { command: draft.command, args: lines(draft.args) } : { url: draft.url, ...(Object.keys(headers).length ? { headers } : {}) }),
      env,
      enabled: draft.enabled,
    }
    if (await change('extension.mcp.upsert', { server })) setDraft(null)
  }
  return (
    <section className="extension-section" aria-label={t('mcpServers')}>
      <h3>{t('mcpServers')}</h3>
      <p className="muted">{t('mcpHelp')}</p>
      <ul className="extension-list">
        {state.mcpServers.map((server) => (
          <li key={server.id} className="extension-row">
            <div>
              <strong>{server.name}</strong>
              <small className="muted"> · {server.transport === 'stdio' ? [server.command, ...server.args].join(' ') : server.url}</small>
              {server.envKeys.length > 0 && <small className="muted"> · {t('envVars')}: {server.envKeys.join(', ')}</small>}
            </div>
            <div className="actions">
              <label className="check">
                <Checkbox
                  aria-label={`${t('enabled')} ${server.name}`}
                  checked={server.enabled}
                  disabled={busy || !connected}
                  onChange={(event) => void change('extension.mcp.upsert', { server: { ...server, env: {}, enabled: event.target.checked } })}
                />
                {t('enabled')}
              </label>
              <Button disabled={busy || !connected} onClick={() => setDraft(fromServer(server))}>
                {t('edit')}
              </Button>
              <Button disabled={busy || !connected} onClick={() => void change('extension.mcp.remove', { serverId: server.id })}>
                {t('remove')}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {!draft && (
        <Button disabled={busy || !connected} onClick={() => setDraft(blank())}>
          {t('newMcpServer')}
        </Button>
      )}
      {draft && (
        <form
          className="extension-editor"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <label>
            {t('serverName')}
            <Input
              aria-label={t('serverName')}
              value={draft.name}
              required
              pattern="[a-z0-9][a-z0-9-]{0,39}"
              onChange={(event) => setDraft({ ...draft, name: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })}
            />
          </label>
          <label>
            {t('transport')}
            <Select aria-label={t('transport')} value={draft.transport} onValueChange={(value) => setDraft({ ...draft, transport: value as Draft['transport'] })}>
              <option value="stdio">{t('transportStdio')}</option>
              <option value="http">{t('transportHttp')}</option>
            </Select>
          </label>
          {draft.transport === 'stdio' ? (
            <>
              <label>
                {t('command')}
                <Input aria-label={t('command')} required value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} />
              </label>
              <label>
                {t('args')}
                <Textarea aria-label={t('args')} value={draft.args} onChange={(event) => setDraft({ ...draft, args: event.target.value })} />
              </label>
            </>
          ) : (
            <>
              <label>
                {t('url')}
                <Input aria-label={t('url')} type="url" required value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} />
              </label>
              <label>
                {t('headers')}
                <Textarea aria-label={t('headers')} value={draft.headers} onChange={(event) => setDraft({ ...draft, headers: event.target.value })} />
              </label>
            </>
          )}
          <fieldset className="env-rows">
            <legend>{t('envVars')}</legend>
            <p className="muted">{t('envHelp')}</p>
            {draft.env.map((row, index) => (
              <div key={index} className="env-row">
                <Input
                  aria-label={t('envKey')}
                  value={row.key}
                  pattern="[A-Z_][A-Z0-9_]{0,63}"
                  placeholder="API_KEY"
                  onChange={(event) => setDraft({ ...draft, env: draft.env.map((entry, i) => (i === index ? { ...entry, key: event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') } : entry)) })}
                />
                <Input
                  aria-label={t('envValue')}
                  type="password"
                  value={row.value}
                  placeholder={draft.storedKeys.includes(row.key) ? t('envStored') : ''}
                  onChange={(event) => setDraft({ ...draft, env: draft.env.map((entry, i) => (i === index ? { ...entry, value: event.target.value } : entry)) })}
                />
                <Button type="button" aria-label={`${t('remove')} ${row.key || t('envKey')}`} onClick={() => setDraft({ ...draft, env: draft.env.filter((_, i) => i !== index) })}>
                  {t('remove')}
                </Button>
              </div>
            ))}
            <Button type="button" disabled={draft.env.length >= 32} onClick={() => setDraft({ ...draft, env: [...draft.env, { key: '', value: '' }] })}>
              {t('addEnv')}
            </Button>
          </fieldset>
          <label className="check">
            <Checkbox checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />
            {t('enabled')}
          </label>
          <div className="actions">
            <Button type="button" disabled={busy} onClick={() => setDraft(null)}>
              {t('cancel')}
            </Button>
            <Button className="primary" type="submit" disabled={busy || !draft.name || (draft.transport === 'stdio' ? !draft.command : !draft.url)}>
              {t('save')}
            </Button>
          </div>
        </form>
      )}
    </section>
  )
}
