import { fleetApiKeyProviderKindSchema } from '@maestrly/bot-fleet-protocol'
import os from 'node:os'
import {
  fleetAccountImportRequestSchema,
  fleetImportResultsSchema,
  fleetMcpImportRequestSchema,
  fleetSkillInstallRequestSchema,
  fleetSkillInstallResponseSchema,
  type FleetAccountImportItem,
} from '@maestrly/bot-fleet-protocol'
import type { MacImportSelection, MacImportReport, MacImportItemResult } from '../../../../shared/fleet-provisioning'
import type { FleetClientService } from '../service'
import { listProviders, listAvailableChatProviders, getProviderKind } from '../../../chat/catalog'
import { getApiKey } from '../../../chat/credentials'
import { getGitHubCopilotSubscriptionManager } from '../../../chat/github-copilot'
import { getCursorSubscriptionManager } from '../../../chat/cursor-subscription'
import { listSkills } from '../../../chat/skills'
import { packageSkillDirectory } from '../../../chat/skill-package'
import { listMcpServers } from '../../../chat/mcp'
import { transformMcpServerForBot } from './mcp-transform'
import { skillsHome } from './inventory'

const missing = 'This account is no longer stored on this Mac.'
function item(id: string, name = id): MacImportItemResult {
  return { id, name, outcome: 'failed', error: null }
}
export async function importFromMac(
  fleet: FleetClientService,
  botId: string,
  selection: MacImportSelection
): Promise<MacImportReport> {
  const report: MacImportReport = { accounts: [], skills: [], mcpServers: [] }
  const params = { id: botId }
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
      continue
    }
    secrets.push(key)
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
  }
  // Remote diagnostics are untrusted and may echo credentials from the request.
  const safeError = (error: unknown): string => {
    let message = error instanceof Error ? error.message : String(error)
    for (const secret of secrets) if (secret) message = message.split(secret).join('[redacted]')
    return message.slice(0, 300)
  }
  const apply = (response: unknown, targets: MacImportItemResult[]): void => {
    const parsed = fleetImportResultsSchema.parse(response)
    for (const [index, target] of targets.entries()) {
      const remote = parsed.results.find((result) => result.index === index)
      target.outcome = remote?.outcome ?? 'failed'
      target.error = remote?.error
        ? safeError(remote.error)
        : remote
          ? null
          : 'The bot did not return an import result.'
    }
  }
  if (items.length) {
    try {
      apply(
        await fleet.call('botAccountsImport', { params, body: fleetAccountImportRequestSchema.parse({ items }) }),
        sent
      )
    } catch (error) {
      for (const result of sent) result.error = safeError(error)
    }
  }
  const skills = await listSkills('', skillsHome())
  for (const name of selection.skillNames) {
    const result = item(name)
    report.skills.push(result)
    try {
      const skill = skills.find((candidate) => candidate.name === name)
      if (!skill) throw new Error('This skill is no longer stored on this Mac.')
      const files = await packageSkillDirectory(skill.dir)
      const body = fleetSkillInstallRequestSchema.parse({
        name,
        files: files.map((file) => ({
          path: file.path,
          data: file.data.toString('base64'),
          executable: file.executable,
        })),
      })
      const response = fleetSkillInstallResponseSchema.parse(await fleet.call('botSkillInstall', { params, body }))
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
      result.error = 'This MCP server is unavailable on this Mac.'
      continue
    }
    secrets.push(...Object.values(payload.env ?? {}), ...Object.values(payload.headers ?? {}))
    if (payload.url) secrets.push(payload.url)
    payloads.push(payload)
    mcpSent.push(result)
  }
  if (payloads.length) {
    try {
      apply(
        await fleet.call('botMcpServersImport', {
          params,
          body: fleetMcpImportRequestSchema.parse({ servers: payloads }),
        }),
        mcpSent
      )
    } catch (error) {
      for (const result of mcpSent) result.error = safeError(error)
    }
  }
  return report
}
