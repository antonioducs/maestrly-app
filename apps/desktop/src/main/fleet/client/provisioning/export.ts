import { fleetApiKeyProviderKindSchema } from '@maestrly/bot-fleet-protocol'
import os from 'node:os'
import {
  FLEET_PROVISIONING_LIMITS,
  fleetAccountImportRequestSchema,
  fleetImportResultsSchema,
  fleetMcpImportRequestSchema,
  fleetSkillInstallRequestSchema,
  fleetSkillInstallResponseSchema,
  type FleetAccountImportItem,
} from '@maestrly/bot-fleet-protocol'
import type { MacImportSelection, MacImportReport, MacImportItemResult } from '../../../../shared/fleet-provisioning'
import type { FleetProvisioningTargetInput } from '../../../../shared/fleet-targets'
import type { FleetClientService } from '../service'
import { provisioningRoute, resolveProvisioningTarget } from '../targets'
import { listProviders, listAvailableChatProviders, getProviderKind } from '../../../chat/catalog'
import { getApiKey } from '../../../chat/credentials'
import { getGitHubCopilotSubscriptionManager } from '../../../chat/github-copilot'
import { getCursorSubscriptionManager } from '../../../chat/cursor-subscription'
import { listSkills } from '../../../chat/skills'
import { packageSkillDirectory } from '../../../chat/skill-package'
import { listMcpServers } from '../../../chat/mcp'
import { transformMcpServerForBot } from './mcp-transform'
import { skillsHome } from './inventory'

