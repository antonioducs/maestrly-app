import { useCallback, useEffect, useState } from 'react'
import { Users, UserPlus, Mail, ShieldCheck, Search } from 'lucide-react'
import type { ProjectTeam, TeamMember, ProjectInvitation, ProjectRole } from '@maestrly/protocol'
import { api, write } from '../../app/api.js'
import { t, useLocale, errorText } from '../../i18n/index.js'
import { FormDialog } from '../../components/FormDialog.js'
import { Select } from '../../components/Select.js'
import { EmptyState } from '../../components/EmptyState.js'
const roles: ProjectRole[] = ['viewer', 'contributor', 'maintainer']
export function TeamPanel({
  organizationId,
  projectId,
  projectName,
}: {
  organizationId: string
  projectId: string
  projectName: string
}) {
  useLocale()
  const [data, setData] = useState<ProjectTeam | null>(null),
    [error, setError] = useState(''),
    [search, setSearch] = useState(''),
    [notice, setNotice] = useState(''),
    [link, setLink] = useState<{id:string;url:string}|null>(null)
  const [panel, setPanel] = useState<'invite' | 'add' | 'edit' | 'remove' | 'revoke' | 'renew' | null>(null),
    [member, setMember] = useState<TeamMember | null>(null),
    [invitation, setInvitation] = useState<ProjectInvitation | null>(null),
    [role, setRole] = useState<ProjectRole>('contributor'),
    [candidate, setCandidate] = useState('')
  const base = `/api/v1/organizations/${organizationId}/projects/${projectId}/team`
  const load = useCallback(async () => {
    const value = await api<ProjectTeam>(base)
    setData(current=>!current||value.version>=current.version?value:current)
    setError('')
    if (!value.canManage) {setPanel(null);setLink(null)}
  }, [base])
  useEffect(() => {
    let active = true
    const refresh = () =>
      void api<ProjectTeam>(base)
        .then((value) => {
          if (active) {
            setData(current=>!current||value.version>=current.version?value:current)
            setError('')
            if (!value.canManage) {setPanel(null);setLink(null)}
          }
        })
        .catch((e) => {
          if (active) setError(e.message)
        })
    refresh()
    window.addEventListener('maestrly-team-changed', refresh)
    return () => {
      active = false
      window.removeEventListener('maestrly-team-changed', refresh)
    }
  }, [base])
  const open = (action: typeof panel, target?: TeamMember, invite?: ProjectInvitation) => {
    setPanel(action)
    setMember(target ?? null)
    setInvitation(invite ?? null)
    setRole(target?.role ?? 'contributor')
    setCandidate(data?.candidates[0]?.userId ?? '')
    setNotice('')
  }
  async function mutate(path: string, method: string, body: Record<string, unknown>) {
    try {
      const result = await write<{ id:string;url?: string }>(base + path, method, { ...body, expectedVersion: data!.version })
      if (result.url) setLink({id:result.id,url:result.url})
      setNotice('Team updated.')
      await load().catch(() => {})
      window.dispatchEvent(new Event('maestrly-team-changed'))
    } catch (e) {
      await load().catch(() => {})
      throw e
    }
  }
  if (!data)
    return (
      <section className="settings-panel">
        <h2>{t('Team')}</h2>
        <p role={error ? 'alert' : 'status'}>{error ? errorText(error) : t('Loading…')}</p>
        <button className="quiet" onClick={() => void load().catch((e) => setError(e.message))}>
          {t('Refresh')}
        </button>
      </section>
    )
  const filtered = data.members.filter((m) => (m.name + ' ' + m.email).toLowerCase().includes(search.toLowerCase()))
  const titles = {
    invite: 'Invite to project',
    add: 'Add organization member',
    edit: 'Change role',
    remove: 'Remove project access',
    revoke: 'Revoke invitation',
    renew: 'Renew invitation',
  }
  return (
    <section className="settings-panel team-panel">
      <header>
        <Users />
        <div>
          <p className="eyebrow">{projectName}</p>
          <h2>{t('Project team')}</h2>
        </div>
      </header>
      <p className="form-note">{t('Manage who can access this project and what they can do.')}</p>
      <div className="team-toolbar">
        <label className="team-search">
          <Search size={17} />
          <input
            aria-label={t('Search team')}
            placeholder={t('Search name or email')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <button className="quiet" onClick={() => void load().catch((e) => setError(e.message))}>
          {t('Refresh')}
        </button>
        {data.canManage ? (
          <>
            <button className="quiet" disabled={!data.candidates.length} onClick={() => open('add')}>
              <UserPlus size={16} />
              {t('Add member')}
            </button>
            <button className="primary" onClick={() => open('invite')}>
              <Mail size={16} />
              {t('Invite to project')}
            </button>
          </>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="form-error">
          {errorText(error)}
        </p>
      ) : null}
      {notice ? <p role="status">{t(notice)}</p> : null}
      {link && data.invitations.some(i=>i.id===link.id&&i.status==='pending') ? (
        <div className="team-link">
          <label>
            {t('Invitation link')}
            <input readOnly value={link.url} onFocus={(e) => e.target.select()} />
          </label>
          <button
            className="quiet"
            onClick={() =>
              void navigator.clipboard
                .writeText(link.url)
                .then(() => setNotice('Link copied.'))
                .catch(() => setError('Copy the selected invitation link.'))
            }
          >
            {t('Copy link')}
          </button>
          <p className="form-note">{t('Share this link with the invited person. It is not sent by email.')}</p>
        </div>
      ) : null}
      <div className="team-list">
        {filtered.map((m) => (
          <article key={m.userId} className="team-person">
            <div className="team-avatar" aria-hidden="true">
              {m.name.slice(0, 2).toUpperCase()}
            </div>
            <div className="team-identity">
              <strong>{m.name}</strong>
              <span>{m.email}</span>
              <small>{m.inherited ? t('Organization access') : t('Project membership')}</small>
            </div>
            <span className="team-role">
              {m.inherited ? (
                <>
                  <ShieldCheck size={14} />
                  {t(m.organizationRole)}
                </>
              ) : (
                t(m.role!)
              )}
            </span>
            {data.canManage && !m.inherited ? (
              <div className="team-actions">
                <button className="quiet" onClick={() => open('edit', m)}>
                  {t('Change role')}
                </button>
                <button className="quiet" onClick={() => open('remove', m)}>
                  {t('Remove access')}
                </button>
              </div>
            ) : null}
          </article>
        ))}
      </div>
      {!filtered.length ? <EmptyState title={t('No matching members.')} /> : null}
      <p className="form-note">
        {t('Owners and administrators inherit access from the organization. Their access cannot be removed here.')}
      </p>
      <div className="team-role-guide">
        {roles.map((r) => (
          <div key={r}>
            <strong>{t(r)}</strong>
            <p>{t('team.role.' + r)}</p>
          </div>
        ))}
      </div>
      {data.canManage ? (
        <>
          <h3>{t('Project invitations')}</h3>
          {!data.invitations.length ? (
            <p className="form-note">{t('No invitations yet.')}</p>
          ) : (
            <div className="team-list">
              {data.invitations.map((i) => (
                <article className="team-person" key={i.id}>
                  <Mail size={18} />
                  <div className="team-identity">
                    <strong>{i.email}</strong>
                    <span>
                      {t(i.role)} · {t('team.status.' + i.status)}
                    </span>
                    <small>
                      {t('Expires')}: {new Date(i.expiresAt).toLocaleString()} · {i.createdBy}
                    </small>
                  </div>
                  {i.status !== 'accepted' ? (
                    <div className="team-actions">
                      <button className="quiet" onClick={() => open('renew', undefined, i)}>
                        {t('Renew invitation')}
                      </button>
                      {i.status === 'pending' ? (
                        <button className="quiet" onClick={() => open('revoke', undefined, i)}>
                          {t('Revoke invitation')}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          )}
          <h3>{t('Team activity')}</h3>
          <ol className="team-history">
            {data.history.map((h) => (
              <li key={h.id}>
                <strong>{t(h.type)}</strong>
                <span>
                  {h.actorName} · {new Date(h.createdAt).toLocaleString()}
                </span>
                <small>
                  {String(
                    h.data.email ?? data.members.find((m) => m.userId === h.data.userId)?.name ?? h.data.userId ?? ''
                  )}
                  {h.data.role ? ' · ' + t(String(h.data.role)) : ''}
                </small>
              </li>
            ))}
          </ol>
        </>
      ) : null}
      {panel && data.canManage ? (
        <FormDialog
          title={t(titles[panel])}
          submitLabel={t(
            panel === 'remove'
              ? 'Remove access'
              : panel === 'revoke'
                ? 'Revoke invitation'
                : panel === 'invite'
                  ? 'Create invitation'
                  : 'Save changes'
          )}
          onClose={() => setPanel(null)}
          onSubmit={async (form) => {
            if (panel === 'invite')
              await mutate('/invitations', 'POST', {
                email: String(form.get('email')),
                role,
                expiresInHours: Number(form.get('hours')),
              })
            else if (panel === 'add' || panel === 'edit' || panel === 'remove')
              await mutate('/members', 'PUT', {
                userId: panel === 'add' ? candidate : member!.userId,
                role: panel === 'remove' ? null : role,
              })
            else
              await mutate('/invitations/change', 'POST', {
                invitationId: invitation!.id,
                action: panel,
                expiresInHours: Number(form.get('hours') ?? 24),
              })
          }}
        >
          {panel === 'remove' ? (
            <>
              <p>
                {member?.name} · {member?.email}
              </p>
              <p>{t('This person will lose project access. Existing work and history will be preserved.')}</p>
            </>
          ) : panel === 'revoke' || panel === 'renew' ? (
            <>
              <p>{invitation?.email}</p>
              <p>
                {t(
                  panel === 'renew'
                    ? 'Renewing invalidates the previous link.'
                    : 'The invitation link will stop working.'
                )}
              </p>
            </>
          ) : (
            <>
              {panel === 'invite' ? (
                <label>
                  {t('Email')}
                  <input name="email" type="email" required maxLength={254} />
                </label>
              ) : panel === 'add' ? (
                <div className="select-field">
                  {t('Member')}
                  <Select
                    label={t('Member')}
                    value={candidate}
                    onChange={setCandidate}
                    options={data.candidates.map((m) => ({ value: m.userId, label: m.name + ' · ' + m.email }))}
                  />
                </div>
              ) : (
                <p>
                  {member?.name} · {member?.email}
                </p>
              )}
              <div className="select-field">
                {t('Project role')}
                <Select
                  label={t('Project role')}
                  value={role}
                  onChange={(value) => setRole(value as ProjectRole)}
                  options={roles.map((r) => ({ value: r, label: t(r) }))}
                />
              </div>
              <p className="form-note">{t('team.role.' + role)}</p>
            </>
          )}
          {panel === 'invite' || panel === 'renew' ? (
            <label>
              {t('Validity (hours)')}
              <input name="hours" type="number" min={1} max={168} defaultValue={24} required />
            </label>
          ) : null}
        </FormDialog>
      ) : null}
    </section>
  )
}
