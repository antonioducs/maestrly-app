import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FleetSettingsOutput } from '@maestrly/bot-fleet-protocol'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ModelVisibilityCheckbox } from '@/components/chat/ModelVisibilityCheckbox'
import { useEnvironmentSettingsResource, useEnvironmentSettingsSource } from '@/lib/fleet/environment-settings'
import {
  SaveDiscard,
  SettingsPanel,
  settingsInput,
  Usage,
  useSettingsDraft,
  type EnvironmentSettingsSectionProps,
} from './shared'
export function EnvironmentModels(props: EnvironmentSettingsSectionProps) {
  const resource = useEnvironmentSettingsResource(props.environment.id, 'models')
  return (
    <SettingsPanel
      error={resource.error}
      reload={() => void resource.reload()}
      loading={!resource.data && resource.busy}
    >
      {resource.data && (
        <ModelsEditor key={props.environment.id} {...props} initial={resource.data} onReload={resource.reload} />
      )}
    </SettingsPanel>
  )
}
function ModelsEditor({
  environment,
  initial,
  onDirtyChange,
  onReload,
}: EnvironmentSettingsSectionProps & { initial: FleetSettingsOutput<'models'>; onReload: () => Promise<void> }) {
  const { t } = useTranslation('fleet')
  const source = useEnvironmentSettingsSource(environment.id)
  const current = useRef(initial)
  const observed = useRef(initial)
  const [catalog, setCatalog] = useState(initial)
  const [query, setQuery] = useState('')
  const [provider, setProvider] = useState('all')
  const [visibility, setVisibility] = useState('all')
  const [conflict, setConflict] = useState(false)
  const editor = useSettingsDraft(
    Object.fromEntries(initial.providers.map((p) => [p.providerId, p.hiddenModelIds])),
    async (draft) => {
      for (const p of current.current.providers) {
        if (JSON.stringify(p.hiddenModelIds) === JSON.stringify(draft[p.providerId])) continue
        current.current = await source.setModelFilter({
          providerId: p.providerId,
          expectedRevision: p.revision,
          hiddenModelIds: draft[p.providerId],
        })
      }
      setCatalog(current.current)
    },
    onDirtyChange
  )
  useEffect(() => {
    if (observed.current === initial) return
    observed.current = initial
    if (JSON.stringify(current.current) === JSON.stringify(initial)) return
    setCatalog(initial)
    if (editor.dirty) {
      editor.setDraft((draft) =>
        Object.fromEntries(
          initial.providers.map((provider) => {
            const original = current.current.providers.find((p) => p.providerId === provider.providerId)
            return [
              provider.providerId,
              JSON.stringify(draft[provider.providerId]) === JSON.stringify(original?.hiddenModelIds)
                ? provider.hiddenModelIds
                : (draft[provider.providerId] ?? provider.hiddenModelIds),
            ]
          })
        )
      )
      setConflict(true)
      return
    }
    current.current = initial
    editor.reset(Object.fromEntries(initial.providers.map((p) => [p.providerId, p.hiddenModelIds])))
  }, [initial, editor.dirty, editor.reset])
  const discard = () => {
    current.current = catalog
    editor.reset(Object.fromEntries(catalog.providers.map((p) => [p.providerId, p.hiddenModelIds])))
    setConflict(false)
  }
  const filtered = catalog.providers
    .filter((p) => provider === 'all' || p.providerId === provider)
    .map((p) => ({
      ...p,
      models: p.models.filter(
        (m) =>
          `${m.id} ${m.name}`.toLowerCase().includes(query.toLowerCase()) &&
          (visibility === 'all' || (visibility === 'hidden') === !!editor.draft[p.providerId]?.includes(m.id))
      ),
    }))
    .filter((p) => p.models.length)
  const total = catalog.providers.reduce((n, p) => n + p.models.length, 0)
  const visible = catalog.providers.reduce(
    (n, p) => n + p.models.filter((m) => !editor.draft[p.providerId]?.includes(m.id)).length,
    0
  )
  return (
    <SettingsPanel
      error={editor.error}
      reload={() => {
        discard()
        void onReload()
      }}
    >
      <p className="text-xs text-muted-foreground">{t('environmentSettings.modelsNote')}</p>
      {conflict && (
        <p role="alert" className="text-xs text-destructive">
          {t('environmentSettings.conflict')}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {t('environmentSettings.modelCounts', { visible, hidden: total - visible, total })}
      </p>
      <div className="flex gap-2">
        <input
          className={settingsInput}
          aria-label={t('environmentSettings.search')}
          placeholder={t('environmentSettings.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Select value={provider} onValueChange={setProvider}>
          <SelectTrigger className="w-52" aria-label={t('environmentSettings.provider')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('environmentSettings.allProviders')}</SelectItem>
            {catalog.providers.map((p) => (
              <SelectItem key={p.providerId} value={p.providerId}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={visibility} onValueChange={setVisibility}>
          <SelectTrigger className="w-40" aria-label={t('environmentSettings.visibility')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {['all', 'visible', 'hidden'].map((value) => (
              <SelectItem key={value} value={value}>
                {t(`environmentSettings.visibilityFilter.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p className="text-xs text-muted-foreground">
        {t('environmentSettings.modelResults', { count: filtered.reduce((n, p) => n + p.models.length, 0) })}
      </p>
      {filtered.map((p) => (
        <div key={p.providerId} className="space-y-1">
          <h3 className="text-xs font-medium">{p.name}</h3>
          <div className="rounded-md border border-border">
            {p.models
              .filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(query.toLowerCase()))
              .map((m) => (
                <ModelVisibilityCheckbox
                  key={m.id}
                  name={m.name}
                  checked={!editor.draft[p.providerId]?.includes(m.id)}
                  disabled={editor.busy}
                  onChange={() =>
                    editor.setDraft((d) => ({
                      ...d,
                      [p.providerId]: (d[p.providerId] ?? []).includes(m.id)
                        ? d[p.providerId].filter((id) => id !== m.id)
                        : [...(d[p.providerId] ?? []), m.id],
                    }))
                  }
                >
                  <Usage bots={m.bots} />
                </ModelVisibilityCheckbox>
              ))}
          </div>
        </div>
      ))}
      {!filtered.length && <p className="text-xs text-muted-foreground">{t('environmentSettings.empty')}</p>}
      <SaveDiscard {...editor} discard={discard} save={async () => (conflict ? false : editor.save())} />
    </SettingsPanel>
  )
}
