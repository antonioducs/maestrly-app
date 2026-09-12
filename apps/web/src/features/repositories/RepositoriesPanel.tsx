import { useEffect, useState } from 'react'
import { GitBranch, Plus } from 'lucide-react'
import type { RepositoryBinding } from '@maestrly/protocol'
import { api, write } from '../../app/api.js'
import { FormDialog } from '../../components/FormDialog.js'
import { t, useLocale, errorText } from '../../i18n/index.js'
export function RepositoriesPanel({
  organizationId,
  projectId,
  canManage,
  onChanged,
}: {
  organizationId: string
  projectId: string
  canManage: boolean
  onChanged(): void
}) {
  useLocale()
  const [repositories, setRepositories] = useState<RepositoryBinding[]>([]),
    [editing, setEditing] = useState<RepositoryBinding | 'new' | null>(null)
  const [error, setError] = useState(''),
    [defaultId, setDefaultId] = useState<string | null>(null)
  const base = `/api/v1/organizations/${organizationId}/projects/${projectId}`
  const load = async () => {
    try {
      const [repos, project] = await Promise.all([
        api<RepositoryBinding[]>(base + '/repositories'),
        api<{ defaultRepositoryBindingId?: string | null }>(base),
      ])
      setRepositories(repos)
      setDefaultId(project.defaultRepositoryBindingId ?? null)
      setError('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load repositories.')
    }
  }
  useEffect(() => {
    void load()
  }, [base])
  const repository = editing && editing !== 'new' ? editing : null
  return (
    <section className="settings-panel">
      <header>
        <GitBranch />
        <div>
          <p className="eyebrow">{t('Project settings')}</p>
          <h2>{t('Git repositories')}</h2>
        </div>
        {canManage ? (
          <button className="primary" onClick={() => setEditing('new')}>
            <Plus size={15} />
            {t('Add repository')}
          </button>
        ) : null}
      </header>
      <p className="form-note">
        {t(
          'Approve a local checkout on a runner. Git credentials stay on that machine; deliveries are patches for review.'
        )}
      </p>
      {!defaultId ? (
        <p className="repository-note">
          {t('Project without a default Git repository. Choose a repository for code execution policies.')}
        </p>
      ) : null}
      <div className="data-list">
        {repositories.map((repo) => (
          <article key={repo.id}>
            <GitBranch size={18} />
            <div>
              <strong>
                {repo.name}
                {repo.id === defaultId ? ' · ' + t('Default') : ''}
              </strong>
              <span>
                {repo.cloneUrl || t('Local repository')} · {repo.baseBranch} ·{' '}
                {t(repo.disabledAt ? 'Disabled' : 'Enabled')}
              </span>
              <code>{repo.id}</code>
            </div>
            {canManage ? (
              <button className="quiet" onClick={() => setEditing(repo)}>
                {t('Edit')}
              </button>
            ) : null}
          </article>
        ))}
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {errorText(error)}
        </p>
      ) : null}
      {editing ? (
        <FormDialog
          title={t(repository ? 'Edit repository' : 'Add repository')}
          submitLabel={t('Save changes')}
          onClose={() => setEditing(null)}
          onSubmit={async (data) => {
            const name = String(data.get('name') ?? '').trim(),
              baseBranch = String(data.get('baseBranch') ?? '').trim()
            if (!name || !baseBranch) throw new Error('Repository name and branch are required.')
            await write(
              base + '/repositories' + (repository ? '/' + repository.id : ''),
              repository ? 'PATCH' : 'POST',
              {
                name,
                baseBranch,
                cloneUrl: String(data.get('cloneUrl') ?? '').trim(),
                disabled: data.get('disabled') === 'on',
                makeDefault: data.get('default') === 'on',
                ...(repository ? { expectedVersion: repository.version } : {}),
              }
            )
            await load()
            onChanged()
          }}
        >
          <label>
            {t('Repository name')}
            <input name="name" required maxLength={160} defaultValue={repository?.name ?? ''} />
          </label>
          <label>
            {t('Git URL (optional)')}
            <input
              name="cloneUrl"
              defaultValue={repository?.cloneUrl ?? ''}
              placeholder="git@github.com:team/repository.git"
            />
          </label>
          <label>
            {t('Base branch')}
            <input name="baseBranch" required maxLength={250} defaultValue={repository?.baseBranch ?? 'main'} />
          </label>
          <label className="check">
            <input name="default" type="checkbox" defaultChecked={!defaultId || repository?.id === defaultId} />
            {t('Use as project default')}
          </label>
          {repository ? (
            <label className="check">
              <input name="disabled" type="checkbox" defaultChecked={!!repository.disabledAt} />
              {t('Disable repository')}
            </label>
          ) : null}
          <p className="form-note">{t('Changes affect future jobs. Existing execution snapshots are preserved.')}</p>
        </FormDialog>
      ) : null}
    </section>
  )
}
