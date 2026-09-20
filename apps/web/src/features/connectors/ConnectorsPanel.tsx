import { useCallback, useEffect, useState } from 'react'
import { Plug, ShieldCheck, Trash2, Webhook } from 'lucide-react'
import type { Project } from '@maestrly/protocol'
import type { ConnectorAction, ConnectorConnection, ConnectorNotificationEndpoint } from '@maestrly/protocol'
import { connectors } from '../../app/api.js'
import { t, useLocale, errorText, dateTime } from '../../i18n/index.js'
import { FormDialog } from '../../components/FormDialog.js'
import { Select } from '../../components/Select.js'
import { EmptyState } from '../../components/EmptyState.js'

/** What each action lets an external agent do, in the words a person needs to decide. */
const actionText: Record<ConnectorAction, string> = {
  'tasks:read': 'Read tasks, stages and evidence',
  'tasks:write': 'Create tasks and change their configuration',
  'execution:control': 'Start, pause and cancel work',
  'evidence:read': 'Read artifact content and run project checks',
  'inspect:read': 'Read files, diffs and pull requests',
  'inspect:interact': 'Interact with a preview in a browser',
  'delivery:manage': 'Commit, push, open pull requests and merge',
  'interactions:answer': 'Answer questions raised by an execution',
}

interface GrantDraft {
  projectId: string
  actions: ConnectorAction[]
}

function GrantEditor({
  projects,
  value,
  onChange,
}: {
  projects: Project[]
  value: GrantDraft[]
  onChange(next: GrantDraft[]): void
}) {
  useLocale()
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '')
  const remaining = projects.filter((project) => !value.some((grant) => grant.projectId === project.id))
  return (
    <div className="connector-grants">
      {value.map((grant) => (
        <fieldset key={grant.projectId} className="connector-grant">
          <legend>{projects.find((project) => project.id === grant.projectId)?.name ?? grant.projectId}</legend>
          {(Object.keys(actionText) as ConnectorAction[]).map((action) => (
            <label key={action} className="checkbox-row">
              <input
                type="checkbox"
                checked={grant.actions.includes(action)}
                onChange={(event) =>
                  onChange(
                    value.map((item) =>
                      item.projectId === grant.projectId
                        ? {
                            ...item,
                            actions: event.target.checked
                              ? [...item.actions, action]
                              : item.actions.filter((current) => current !== action),
                          }
                        : item
                    )
                  )
                }
              />
              <span>{t(actionText[action])}</span>
            </label>
          ))}
          <button
            type="button"
            className="quiet"
            onClick={() => onChange(value.filter((item) => item.projectId !== grant.projectId))}
          >
            {t('Remove project')}
          </button>
        </fieldset>
      ))}
      {remaining.length ? (
        <div className="connector-grant-add">
          <Select
            label={t('Project')}
            value={remaining.some((project) => project.id === projectId) ? projectId : (remaining[0]?.id ?? '')}
            onChange={setProjectId}
            options={remaining.map((project) => ({ value: project.id, label: project.name }))}
          />
          <button
            type="button"
            className="quiet"
            onClick={() => {
              const chosen = remaining.some((project) => project.id === projectId)
                ? projectId
                : (remaining[0]?.id ?? '')
              if (chosen) onChange([...value, { projectId: chosen, actions: ['tasks:read'] }])
            }}
          >
            {t('Authorize project')}
          </button>
        </div>
      ) : null}
      {!value.length ? <p className="form-note">{t('A connection with no project can do nothing.')}</p> : null}
    </div>
  )
}

