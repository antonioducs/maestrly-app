import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PluginScope } from '../../../shared/plugins'
import type { PluginsSource } from './plugins-source'

/** All conversations, or the chosen projects of this host. Standalone chats only see global plugins. */
export function PluginScopePicker({
  source,
  value,
  onChange,
  disabled,
}: {
  source: PluginsSource
  value: PluginScope
  onChange: (scope: PluginScope) => void
  disabled?: boolean
}) {
  const { t } = useTranslation('plugins')
  const id = useId()
  const [projects, setProjects] = useState<{ id: string; name: string }[] | null>(null)
  useEffect(() => {
    let alive = true
    void source
      .listProjects()
      .then((list) => {
        if (alive) setProjects(list)
      })
      .catch(() => {
        if (alive) setProjects([])
      })
    return () => {
      alive = false
    }
  }, [source])
  const selected = value.kind === 'projects' ? value.workspaceIds : []
  return (
    <fieldset className="flex flex-col gap-1.5" disabled={disabled}>
      <legend className="mb-1 text-[12px] font-medium text-foreground">{t('install.scope')}</legend>
      <label className="flex items-center gap-2 text-[12px] text-foreground">
        <input
          type="radio"
          name={`${id}-scope`}
          checked={value.kind === 'global'}
          onChange={() => onChange({ kind: 'global' })}
        />
        {t('install.scopeGlobal')}
      </label>
      <label className="flex items-center gap-2 text-[12px] text-foreground">
        <input
          type="radio"
          name={`${id}-scope`}
          checked={value.kind === 'projects'}
          onChange={() => onChange({ kind: 'projects', workspaceIds: selected })}
        />
        {t('install.scopeProjects')}
      </label>
      {value.kind === 'projects' && (
        <div className="ml-5 flex max-h-40 flex-col gap-1 overflow-auto">
          {projects?.length === 0 && <p className="text-[11px] text-muted-foreground">{t('install.noProjects')}</p>}
          {projects?.map((project) => (
            <label key={project.id} className="flex items-center gap-2 text-[12px] text-foreground">
              <input
                type="checkbox"
                checked={selected.includes(project.id)}
                onChange={(event) =>
                  onChange({
                    kind: 'projects',
                    workspaceIds: event.target.checked
                      ? [...selected, project.id]
                      : selected.filter((workspaceId) => workspaceId !== project.id),
                  })
                }
              />
              {project.name}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  )
}

export function scopeIsComplete(scope: PluginScope): boolean {
  return scope.kind === 'global' || scope.workspaceIds.length > 0
}
