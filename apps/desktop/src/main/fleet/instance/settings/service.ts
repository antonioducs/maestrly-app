import type { FleetEnvironmentSettingsService } from '@maestrly/bot-fleet-protocol'
import { createAccountsSettingsService, type AccountsSettingsHost } from './accounts'
import { createModelsSettingsService } from './models'
import { createSkillSettingsService } from './skills'
import { mcpSettingsService } from './mcp'
import { runtimes, runtimeAction, setRuntimeAutomatic } from './runtimes'
import { preferences, setPreferences } from './preferences'
import { createAccountPoolsSettingsService } from './account-pools'
import { createPluginSettingsService } from './plugins'

/** These functions run inside the targeted environment, never in the controller's profile. */
export function createEnvironmentSettingsService(
  host: AccountsSettingsHost,
  home: string
): FleetEnvironmentSettingsService {
  return {
    ...createAccountsSettingsService(host),
    ...createModelsSettingsService(host),
    ...createSkillSettingsService(home),
    ...mcpSettingsService,
    runtimes,
    runtimeAction,
    setRuntimeAutomatic,
    preferences,
    setPreferences,
    ...createAccountPoolsSettingsService(host),
    ...createPluginSettingsService(home),
  }
}