export function ConnectorsPanel({
  organizationId,
  projects,
}: {
  organizationId: string
  projects: Project[]
}) {
  useLocale()
  const [overview, setOverview] = useState<Awaited<ReturnType<typeof connectors.overview>> | null>(null)
  const [endpoints, setEndpoints] = useState<Record<string, ConnectorNotificationEndpoint | null>>({})
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<ConnectorConnection | null>(null)
  const [callbackFor, setCallbackFor] = useState<ConnectorConnection | null>(null)
  const [revoking, setRevoking] = useState<ConnectorConnection | null>(null)
  const [draft, setDraft] = useState<GrantDraft[]>([])

  const load = useCallback(async () => {
    try {
      const value = await connectors.overview(organizationId)
      setOverview(value)
      setError('')
      const found: Record<string, ConnectorNotificationEndpoint | null> = {}
      for (const connection of value.connections)
        found[connection.id] = await connectors
          .notificationEndpoint(organizationId, connection.id)
          .catch(() => null)
      setEndpoints(found)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load connectors.')
    } finally {
      setLoading(false)
    }
  }, [organizationId])
  useEffect(() => {
    void load()
  }, [load])

  return (
    <section className="settings-panel connectors">
      <header>
        <Plug />
        <div>
          <p className="eyebrow">{t('External agents')}</p>
          <h2>{t('Connectors')}</h2>
        </div>
      </header>
      <p className="form-note">
        <ShieldCheck size={15} />{' '}
        {t(
          'A connected agent acts with your access, limited to the projects and actions you authorize here. Revoking a connection stops it immediately.'
        )}
      </p>
      {overview ? (
        <dl className="connector-endpoint">
          <div>
            <dt>{t('MCP endpoint')}</dt>
            <dd>
              <code>{overview.mcpUrl}</code>
            </dd>
          </div>
          <div>
            <dt>{t('Discovery')}</dt>
            <dd>
              <code>{overview.protectedResourceMetadataUrl}</code>
            </dd>
          </div>
        </dl>
      ) : null}
      <div className="personal-toolbar">
        <button
          className="primary"
          disabled={!projects.length}
          onClick={() => {
            setDraft(projects[0] ? [{ projectId: projects[0].id, actions: ['tasks:read'] }] : [])
            setCreating(true)
          }}
        >
          {t('Connect an agent')}
        </button>
        <button className="quiet" onClick={() => void load()}>
          {t('Refresh')}
        </button>
      </div>
      {loading ? <p role="status">{t('Loading…')}</p> : null}
      {error ? (
        <p role="alert" className="form-error">
          {errorText(error)}
        </p>
      ) : null}
      <div className="personal-device-list">
        {overview?.connections.map((connection) => {
          const endpoint = endpoints[connection.id] ?? null
          return (
            <article key={connection.id}>
              <Plug size={22} />
              <div>
                <h3>{connection.name}</h3>
                <p className="state-chip">{t(connection.revokedAt ? 'Revoked' : 'Connected')}</p>
                <p className="form-note">
                  <code>{connection.clientId}</code>
                </p>
                <p className="form-note">
                  {t('Last used')}: {connection.lastUsedAt ? dateTime(connection.lastUsedAt) : '—'}
                </p>
                <ul className="connector-grant-summary">
                  {connection.grants.map((grant) => (
                    <li key={grant.projectId}>
                      <strong>{projects.find((project) => project.id === grant.projectId)?.name ?? grant.projectId}</strong>
                      <span>{grant.actions.map((action) => t(actionText[action])).join(' · ')}</span>
                    </li>
                  ))}
                </ul>
                <p className="form-note">
                  <Webhook size={15} />{' '}
                  {endpoint
                    ? `${endpoint.url} · ${t(endpoint.enabled ? 'Callback active' : 'Callback disabled')}${
                        endpoint.lastStatus ? ` · ${endpoint.lastStatus}` : ''
                      }`
                    : t('No callback configured: this agent polls instead of being notified.')}
                </p>
              </div>
              <div className="connector-actions">
                <button
                  className="quiet"
                  onClick={() => {
                    setDraft(connection.grants.map((grant) => ({ ...grant })))
                    setEditing(connection)
                  }}
                >
                  {t('Change access')}
                </button>
                <button className="quiet" onClick={() => setCallbackFor(connection)}>
                  {t('Callback')}
                </button>
                {connection.revokedAt ? null : (
                  <button className="quiet" onClick={() => setRevoking(connection)}>
                    <Trash2 size={15} /> {t('Revoke')}
                  </button>
                )}
              </div>
            </article>
          )
        })}
      </div>
      {!loading && !overview?.connections.length ? (
        <EmptyState title={t('No external agent is connected.')}>
          <p>{t('Register the agent OAuth client id, then choose what it may do in each project.')}</p>
        </EmptyState>
      ) : null}

      {creating ? (
        <FormDialog
          title={t('Connect an agent')}
          submitLabel={t('Connect an agent')}
          submitDisabled={!draft.length}
          onClose={() => setCreating(false)}
          onSubmit={async (data) => {
            await connectors.connect(
              organizationId,
              {
                clientId: String(data.get('clientId') ?? '').trim(),
                name: String(data.get('name') ?? '').trim(),
                grants: draft.filter((grant) => grant.actions.length),
                cancelOnRevoke: data.get('cancelOnRevoke') === 'on',
              },
              crypto.randomUUID()
            )
            await load()
          }}
        >
          <label>
            {t('Name')}
            <input name="name" required maxLength={160} placeholder="Grok Bot" />
          </label>
          <label>
            {t('OAuth client id')}
            <input name="clientId" required maxLength={191} />
          </label>
          <label className="checkbox-row">
            <input type="checkbox" name="cancelOnRevoke" defaultChecked />
            <span>{t('Cancel this agent’s running work when the connection is revoked')}</span>
          </label>
          <GrantEditor projects={projects} value={draft} onChange={setDraft} />
        </FormDialog>
      ) : null}

      {editing ? (
        <FormDialog
          title={t('Change access')}
          submitLabel={t('Save access')}
          onClose={() => setEditing(null)}
          onSubmit={async () => {
            await connectors.patch(
              organizationId,
              editing.id,
              { expectedVersion: editing.version, grants: draft.filter((grant) => grant.actions.length) },
              crypto.randomUUID()
            )
            await load()
          }}
        >
          <p>{editing.name}</p>
          <GrantEditor projects={projects} value={draft} onChange={setDraft} />
        </FormDialog>
      ) : null}

      {callbackFor ? (
        <FormDialog
          title={t('Callback')}
          submitLabel={t('Save callback')}
          onClose={() => setCallbackFor(null)}
          onSubmit={async (data) => {
            const url = String(data.get('url') ?? '').trim()
            if (!url) {
              await connectors.removeNotificationEndpoint(organizationId, callbackFor.id)
            } else {
              await connectors.setNotificationEndpoint(organizationId, callbackFor.id, {
                url,
                secret: String(data.get('secret') ?? ''),
                enabled: data.get('enabled') === 'on',
              })
            }
            await load()
          }}
        >
          <p>{callbackFor.name}</p>
          <p className="form-note">
            {t(
              'Maestrly posts a signed notification to this URL when the task completes, needs a decision or receives a review. The secret is stored encrypted and never shown again.'
            )}
          </p>
          <label>
            {t('Callback URL')}
            <input
              name="url"
              type="url"
              maxLength={2000}
              defaultValue={endpoints[callbackFor.id]?.url ?? ''}
              placeholder="https://…"
            />
          </label>
          <label>
            {t('Shared secret')}
            <input name="secret" type="password" minLength={16} maxLength={500} autoComplete="off" />
          </label>
          <label className="checkbox-row">
            <input type="checkbox" name="enabled" defaultChecked={endpoints[callbackFor.id]?.enabled ?? true} />
            <span>{t('Send notifications to this callback')}</span>
          </label>
          {endpoints[callbackFor.id] ? (
            <p className="form-note">
              {t('Stored secret fingerprint')}: <code>{endpoints[callbackFor.id]?.secretFingerprint}</code>
              {endpoints[callbackFor.id]?.failureCount
                ? ` · ${t('Failed deliveries')}: ${endpoints[callbackFor.id]?.failureCount}`
                : ''}
            </p>
          ) : null}
          <p className="form-note">{t('Clear the URL to remove the callback.')}</p>
        </FormDialog>
      ) : null}

      {revoking ? (
        <FormDialog
          title={t('Revoke connection')}
          submitLabel={t('Revoke connection')}
          onClose={() => setRevoking(null)}
          onSubmit={async () => {
            await connectors.patch(
              organizationId,
              revoking.id,
              { expectedVersion: revoking.version, revoked: true },
              crypto.randomUUID()
            )
            await load()
          }}
        >
          <p>{revoking.name}</p>
          <p>
            {t(
              'The agent loses access immediately. Work it already started is cancelled when the connection asked for that.'
            )}
          </p>
        </FormDialog>
      ) : null}
    </section>
  )
}
