import { useCallback, useEffect, useId, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { FLEET_WORKSPACES_ENVIRONMENTS_FEATURE, type FleetSettingsOutput } from '@maestrly/bot-fleet-protocol'
import { useEnvironmentSettingsResource, useEnvironmentSettingsSource } from '@/lib/fleet/environment-settings'
import { isWorkspacesEnvironment } from '@/lib/fleet/selectors'
import { EnvironmentCompaction } from '../EnvironmentCompaction'
import { TintPicker } from '../CreateWorkspacesDialog'
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
  const serverId = fleet.serverId
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
  const tintId = useId()
  // A workspaces environment's color tells it apart in the sidebar; a server from before scopes keeps none.
  const tinted =
    isWorkspacesEnvironment(environment) &&
    fleet.state.connection.features.includes(FLEET_WORKSPACES_ENVIRONMENTS_FEATURE)
  const savedTint = useRef(environment.tint)
  const editor = useSettingsDraft(
    {
      name: environment.name,
      tint: environment.tint,
      imageGenEnabled: initial.imageGenEnabled,
      generatedInterfacesEnabled: initial.generatedInterfacesEnabled,
    },
    async (draft) => {
      const renames = draft.name !== savedName.current
      const recolors = tinted && draft.tint !== savedTint.current
      if (renames || recolors) {
        const updated = await window.api.fleetPatchEnvironment(serverId, environment.id, {
          ...(renames ? { name: draft.name, expected: { name: savedName.current } } : {}),
          ...(recolors ? { tint: draft.tint } : {}),
        })
        fleet.dispatch({
          type: 'event',
          value: { type: 'environment.updated', at: new Date().toISOString(), environment: updated },
        })
        savedName.current = draft.name
        savedTint.current = draft.tint
      }
      const updated = await source.setPreferences({
        expectedRevision: revision.current,
        imageGenEnabled: draft.imageGenEnabled,
        // An environment that did not report the setting predates it, and refuses unknown fields.
        ...(draft.generatedInterfacesEnabled === undefined
          ? {}
          : { generatedInterfacesEnabled: draft.generatedInterfacesEnabled }),
      })
      revision.current = updated.revision
    },
    preferencesDirty,
    initial.revision + ':' + environment.name + ':' + (environment.tint ?? '')
  )
  useEffect(() => {
    if (!editor.dirty) {
      revision.current = initial.revision
      savedName.current = environment.name
      savedTint.current = environment.tint
    }
  }, [initial.revision, environment.name, environment.tint])
  return (
    <SettingsPanel
      error={editor.error}
      reload={() => {
        void source
          .preferences({})
          .then((updated) => {
            revision.current = updated.revision
            savedName.current = environment.name
            editor.reset({
              name: environment.name,
              tint: environment.tint,
              imageGenEnabled: updated.imageGenEnabled,
              generatedInterfacesEnabled: updated.generatedInterfacesEnabled,
            })
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
      {tinted && (
        <div className="space-y-1.5 border-b border-border py-3">
          <h3 id={tintId} className="text-xs font-medium">
            {t('workspaces.tintLabel')}
          </h3>
          <TintPicker
            // No color chosen yet: no swatch is selected, and the sidebar keeps the one derived from its id.
            value={editor.draft.tint ?? ''}
            onChange={(tint) => editor.setDraft((d) => ({ ...d, tint }))}
            labelledBy={tintId}
            disabled={editor.busy}
          />
          <p className="text-xs text-muted-foreground">{t('workspaces.tintNote')}</p>
        </div>
      )}
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
      {editor.draft.generatedInterfacesEnabled !== undefined && (
        <div className="flex items-center justify-between gap-3 border-b border-border py-3">
          <div>
            <h3 className="text-xs font-medium">{t('environmentSettings.generatedInterfaces')}</h3>
            <p className="text-xs text-muted-foreground">{t('environmentSettings.generatedInterfacesNote')}</p>
          </div>
          <SettingsSwitch
            checked={editor.draft.generatedInterfacesEnabled}
            disabled={editor.busy}
            label={t('environmentSettings.generatedInterfaces')}
            onChange={() =>
              editor.setDraft((d) => ({ ...d, generatedInterfacesEnabled: !d.generatedInterfacesEnabled }))
            }
          />
        </div>
      )}
      <div className="flex items-center justify-between gap-3 border-b border-border py-3">
        <div>
          <h3 className="text-xs font-medium">{t('environmentSettings.appTools')}</h3>
          <p className="text-xs text-muted-foreground">{t('environmentSettings.appToolsLocked')}</p>
        </div>
        <SettingsSwitch checked disabled label={t('environmentSettings.appTools')} onChange={() => {}} />
      </div>
      <SaveDiscard {...editor} />
      {/* The default compaction model is for bots, and a workspaces environment has none. */}
      {!isWorkspacesEnvironment(environment) && (
        <EnvironmentCompaction
          {...{ onDirtyChange: compactionDirty }}
          environment={environment}
          fleet={fleet}
          bots={fleet.state.snapshot.bots.filter((bot) => bot.environmentId === environment.id)}
          optionsKey={environment.id}
        />
      )}
    </SettingsPanel>
  )
}
