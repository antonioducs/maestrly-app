import { useCallback, useEffect, useState } from 'react'
import type { FleetBot, FleetBotAccounts, FleetBotSkills, FleetBotMcpServers } from '@maestrly/bot-fleet-protocol'
import type { MacInventory, MacImportSelection } from '../../../shared/fleet-provisioning'
import type { FleetController } from './use-fleet'
import { fleetErrorMessage } from './errors'

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
export function provisioningAvailability(
  fleet: FleetController,
  bot: FleetBot
): 'ready' | 'update-server' | 'restart-bot' {
  if (!fleet.state.connection.features.includes('provisioning')) return 'update-server'
  if (bot.lifecycle === 'running' && !bot.capabilities.includes('provisioning')) return 'restart-bot'
  return 'ready'
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
export function useBotProvisioning(botId: string, enabled = true) {
  const [value, setValue] = useState<{
    botId: string
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
    setError('')
    void Promise.all([
      window.api.fleetBotAccounts(botId),
      window.api.fleetBotSkills(botId),
      window.api.fleetBotMcpServers(botId),
    ])
      .then(([accounts, skills, mcp]) => {
        if (alive) setValue({ botId, accounts, skills: skills.skills, mcpServers: mcp.servers })
      })
      .catch((cause) => {
        if (alive) setError(fleetErrorMessage(cause))
      })
    return () => {
      alive = false
    }
  }, [botId, enabled, revision])
  const current = value?.botId === botId && enabled ? value : null
  return { accounts: current?.accounts, skills: current?.skills, mcpServers: current?.mcpServers, error, refresh }
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
