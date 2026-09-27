import { macProvisioningErrorCodes } from '../../../shared/fleet-provisioning'
import {
  fleetTargetKey,
  type FleetProvisioningTarget,
  type FleetProvisioningTargetInput,
} from '../../../shared/fleet-targets'
import { useCallback, useEffect, useState } from 'react'
import {
  FLEET_ENVIRONMENT_COMPACTION_FEATURE,
  FLEET_ENVIRONMENT_LIMITS,
  FLEET_ENVIRONMENTS_FEATURE,
  FLEET_PROVISIONING_FEATURE,
  type FleetBot,
  type FleetBotAccounts,
  type FleetBotSkills,
  type FleetBotMcpServers,
  type FleetEnvironment,
} from '@maestrly/bot-fleet-protocol'
import type { MacInventory, MacImportSelection } from '../../../shared/fleet-provisioning'
import type { FleetController } from './use-fleet'
import { fleetErrorMessage } from './errors'
import { environmentOf } from './selectors'

export type ImportGroup = 'accounts' | 'skills' | 'mcp'
export const importGroups: ImportGroup[] = ['accounts', 'skills', 'mcp']
export type ImportChoice = MacImportSelection & { loginIds: string[] }
export const emptyImportChoice = (): ImportChoice => ({
  apiKeyIds: [],
  copyIds: [],
  skillNames: [],
  mcpServerIds: [],
  loginIds: [],
})
export function hasImportChoice(choice: ImportChoice) {
  return Object.values(choice).some((ids) => ids.length > 0)
}
export function recommendedImportChoice(inventory: MacInventory, groups: ImportGroup[]): ImportChoice {
  return {
    apiKeyIds: groups.includes('accounts')
      ? inventory.apiKeys.filter((item) => !item.localOnly).map((item) => item.id)
      : [],
    copyIds: groups.includes('accounts') ? inventory.copies.map((item) => item.id) : [],
    loginIds: groups.includes('accounts') ? inventory.logins.map((item) => item.id) : [],
    skillNames: groups.includes('skills')
      ? inventory.skills.filter((item) => !item.problem).map((item) => item.name)
      : [],
    mcpServerIds: groups.includes('mcp')
      ? inventory.mcpServers.filter((item) => !item.warnings.length && item.recommended).map((item) => item.id)
      : [],
  }
}
export type BotProvisioningAvailability = 'ready' | 'update-server' | 'restart-bot'
export type EnvironmentProvisioningAvailability = 'ready' | 'update-server' | 'restart-environment'
/** A running Maestrly without a capability predates it; restarting brings it the gateway's current image. */
function needsRestart(runtime: Pick<FleetEnvironment, 'lifecycle' | 'capabilities'>, capability: string): boolean {
  return runtime.lifecycle === 'running' && !runtime.capabilities.includes(capability)
}
/**
 * Whether the Mac can provision an environment or a bot. A bot's accounts, skills and MCP servers are those of its
 * environment, so the Maestrly that must support them is its listed environment's, else the bot's own.
 */
export function provisioningAvailability(fleet: FleetController, bot: FleetBot): BotProvisioningAvailability
export function provisioningAvailability(
  fleet: FleetController,
  environment: FleetEnvironment
): EnvironmentProvisioningAvailability
export function provisioningAvailability(
  fleet: FleetController,
  target: FleetBot | FleetEnvironment
): BotProvisioningAvailability | EnvironmentProvisioningAvailability {
  if (!fleet.state.connection.features.includes(FLEET_PROVISIONING_FEATURE)) return 'update-server'
  if ('botIds' in target) return needsRestart(target, FLEET_PROVISIONING_FEATURE) ? 'restart-environment' : 'ready'
  const runtime = (target.environmentId && environmentOf(fleet.state.snapshot.environments, target)) || target
  return needsRestart(runtime, FLEET_PROVISIONING_FEATURE) ? 'restart-bot' : 'ready'
}
export type EnvironmentJoinAvailability =
  | 'ready'
  | 'update-server'
  | 'restart-environment'
  | 'full'
  | 'start-environment'
  | 'not-running'
/**
 * Whether a new bot can join an environment: the gateway must have environments, the environment must have room
 * and run, and its Maestrly must host several bots (an older image needs the environment restarted first). A stopped
 * environment would only set the bot up once started, so joining it waits for the owner to start it.
 */