const missing = 'This account is no longer stored on this computer.'
function item(id: string, name = id): MacImportItemResult {
  return { id, name, outcome: 'failed', error: null }
}
/** Sends what the owner picked on this Mac to an environment (shared by its bots) or a bot; a bare string is a bot. */
export async function importFromMac(
  fleet: FleetClientService,
  rawTarget: FleetProvisioningTargetInput,
  selection: MacImportSelection
): Promise<MacImportReport> {
  const target = resolveProvisioningTarget(fleet, rawTarget)
  const report: MacImportReport = { accounts: [], skills: [], mcpServers: [] }
  const accountsImport = provisioningRoute(target, 'accountsImport')
  const skillInstall = provisioningRoute(target, 'skillInstall')
  const mcpServersImport = provisioningRoute(target, 'mcpServersImport')
  const items: FleetAccountImportItem[] = []
  const sent: MacImportItemResult[] = []
  const secrets: string[] = []
  const providers = listProviders()
  const available = listAvailableChatProviders()
  for (const id of selection.apiKeyIds) {
    const provider = providers.find((p) => p.id === id)
    const result = item(id, provider?.name)
    report.accounts.push(result)
    const key = provider && getApiKey(id)
    if (!provider || !key) {
      result.error = missing
      result.errorCode = 'account-missing'
      continue
    }
    secrets.push(key)
    if (provider.baseURL) secrets.push(provider.baseURL)
    items.push({
      type: 'api-key',
      kind: fleetApiKeyProviderKindSchema.parse(getProviderKind(provider)),
      name: provider.name,
      baseURL: provider.baseURL,
      key,
    })
    sent.push(result)
  }
  for (const id of selection.copyIds) {
    const provider = available.find(
      (p) => p.builtin?.replace('-subscription', '') + ':' + (p.accountId ?? 'default') === id
    )
    const result = item(id, provider?.accountLabel ?? provider?.name)
    report.accounts.push(result)
    if (provider?.builtin === 'github-copilot-subscription') {
      const token = getGitHubCopilotSubscriptionManager(provider.accountId ?? null).exportToken()
      if (token) {
        secrets.push(token)
        items.push({ type: 'github-copilot', label: result.name, token })
        sent.push(result)
        continue
      }
    } else if (provider?.builtin === 'cursor-subscription') {
      const credential = getCursorSubscriptionManager(provider.accountId ?? null).exportCredential()
      if (credential) {
        secrets.push(credential.apiKey)
        items.push({
          type: 'cursor',
          label: result.name,
          apiKey: credential.apiKey,
          expiresAt: credential.expiresAtMs === null ? null : new Date(credential.expiresAtMs).toISOString(),
        })
        sent.push(result)
        continue
      }
    }
    result.error = missing
    result.errorCode = 'account-missing'
  }
  // Remote diagnostics are untrusted and may echo credentials from the request.
  const safeError = (error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error)
    for (const secret of secrets) {
      if (!secret) continue
      if (message.includes(secret)) return 'The bot import failed. Please try again.'
      for (let index = 0; index <= message.length - 8; index++) {
        if (secret.includes(message.slice(index, index + 8))) return 'The bot import failed. Please try again.'
      }
    }
    return message.slice(0, 300)
  }
  const apply = (response: unknown, targets: MacImportItemResult[]): void => {
    const parsed = fleetImportResultsSchema.parse(response)
    for (const [index, target] of targets.entries()) {
      const remote = parsed.results.find((result) => result.index === index)
      target.outcome = remote?.outcome ?? 'failed'
      if (!remote) target.errorCode = 'missing-result'
      target.error = remote?.error
        ? safeError(remote.error)
        : remote
          ? null
          : 'The bot did not return an import result.'
    }
  }
  for (let offset = 0; offset < items.length; offset += FLEET_PROVISIONING_LIMITS.importItemsMax) {
    const batch = items.slice(offset, offset + FLEET_PROVISIONING_LIMITS.importItemsMax)
    const targets = sent.slice(offset, offset + FLEET_PROVISIONING_LIMITS.importItemsMax)
    try {
      apply(
        await fleet.call(accountsImport.key, {
          params: accountsImport.params,
          body: fleetAccountImportRequestSchema.parse({ items: batch }),
        }),
        targets
      )
    } catch (error) {
      for (const result of targets) result.error = safeError(error)
    }
  }
  const skills = await listSkills('', skillsHome())
  for (const name of selection.skillNames) {
    const result = item(name)
    report.skills.push(result)
    try {
      const skill = skills.find((candidate) => candidate.name === name)
      if (!skill) {
        result.errorCode = 'skill-missing'
        throw new Error('This skill is no longer stored on this computer.')
      }
      const files = await packageSkillDirectory(skill.dir).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : ''
        result.errorCode =
          (['too-large', 'file-too-large', 'path-too-long', 'too-many-files', 'no-skill-md'] as const).find(
            (code) => code === message
          ) ?? 'unreadable'
        throw error
      })
      const body = fleetSkillInstallRequestSchema.parse({
        name,
        files: files.map((file) => ({
          path: file.path,
          data: file.data.toString('base64'),
          executable: file.executable,
        })),
      })
      const response = fleetSkillInstallResponseSchema.parse(
        await fleet.call(skillInstall.key, { params: skillInstall.params, body })
      )
      result.outcome = response.outcome
    } catch (error) {
      result.error = safeError(error)
    }
  }
  const servers = listMcpServers()
  const payloads = []
  const mcpSent: MacImportItemResult[] = []
  for (const id of selection.mcpServerIds) {
    const server = servers.find((candidate) => candidate.id === id)
    const result = item(id, server?.name)
    report.mcpServers.push(result)
    const payload = server && transformMcpServerForBot(server, os.homedir()).payload
    if (!payload) {
      result.error = 'This MCP server is unavailable on this computer.'
      result.errorCode = 'mcp-unavailable'
      continue
    }
    secrets.push(...Object.values(payload.env ?? {}), ...Object.values(payload.headers ?? {}), ...(payload.args ?? []))
    if (payload.url) secrets.push(payload.url)
    payloads.push(payload)
    mcpSent.push(result)
  }
  for (let offset = 0; offset < payloads.length; offset += FLEET_PROVISIONING_LIMITS.importItemsMax) {
    const batch = payloads.slice(offset, offset + FLEET_PROVISIONING_LIMITS.importItemsMax)
    const targets = mcpSent.slice(offset, offset + FLEET_PROVISIONING_LIMITS.importItemsMax)
    try {
      apply(
        await fleet.call(mcpServersImport.key, {
          params: mcpServersImport.params,
          body: fleetMcpImportRequestSchema.parse({ servers: batch }),
        }),
        targets
      )
    } catch (error) {
      for (const result of targets) result.error = safeError(error)
    }
  }
  for (const result of [...report.accounts, ...report.skills, ...report.mcpServers]) {
    if (result.error === 'The bot import failed. Please try again.') result.errorCode = 'import-failed'
  }
  return report
}
