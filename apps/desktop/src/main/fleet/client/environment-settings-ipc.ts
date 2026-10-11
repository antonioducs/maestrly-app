import {
  FLEET_SETTINGS_OPERATIONS,
  FLEET_ENVIRONMENT_SETTINGS_FEATURE,
  fleetEnvironmentIdSchema,
} from '@maestrly/bot-fleet-protocol'
import type { IpcRegistrar } from '../../ipc-registrar'
import type { FleetApiClient } from './api'

interface SettingsClient {
  hasFeature(feature: string): boolean
  getSnapshot(): { environments: Array<{ id: string; capabilities: string[] }> }
  call(key: Parameters<FleetApiClient['call']>[0], options?: Parameters<FleetApiClient['call']>[1]): Promise<unknown>
}
import { FleetClientError } from './api'

export function registerFleetEnvironmentSettingsIpc(reg: IpcRegistrar, fleet: SettingsClient): void {
  function target(raw: unknown): string {
    const id = fleetEnvironmentIdSchema.parse(raw)
    if (!fleet.hasFeature(FLEET_ENVIRONMENT_SETTINGS_FEATURE))
      throw new FleetClientError('CONFLICT', 409, 'Gateway does not support environment settings.')
    const environment = fleet.getSnapshot().environments.find((value) => value.id === id)
    if (!environment) throw new FleetClientError('NOT_FOUND', 404, 'Environment not found.')
    if (!environment.capabilities.includes(FLEET_ENVIRONMENT_SETTINGS_FEATURE))
      throw new FleetClientError('CONFLICT', 409, 'Environment does not support settings. Restart it to update.')
    return id
  }
  reg.handle('fleet:settings:accounts', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    FLEET_SETTINGS_OPERATIONS.accounts.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.accounts.response.parse(await fleet.call('settingsAccounts', { params: { eid } }))
  })
  reg.mhandle('fleet:settings:patchAccount', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.patchAccount.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.patchAccount.response.parse(
      await fleet.call('settingsPatchAccount', { params: { eid, providerId: input.providerId }, body: input })
    )
  })
  reg.mhandle('fleet:settings:renameSubscription', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.renameSubscription.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.renameSubscription.response.parse(
      await fleet.call('settingsRenameSubscription', {
        params: { eid, kind: input.kind, slot: input.slot ?? 'default' },
        body: input,
      })
    )
  })
  reg.mhandle('fleet:settings:removeAccount', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.removeAccount.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.removeAccount.response.parse(
      await fleet.call('settingsRemoveAccount', { params: { eid, providerId: input.providerId }, body: input })
    )
  })
  reg.mhandle('fleet:settings:removeSubscription', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.removeSubscription.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.removeSubscription.response.parse(
      await fleet.call('settingsRemoveSubscription', {
        params: { eid, kind: input.kind, slot: input.slot ?? 'default' },
        body: input,
      })
    )
  })
  reg.handle('fleet:settings:models', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    FLEET_SETTINGS_OPERATIONS.models.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.models.response.parse(await fleet.call('settingsModels', { params: { eid } }))
  })
  reg.mhandle('fleet:settings:setModelFilter', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.setModelFilter.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.setModelFilter.response.parse(
      await fleet.call('settingsSetModelFilter', { params: { eid, providerId: input.providerId }, body: input })
    )
  })
  reg.handle('fleet:settings:skills', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    FLEET_SETTINGS_OPERATIONS.skills.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.skills.response.parse(await fleet.call('settingsSkills', { params: { eid } }))
  })
  reg.handle('fleet:settings:skill', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.skill.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.skill.response.parse(
      await fleet.call('settingsSkill', { params: { eid, name: input.name } })
    )
  })
  reg.mhandle('fleet:settings:createSkill', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.createSkill.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.createSkill.response.parse(
      await fleet.call('settingsCreateSkill', { params: { eid }, body: input })
    )
  })
  reg.mhandle('fleet:settings:writeSkill', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.writeSkill.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.writeSkill.response.parse(
      await fleet.call('settingsWriteSkill', { params: { eid, name: input.name }, body: input })
    )
  })
  reg.mhandle('fleet:settings:setSkillEnabled', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.setSkillEnabled.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.setSkillEnabled.response.parse(
      await fleet.call('settingsSetSkillEnabled', { params: { eid, name: input.name }, body: input })
    )
  })
  reg.mhandle('fleet:settings:removeSkill', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.removeSkill.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.removeSkill.response.parse(
      await fleet.call('settingsRemoveSkill', { params: { eid, name: input.name }, body: input })
    )
  })
  reg.mhandle('fleet:settings:searchSkills', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.searchSkills.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.searchSkills.response.parse(
      await fleet.call('settingsSearchSkills', { params: { eid }, body: input })
    )
  })
  reg.mhandle('fleet:settings:installSkill', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.installSkill.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.installSkill.response.parse(
      await fleet.call('settingsInstallSkill', { params: { eid }, body: input })
    )
  })
  reg.handle('fleet:settings:skillGroups', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    FLEET_SETTINGS_OPERATIONS.skillGroups.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.skillGroups.response.parse(
      await fleet.call('settingsSkillGroups', { params: { eid } })
    )
  })
  reg.mhandle('fleet:settings:createSkillGroup', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.createSkillGroup.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.createSkillGroup.response.parse(
      await fleet.call('settingsCreateSkillGroup', { params: { eid }, body: input })
    )
  })
  reg.mhandle('fleet:settings:updateSkillGroup', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.updateSkillGroup.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.updateSkillGroup.response.parse(
      await fleet.call('settingsUpdateSkillGroup', { params: { eid, id: input.id }, body: input })
    )
  })
  reg.mhandle('fleet:settings:removeSkillGroup', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.removeSkillGroup.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.removeSkillGroup.response.parse(
      await fleet.call('settingsRemoveSkillGroup', { params: { eid, id: input.id }, body: input })
    )
  })
  reg.handle('fleet:settings:mcpServers', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    FLEET_SETTINGS_OPERATIONS.mcpServers.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.mcpServers.response.parse(
      await fleet.call('settingsMcpServers', { params: { eid } })
    )
  })
  reg.handle('fleet:settings:mcpServer', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.mcpServer.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.mcpServer.response.parse(
      await fleet.call('settingsMcpServer', { params: { eid, id: input.id } })
    )
  })
  reg.mhandle('fleet:settings:createMcpServer', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.createMcpServer.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.createMcpServer.response.parse(
      await fleet.call('settingsCreateMcpServer', { params: { eid }, body: input })
    )
  })
  reg.mhandle('fleet:settings:patchMcpServer', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.patchMcpServer.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.patchMcpServer.response.parse(
      await fleet.call('settingsPatchMcpServer', { params: { eid, id: input.id }, body: input })
    )
  })
  reg.mhandle('fleet:settings:removeMcpServer', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.removeMcpServer.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.removeMcpServer.response.parse(
      await fleet.call('settingsRemoveMcpServer', { params: { eid, id: input.id }, body: input })
    )
  })
  reg.mhandle('fleet:settings:testMcpServer', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.testMcpServer.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.testMcpServer.response.parse(
      await fleet.call('settingsTestMcpServer', { params: { eid, id: input.id }, body: input })
    )
  })
  reg.handle('fleet:settings:runtimes', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    FLEET_SETTINGS_OPERATIONS.runtimes.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.runtimes.response.parse(await fleet.call('settingsRuntimes', { params: { eid } }))
  })
  reg.mhandle('fleet:settings:runtimeAction', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.runtimeAction.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.runtimeAction.response.parse(
      await fleet.call('settingsRuntimeAction', { params: { eid, id: input.id }, body: input })
    )
  })
  reg.mhandle('fleet:settings:setRuntimeAutomatic', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.setRuntimeAutomatic.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.setRuntimeAutomatic.response.parse(
      await fleet.call('settingsSetRuntimeAutomatic', { params: { eid, id: input.id }, body: input })
    )
  })
  reg.handle('fleet:settings:preferences', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    FLEET_SETTINGS_OPERATIONS.preferences.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.preferences.response.parse(
      await fleet.call('settingsPreferences', { params: { eid } })
    )
  })
  reg.mhandle('fleet:settings:setPreferences', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.setPreferences.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.setPreferences.response.parse(
      await fleet.call('settingsSetPreferences', { params: { eid }, body: input })
    )
  })
}