export function environmentJoinAvailability(
  fleet: FleetController,
  environment: FleetEnvironment
): EnvironmentJoinAvailability {
  if (!fleet.state.connection.features.includes(FLEET_ENVIRONMENTS_FEATURE)) return 'update-server'
  if (environment.botIds.length >= FLEET_ENVIRONMENT_LIMITS.botsMax) return 'full'
  if (environment.lifecycle === 'stopped' || environment.lifecycle === 'failed') return 'start-environment'
  if (environment.lifecycle !== 'running') return 'not-running'
  return needsRestart(environment, FLEET_ENVIRONMENTS_FEATURE) ? 'restart-environment' : 'ready'
}
/** Why a new bot cannot join an environment yet, as a translation key and its values. */
export function environmentJoinHint(availability: Exclude<EnvironmentJoinAvailability, 'ready'>): {
  key: string
  values?: Record<string, unknown>
} {
  switch (availability) {
    case 'full':
      return { key: 'environment.full', values: { max: FLEET_ENVIRONMENT_LIMITS.botsMax } }
    case 'update-server':
      return { key: 'provisioning.updateServer' }
    case 'start-environment':
      return { key: 'environment.startToJoin' }
    case 'not-running':
      return { key: 'environment.waitToJoin' }
    case 'restart-environment':
      return { key: 'environment.restartToJoin' }
  }
}
export type EnvironmentScreenAvailability = 'ready' | 'restart-environment'
/**
 * Whether an environment's Maestrly has the screens of environments: its own screen with its settings window, and an
 * apps screen per bot. A running image from before them has one display, its bot's browser, where its settings open
 * too; it gets the others once restarted on the current image. A stopped environment shows no screen either way.
 */
export function environmentScreenAvailability(
  environment: Pick<FleetEnvironment, 'lifecycle' | 'capabilities'>
): EnvironmentScreenAvailability {
  return needsRestart(environment, FLEET_ENVIRONMENTS_FEATURE) ? 'restart-environment' : 'ready'
}
export type EnvironmentCompactionAvailability = 'unsupported' | 'stopped' | 'restart-environment' | 'ready'
/**
 * Whether the owner can choose an environment's default compaction model: the gateway must know defaults, and the
 * environment's running Maestrly must list its models (an older image needs the environment restarted first).
 */
export function environmentCompactionAvailability(
  fleet: FleetController,
  environment: Pick<FleetEnvironment, 'lifecycle' | 'capabilities'>
): EnvironmentCompactionAvailability {
  if (!fleet.state.connection.features.includes(FLEET_ENVIRONMENT_COMPACTION_FEATURE)) return 'unsupported'
  if (environment.lifecycle !== 'running') return 'stopped'
  return environment.capabilities.includes(FLEET_ENVIRONMENT_COMPACTION_FEATURE) ? 'ready' : 'restart-environment'
}
/** Where a bot's accounts, skills and MCP servers live: its environment on gateways with environments, else itself. */
export function provisioningTargetForBot(
  fleet: FleetController,
  bot: Pick<FleetBot, 'id' | 'environmentId'>
): FleetProvisioningTarget {
  return bot.environmentId && fleet.state.connection.features.includes(FLEET_ENVIRONMENTS_FEATURE)
    ? { environmentId: bot.environmentId }
    : { botId: bot.id }
}
export function accountHost(kind: string, baseURL: string | null) {
  try {
    return new URL(baseURL ?? (kind === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com')).host
  } catch {
    return ''
  }
}
export function useMacInventory(enabled = true) {
  const [inventory, setInventory] = useState<MacInventory | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!enabled) return
    let alive = true
    setInventory(null)
    setError('')
    void window.api
      .fleetProvisioningInventory()
      .then((value) => {
        if (alive) setInventory(value)
      })
      .catch((cause) => {
        if (alive) setError(fleetErrorMessage(cause))
      })
    return () => {
      alive = false
    }
  }, [enabled])
  return { inventory, error }
}
/** The accounts, skills and MCP servers of an environment (shared by its bots) or a bot; a bare string is a bot. */
export function useFleetProvisioning(target: FleetProvisioningTargetInput, enabled = true) {
  // Primitive dependencies: a target object rebuilt on every render must not refetch.
  const scope = typeof target === 'object' && 'environmentId' in target ? 'environment' : 'bot'
  const id = typeof target === 'string' ? target : 'environmentId' in target ? target.environmentId : target.botId
  const [value, setValue] = useState<{
    key: string
    accounts: FleetBotAccounts
    skills: FleetBotSkills['skills']
    mcpServers: FleetBotMcpServers['servers']
  } | null>(null)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision((current) => current + 1), [])
  useEffect(() => {
    if (!enabled) return
    let alive = true
    const request: FleetProvisioningTarget = scope === 'environment' ? { environmentId: id } : { botId: id }
    setError('')
    void Promise.all([
      window.api.fleetBotAccounts(request),
      window.api.fleetBotSkills(request),
      window.api.fleetBotMcpServers(request),
    ])
      .then(([accounts, skills, mcp]) => {
        if (alive) setValue({ key: fleetTargetKey(request), accounts, skills: skills.skills, mcpServers: mcp.servers })
      })
      .catch((cause) => {
        if (alive) setError(fleetErrorMessage(cause))
      })
    return () => {
      alive = false
    }
  }, [scope, id, enabled, revision])
  const current = value?.key === fleetTargetKey(target) && enabled ? value : null
  return { accounts: current?.accounts, skills: current?.skills, mcpServers: current?.mcpServers, error, refresh }
}
export function useBotProvisioning(botId: string, enabled = true) {
  return useFleetProvisioning(botId, enabled)
}
export type BotProvisioning = ReturnType<typeof useBotProvisioning>

