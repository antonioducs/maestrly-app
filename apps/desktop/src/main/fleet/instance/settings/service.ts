import type { FleetEnvironmentSettingsService } from '@maestrly/bot-fleet-protocol'
import { invalidateMcpConfiguration } from '../../../chat/chatgpt-web/manager'
import { createAccountsSettingsService, type AccountsSettingsHost } from './accounts'
import { createModelsSettingsService } from './models'
import { createSkillSettingsService } from './skills'
import { mcpSettingsService } from './mcp'
import { runtimes, runtimeAction, setRuntimeAutomatic } from './runtimes'
import { preferences, setPreferences } from './preferences'
import { createPluginSettingsService } from './plugins'

/** Invalidate derived web sessions after a durable write without reporting that write as failed. */
export function environmentMcpChanged(): void {
  void invalidateMcpConfiguration().catch(() => {
    console.warn('[environment-settings] Could not refresh MCP sessions.')
  })
}

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
    async createMcpServer(input) {
      const result = await mcpSettingsService.createMcpServer(input)
      environmentMcpChanged()
      return result
    },
    async patchMcpServer(input) {
      const result = await mcpSettingsService.patchMcpServer(input)
      environmentMcpChanged()
      return result
    },
    async removeMcpServer(input) {
      const result = await mcpSettingsService.removeMcpServer(input)
      environmentMcpChanged()
      return result
    },
    runtimes,
    runtimeAction,
    setRuntimeAutomatic,
    preferences,
    setPreferences,
    // The plugin engine reports its MCP changes itself (`onPluginMcpSurfaceChanged`, wired at startup).
    ...createPluginSettingsService(home),
  }
}
