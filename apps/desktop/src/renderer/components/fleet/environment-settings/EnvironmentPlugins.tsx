import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { FLEET_ENVIRONMENT_PLUGINS_FEATURE } from '@maestrly/bot-fleet-protocol'
import { PluginsSettings } from '@/components/plugins/PluginsSettings'
import { createEnvironmentPluginsSource } from '@/components/plugins/plugins-source'
import { useEnvironmentSettingsSource } from '@/lib/fleet/environment-settings'
import { SettingsPanel, type EnvironmentSettingsSectionProps } from './shared'

/**
 * The environment's plugins, in the same plugin center as this computer's: the environment fetches from Git, installs
 * and runs them itself. Changes apply at once, so the section never has unsaved changes.
 */
export function EnvironmentPlugins({ environment, fleet }: EnvironmentSettingsSectionProps) {
  const { t } = useTranslation('plugins')
  const settings = useEnvironmentSettingsSource(environment.id)
  const source = useMemo(
    () => createEnvironmentPluginsSource(environment.id, settings, window.api.fleetEnvironmentPlugins),
    [environment.id, settings]
  )
  const supported =
    fleet.state.connection.features.includes(FLEET_ENVIRONMENT_PLUGINS_FEATURE) &&
    environment.capabilities.includes(FLEET_ENVIRONMENT_PLUGINS_FEATURE)
  return (
    <SettingsPanel>
      {supported ? (
        <PluginsSettings key={environment.id} source={source} />
      ) : (
        <p role="status" className="text-[12.5px] text-muted-foreground">
          {t(
            fleet.state.connection.features.includes(FLEET_ENVIRONMENT_PLUGINS_FEATURE)
              ? 'environment.updateEnvironment'
              : 'environment.updateServer'
          )}
        </p>
      )}
    </SettingsPanel>
  )
}