type OwnedLogin = { attempt: { loginId: string; state: string } }
export function createLoginOwnership<T extends OwnedLogin = OwnedLogin>() {
  let entry: {
    key: string
    result: Promise<T>
    users: number
    abandoned: boolean
    attempt: OwnedLogin['attempt'] | null
    cancel: (id: string) => Promise<unknown>
  } | null = null
  const abandon = () => {
    const old = entry
    entry = null
    if (!old || old.abandoned) return
    old.abandoned = true
    void old.result
      .then(() => {
        if (old.attempt?.state === 'pending') return old.cancel(old.attempt.loginId)
      })
      .catch(() => {})
  }
  return {
    abandon,
    update(attempt: OwnedLogin['attempt']) {
      if (entry) entry.attempt = attempt
    },
    acquire(key: string, start: () => Promise<T>, cancel: (id: string) => Promise<unknown>) {
      if (entry?.key !== key) abandon()
      if (!entry) {
        const current = {
          key,
          result: start(),
          users: 0,
          abandoned: false,
          attempt: null as OwnedLogin['attempt'] | null,
          cancel,
        }
        current.result = current.result.then((value) => {
          current.attempt = value.attempt
          return value
        })
        entry = current
      }
      const current = entry
      current.users++
      let released = false
      return {
        result: current.result,
        release() {
          if (released) return
          released = true
          current.users--
          // Strict Mode restores the effect synchronously; a real unmount does not.
          queueMicrotask(() => {
            if (entry === current && current.users === 0) abandon()
          })
        },
      }
    },
  }
}

export function closeBotLogin(invalidate: () => void, cancel: () => Promise<unknown>, onClose: () => void): void {
  invalidate()
  onClose()
  void Promise.resolve()
    .then(cancel)
    .catch(() => {})
}

export async function settleMacImport<T>(
  send: () => Promise<T>,
  report: (value: T) => void,
  error: (message: string) => void,
  settled: () => void
): Promise<void> {
  try {
    report(await send())
  } catch (cause) {
    error(fleetErrorMessage(cause))
  } finally {
    settled()
  }
}

export function botProvisioningKey(bot: Pick<FleetBot, 'accounts' | 'status'>): string {
  return JSON.stringify([
    bot.accounts.connected,
    bot.accounts.providers.map((provider) => provider.id).sort(),
    bot.status,
  ])
}

/**
 * Refreshes an environment's shared lists when its Maestrly or the accounts its bots see change, never on resource
 * samples or on its bots' turns.
 */
export function environmentProvisioningKey(
  environment: Pick<FleetEnvironment, 'id' | 'lifecycle' | 'setup' | 'capabilities'>,
  bots: Pick<FleetBot, 'id' | 'environmentId' | 'accounts'>[]
): string {
  return JSON.stringify([
    environment.id,
    environment.lifecycle,
    environment.setup.step,
    [...environment.capabilities].sort(),
    bots
      .filter((bot) => bot.environmentId === environment.id)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((bot) => [bot.id, bot.accounts.connected, bot.accounts.providers.map((provider) => provider.id).sort()]),
  ])
}

export function provisioningErrorText(
  message: string | null,
  translate: (key: string) => string,
  errorCode?: string
): string {
  const code = errorCode ?? message?.match(/\[fleet:([a-z-]+)\]/)?.[1]
  if (macProvisioningErrorCodes.some((known) => known === code)) return translate('provisioning.error.' + code)
  return message ?? ''
}
