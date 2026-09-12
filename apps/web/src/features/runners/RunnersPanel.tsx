import { useEffect, useState } from 'react'
import { Cpu, Trash2 } from 'lucide-react'
import type { RepositoryBinding } from '@maestrly/protocol'
import { api, write } from '../../app/api.js'
import { t, useLocale, errorText, dateTime } from '../../i18n/index.js'
import { FormDialog } from '../../components/FormDialog.js'
import { EmptyState } from '../../components/EmptyState.js'
interface RunnerView {
  id: string
  name: string
  status: string
  capabilities: Array<{ name: string }>
  lastSeenAt: string | null
  repositories?: Array<{ bindingId: string; available: boolean; branches: string[]; error?: string }>
}
export function RunnersPanel({
  organizationId,
  projectId,
  canManage = false,
}: {
  organizationId: string
  projectId: string
  canManage?: boolean
}) {
  useLocale()
  const [runners, setRunners] = useState<RunnerView[]>([]),
    [repos, setRepos] = useState<RepositoryBinding[]>([])
  const [removing, setRemoving] = useState<RunnerView | null>(null)
  const [revision, setRevision] = useState(0)
  const [enrollment, setEnrollment] = useState<{ token: string; expiresAt: string } | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [serverUrl, setServerUrl] = useState(location.origin)
  const base = `/api/v1/organizations/${organizationId}/projects/${projectId}`
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const [runners, repos, meta] = await Promise.all([
          api<RunnerView[]>(base + '/runners'),
          api<RepositoryBinding[]>(base + '/repositories'),
          api<{ canonicalUrl: string }>('/api/v1/meta'),
        ])
        if (alive) {
          setRunners(runners.filter((runner) => runner.status !== 'revoked'))
          setRepos(repos)
          setServerUrl(meta.canonicalUrl)
          setError('')
        }
      } catch (caught) {
        if (alive) setError(caught instanceof Error ? caught.message : 'Could not load runners.')
      }
    }
    void load()
    const timer = setInterval(() => void load(), 10000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [base, revision])
  return (
    <section className="table-panel">
      <header>
        <Cpu />
        <div>
          <p className="eyebrow">{t('Machine identities')}</p>
          <h2>{t('Runners')}</h2>
        </div>
        {canManage ? (
          <button
            className="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              setError('')
              try {
                setEnrollment(
                  await write('/api/v1/runner-enrollments', 'POST', { organizationId, projectIds: [projectId] })
                )
              } catch (caught) {
                setError(caught instanceof Error ? caught.message : 'Could not enroll runner.')
              } finally {
                setBusy(false)
              }
            }}
          >
            {t('Enroll runner')}
          </button>
        ) : null}
      </header>
      {enrollment ? (
        <div className="enrollment-box">
          <p>
            {t('One-use enrollment expires at')} {dateTime(enrollment.expiresAt)}
          </p>
          <pre>
            maestrly-runner enroll --url {serverUrl} --organization {organizationId} --token {enrollment.token}
          </pre>
          <button className="quiet" onClick={() => setEnrollment(null)}>
            {t('Hide token')}
          </button>
        </div>
      ) : null}
      {runners.length === 0 ? (
        <EmptyState title={t('No runner is enrolled')}>
          <p>{t('Enroll a runner to execute work in an approved local repository.')}</p>
        </EmptyState>
      ) : (
        <div className="data-list runner-list">
          {runners.map((runner) => (
            <article key={runner.id}>
              <i className={'presence ' + runner.status} />
              <div>
                <strong>{runner.name}</strong>
                <span>{runner.capabilities.map((c) => c.name).join(' · ')}</span>
                <span>
                  {t(runner.status)} · {runner.lastSeenAt ? dateTime(runner.lastSeenAt) : t('Never connected')}
                </span>
                {runner.repositories
                  ?.filter((r) => !r.available)
                  .map((r) => (
                    <span key={r.bindingId} className="form-error">
                      {t(r.error ?? 'Repository unavailable.')}
                    </span>
                  ))}
              </div>
              {canManage ? (
                <button className="quiet danger" onClick={() => setRemoving(runner)}>
                  <Trash2 size={16} aria-hidden="true" />
                  {t('Remove runner')}
                </button>
              ) : null}
            </article>
          ))}
        </div>
      )}
      {removing && canManage ? (
        <FormDialog
          title={t('Remove runner')}
          submitLabel={t('Remove runner')}
          onClose={() => setRemoving(null)}
          onSubmit={async () => {
            await write(base + '/runners/' + removing.id + '/revoke', 'POST', {})
            setRunners((current) => current.filter((runner) => runner.id !== removing.id))
            setRevision((current) => current + 1)
          }}
        >
          <p><strong>{removing.name}</strong></p>
          <p>{t('This revokes the runner’s access to all its projects and requests cancellation of its running work.')}</p>
          <p>{t('Execution history is kept. To use this runner again, enroll it again.')}</p>
        </FormDialog>
      ) : null}
      {repos
        .filter((repo) => !repo.disabledAt)
        .map((repo) => {
          const ready = runners.some(
            (r) =>
              r.status !== 'revoked' &&
              r.lastSeenAt &&
              Date.now() - new Date(r.lastSeenAt).getTime() < 60000 &&
              r.capabilities.some((c) => c.name.startsWith('executor:')) &&
              r.repositories?.some(
                (item) =>
                  item.bindingId === repo.id && item.available && item.branches.includes(repo.baseBranch ?? 'main')
              )
          )
          return (
            <div className="repository-note" key={repo.id}>
              <strong>
                {repo.name} · {repo.baseBranch}
              </strong>
              <p>
                {t(
                  ready
                    ? 'A runner has this branch available.'
                    : 'No compatible runner is reporting this repository and branch.'
                )}
              </p>
              {canManage ? (
                <>
                  <p>{t('On the runner machine, authorize the existing checkout:')}</p>
                  <pre>
                    maestrly-runner repository --binding {repo.id} --path /path/to/checkout --branch {repo.baseBranch}
                  </pre>
                  <p className="form-note">
                    {t(
                      'Then run doctor and restart the runner. In the desktop, bind this repository ID to a local workspace before enabling its runner.'
                    )}
                  </p>
                  <pre>maestrly-runner doctor{'\n'}maestrly-runner run</pre>
                </>
              ) : null}
            </div>
          )
        })}
      {error ? (
        <p className="form-error" role="alert">
          {errorText(error)}
        </p>
      ) : null}
    </section>
  )
}
