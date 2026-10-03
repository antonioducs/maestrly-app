import {
  FLEET_SETTINGS_OPERATIONS,
  FLEET_ENVIRONMENT_SETTINGS_FEATURE,
  fleetEnvironmentIdSchema,
} from '@maestrly/bot-fleet-protocol'
import type { GatewayContext } from '../context.js'
import { GatewayError } from '../errors.js'

export async function environmentSettingsRoute(
  key: string,
  params: Record<string, string>,
  body: unknown,
  ctx: GatewayContext
): Promise<{ body: unknown }> {
  const eid = fleetEnvironmentIdSchema.parse(params.eid)
  const environment = ctx.lifecycle.environment(eid)
  if (!environment) throw new GatewayError('NOT_FOUND', 'Environment not found')
  if (!environment.capabilities.includes(FLEET_ENVIRONMENT_SETTINGS_FEATURE))
    throw new GatewayError('CONFLICT', 'Environment settings are unavailable. Restart it to update.')
  if (body && typeof body === 'object') {
    for (const [key, value] of Object.entries(params)) {
      if (key === 'eid') continue
      const supplied = Reflect.get(body, key)
      if ((supplied === null && key === 'slot' ? 'default' : supplied) !== value)
        throw new GatewayError('INVALID_REQUEST', 'Path and settings identifiers differ.')
    }
  }
  const client = ctx.lifecycle.environmentInstance(eid)
  switch (key) {
    case 'settingsAccounts':
      return {
        body: FLEET_SETTINGS_OPERATIONS.accounts.response.parse(
          await client.settingsAccounts(FLEET_SETTINGS_OPERATIONS.accounts.input.parse({}))
        ),
      }
    case 'settingsPatchAccount':
      return {
        body: FLEET_SETTINGS_OPERATIONS.patchAccount.response.parse(
          await client.settingsPatchAccount(FLEET_SETTINGS_OPERATIONS.patchAccount.input.parse(body))
        ),
      }
    case 'settingsRenameSubscription':
      return {
        body: FLEET_SETTINGS_OPERATIONS.renameSubscription.response.parse(
          await client.settingsRenameSubscription(FLEET_SETTINGS_OPERATIONS.renameSubscription.input.parse(body))
        ),
      }
    case 'settingsRemoveAccount':
      return {
        body: FLEET_SETTINGS_OPERATIONS.removeAccount.response.parse(
          await client.settingsRemoveAccount(FLEET_SETTINGS_OPERATIONS.removeAccount.input.parse(body))
        ),
      }
    case 'settingsRemoveSubscription':
      return {
        body: FLEET_SETTINGS_OPERATIONS.removeSubscription.response.parse(
          await client.settingsRemoveSubscription(FLEET_SETTINGS_OPERATIONS.removeSubscription.input.parse(body))
        ),
      }
    case 'settingsModels':
      return {
        body: FLEET_SETTINGS_OPERATIONS.models.response.parse(
          await client.settingsModels(FLEET_SETTINGS_OPERATIONS.models.input.parse({}))
        ),
      }
    case 'settingsSetModelFilter':
      return {
        body: FLEET_SETTINGS_OPERATIONS.setModelFilter.response.parse(
          await client.settingsSetModelFilter(FLEET_SETTINGS_OPERATIONS.setModelFilter.input.parse(body))
        ),
      }
    case 'settingsSkills':
      return {
        body: FLEET_SETTINGS_OPERATIONS.skills.response.parse(
          await client.settingsSkills(FLEET_SETTINGS_OPERATIONS.skills.input.parse({}))
        ),
      }
    case 'settingsSkill':
      return {
        body: FLEET_SETTINGS_OPERATIONS.skill.response.parse(
          await client.settingsSkill(FLEET_SETTINGS_OPERATIONS.skill.input.parse({ name: params.name }))
        ),
      }
    case 'settingsCreateSkill':
      return {
        body: FLEET_SETTINGS_OPERATIONS.createSkill.response.parse(
          await client.settingsCreateSkill(FLEET_SETTINGS_OPERATIONS.createSkill.input.parse(body))
        ),
      }
    case 'settingsWriteSkill':
      return {
        body: FLEET_SETTINGS_OPERATIONS.writeSkill.response.parse(
          await client.settingsWriteSkill(FLEET_SETTINGS_OPERATIONS.writeSkill.input.parse(body))
        ),
      }
    case 'settingsSetSkillEnabled':
      return {
        body: FLEET_SETTINGS_OPERATIONS.setSkillEnabled.response.parse(
          await client.settingsSetSkillEnabled(FLEET_SETTINGS_OPERATIONS.setSkillEnabled.input.parse(body))
        ),
      }
    case 'settingsRemoveSkill':
      return {
        body: FLEET_SETTINGS_OPERATIONS.removeSkill.response.parse(
          await client.settingsRemoveSkill(FLEET_SETTINGS_OPERATIONS.removeSkill.input.parse(body))
        ),
      }
    case 'settingsSearchSkills':
      return {
        body: FLEET_SETTINGS_OPERATIONS.searchSkills.response.parse(
          await client.settingsSearchSkills(FLEET_SETTINGS_OPERATIONS.searchSkills.input.parse(body))
        ),
      }
    case 'settingsInstallSkill':
      return {
        body: FLEET_SETTINGS_OPERATIONS.installSkill.response.parse(
          await client.settingsInstallSkill(FLEET_SETTINGS_OPERATIONS.installSkill.input.parse(body))
        ),
      }
    case 'settingsSkillGroups':
      return {
        body: FLEET_SETTINGS_OPERATIONS.skillGroups.response.parse(
          await client.settingsSkillGroups(FLEET_SETTINGS_OPERATIONS.skillGroups.input.parse({}))
        ),
      }
    case 'settingsCreateSkillGroup':
      return {
        body: FLEET_SETTINGS_OPERATIONS.createSkillGroup.response.parse(
          await client.settingsCreateSkillGroup(FLEET_SETTINGS_OPERATIONS.createSkillGroup.input.parse(body))
        ),
      }
    case 'settingsUpdateSkillGroup':
      return {
        body: FLEET_SETTINGS_OPERATIONS.updateSkillGroup.response.parse(
          await client.settingsUpdateSkillGroup(FLEET_SETTINGS_OPERATIONS.updateSkillGroup.input.parse(body))
        ),
      }
    case 'settingsRemoveSkillGroup':
      return {
        body: FLEET_SETTINGS_OPERATIONS.removeSkillGroup.response.parse(
          await client.settingsRemoveSkillGroup(FLEET_SETTINGS_OPERATIONS.removeSkillGroup.input.parse(body))
        ),
      }
    case 'settingsMcpServers':
      return {
        body: FLEET_SETTINGS_OPERATIONS.mcpServers.response.parse(
          await client.settingsMcpServers(FLEET_SETTINGS_OPERATIONS.mcpServers.input.parse({}))
        ),
      }
    case 'settingsMcpServer':
      return {
        body: FLEET_SETTINGS_OPERATIONS.mcpServer.response.parse(
          await client.settingsMcpServer(FLEET_SETTINGS_OPERATIONS.mcpServer.input.parse({ id: params.id }))
        ),
      }
    case 'settingsCreateMcpServer':
      return {
        body: FLEET_SETTINGS_OPERATIONS.createMcpServer.response.parse(
          await client.settingsCreateMcpServer(FLEET_SETTINGS_OPERATIONS.createMcpServer.input.parse(body))
        ),
      }
    case 'settingsPatchMcpServer':
      return {
        body: FLEET_SETTINGS_OPERATIONS.patchMcpServer.response.parse(
          await client.settingsPatchMcpServer(FLEET_SETTINGS_OPERATIONS.patchMcpServer.input.parse(body))
        ),
      }
    case 'settingsRemoveMcpServer':
      return {
        body: FLEET_SETTINGS_OPERATIONS.removeMcpServer.response.parse(
          await client.settingsRemoveMcpServer(FLEET_SETTINGS_OPERATIONS.removeMcpServer.input.parse(body))
        ),
      }
    case 'settingsTestMcpServer':
      return {
        body: FLEET_SETTINGS_OPERATIONS.testMcpServer.response.parse(
          await client.settingsTestMcpServer(FLEET_SETTINGS_OPERATIONS.testMcpServer.input.parse(body))
        ),
      }
    case 'settingsRuntimes':
      return {
        body: FLEET_SETTINGS_OPERATIONS.runtimes.response.parse(
          await client.settingsRuntimes(FLEET_SETTINGS_OPERATIONS.runtimes.input.parse({}))
        ),
      }
    case 'settingsRuntimeAction':
      return {
        body: FLEET_SETTINGS_OPERATIONS.runtimeAction.response.parse(
          await client.settingsRuntimeAction(FLEET_SETTINGS_OPERATIONS.runtimeAction.input.parse(body))
        ),
      }
    case 'settingsSetRuntimeAutomatic':
      return {
        body: FLEET_SETTINGS_OPERATIONS.setRuntimeAutomatic.response.parse(
          await client.settingsSetRuntimeAutomatic(FLEET_SETTINGS_OPERATIONS.setRuntimeAutomatic.input.parse(body))
        ),
      }
    case 'settingsPreferences':
      return {
        body: FLEET_SETTINGS_OPERATIONS.preferences.response.parse(
          await client.settingsPreferences(FLEET_SETTINGS_OPERATIONS.preferences.input.parse({}))
        ),
      }
    case 'settingsSetPreferences':
      return {
        body: FLEET_SETTINGS_OPERATIONS.setPreferences.response.parse(
          await client.settingsSetPreferences(FLEET_SETTINGS_OPERATIONS.setPreferences.input.parse(body))
        ),
      }
    default:
      throw new GatewayError('NOT_FOUND', 'Settings route not found')
  }
}
