import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { FleetSettingsOutput } from '@maestrly/bot-fleet-protocol'
import { useEnvironmentSettingsResource, useEnvironmentSettingsSource } from '@/lib/fleet/environment-settings'
import { EnvironmentCompaction } from '../EnvironmentCompaction'
import { SettingsSwitch } from '../SettingsSwitch'
import {
  SaveDiscard,
  SettingsPanel,
  settingsInput,
  useSettingsDraft,
  useCombinedSettingsDraft,
  type EnvironmentSettingsSectionProps,
} from './shared'
export function EnvironmentPreferences(props: EnvironmentSettingsSectionProps) {
  const resource = useEnvironmentSettingsResource(props.environment.id, 'preferences')
  return (
    <SettingsPanel
      error={resource.error}
      loading={!resource.data && resource.busy}
      reload={() => void resource.reload()}
    >
      {resource.data && <PreferencesEditor key={props.environment.id} {...props} initial={resource.data} />}
    </SettingsPanel>
  )
}
function PreferencesEditor({
  environment,
  fleet,
  onDirtyChange,
  initial,
}: EnvironmentSettingsSectionProps & { initial: FleetSettingsOutput<'preferences'> }) {
  const { t } = useTranslation('fleet')
  const source = useEnvironmentSettingsSource(environment.id)
  const updateDirty = useCombinedSettingsDraft(onDirtyChange)
  const preferencesDirty = useCallback<NonNullable<EnvironmentSettingsSectionProps['onDirtyChange']>>(
    (...args) => updateDirty('preferences', ...args),
    [updateDirty]
  )
  const compactionDirty = useCallback<NonNullable<EnvironmentSettingsSectionProps['onDirtyChange']>>(
    (...args) => updateDirty('compaction', ...args),
    [updateDirty]
  )
  const revision = useRef(initial.revision)
  const savedName = useRef(environment.name)
  const editor = useSettingsDraft(
    { name: environment.name, imageGenEnabled: initial.imageGenEnabled },
    async (draft) => {
      if (draft.name !== savedName.current) {
        const updated = await window.api.fleetPatchEnvironment(environment.id, {
          name: draft.name,
          expected: { name: savedName.current },
        })
        fleet.dispatch({
          type: 'event',
          value: { type: 'environment.updated', at: new Date().toISOString(), environment: updated },
        })
        savedName.current = draft.name
      }
      const updated = await source.setPreferences({
        expectedRevision: revision.current,
        imageGenEnabled: draft.imageGenEnabled,
      })
      revision.current = updated.revision
    },
    preferencesDirty,
    initial.revision + ':' + environment.name
  )
  useEffect(() => {
    if (!editor.dirty) {
      revision.current = initial.revision
      savedName.current = environment.name
    }
  }, [initial.revision, environment.name])
  return (
    <SettingsPanel
      error={editor.error}
      reload={() => {
        void source
          .preferences({})
          .then((updated) => {
            revision.current = updated.revision
            savedName.current = environment.name
            editor.reset({ name: environment.name, imageGenEnabled: updated.imageGenEnabled })
          })
          .catch(() => {})
      }}
    >
      <label className="block space-y-1">
        {t('environmentSettings.name')}
        <input
          className={settingsInput}
          value={editor.draft.name}
          disabled={editor.busy}
          onChange={(e) => editor.setDraft((d) => ({ ...d, name: e.target.value }))}
        />
      </label>
      <div className="flex items-center justify-between gap-3 border-b border-border py-3">
        <div>
          <h3 className="text-xs font-medium">{t('environmentSettings.imageGen')}</h3>
          <p className="text-xs text-muted-foreground">{t('environmentSettings.imageGenNote')}</p>
        </div>
        <SettingsSwitch
          checked={editor.draft.imageGenEnabled}
          disabled={editor.busy}
          label={t('environmentSettings.imageGen')}
          onChange={() => editor.setDraft((d) => ({ ...d, imageGenEnabled: !d.imageGenEnabled }))}
        />
      </div>
      <div className="flex items-center justify-between gap-3 border-b border-border py-3">
        <div>
          <h3 className="text-xs font-medium">{t('environmentSettings.appTools')}</h3>
          <p className="text-xs text-muted-foreground">{t('environmentSettings.appToolsLocked')}</p>
        </div>
        <SettingsSwitch checked disabled label={t('environmentSettings.appTools')} onChange={() => {}} />
      </div>
      <SaveDiscard {...editor} />
      <EnvironmentCompaction
        {...{ onDirtyChange: compactionDirty }}
        environment={environment}
        fleet={fleet}
        bots={fleet.state.snapshot.bots.filter((bot) => bot.environmentId === environment.id)}
        optionsKey={environment.id}
      />
    </SettingsPanel>
  )
}
