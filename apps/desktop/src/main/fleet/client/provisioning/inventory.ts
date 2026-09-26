import { fleetApiKeyProviderKindSchema } from '@maestrly/bot-fleet-protocol'
import os from 'node:os'
import type { MacInventory } from '../../../../shared/fleet-provisioning'
import { listProviders, listAvailableChatProviders, getProviderKind } from '../../../chat/catalog'
import { getApiKey } from '../../../chat/credentials'
import { getGitHubCopilotSubscriptionManager } from '../../../chat/github-copilot'
import { getCursorSubscriptionManager } from '../../../chat/cursor-subscription'
import { getCodexSubscriptionManager } from '../../../chat/codex-subscription'
import { getClaudeSubscriptionManager } from '../../../chat/claude-agent-sdk'
import { getGrokSubscriptionManager } from '../../../chat/grok-subscription'
import { listSkills } from '../../../chat/skills'
import { measureSkillDirectory } from '../../../chat/skill-package'
import { listMcpServers } from '../../../chat/mcp'
import { isE2E } from '../../../test-mode'
import { localHost, transformMcpServerForBot } from './mcp-transform'

export function skillsHome(): string {
  return (isE2E() && process.env.AGENTS_E2E_SKILLS_HOME) || os.homedir()
}
export async function buildMacInventory(): Promise<MacInventory> {
  const result: MacInventory = { apiKeys: [], copies: [], logins: [], skills: [], mcpServers: [] }
  for (const provider of listProviders()) {
    if (!getApiKey(provider.id)) continue
    const url = new URL(provider.baseURL)
    result.apiKeys.push({
      id: provider.id,
      name: provider.name,
      kind: fleetApiKeyProviderKindSchema.parse(getProviderKind(provider)),
      host: url.host,
      localOnly: localHost(url.hostname),
    })
  }
  for (const provider of listAvailableChatProviders()) {
    const slot = provider.accountId ?? null
    const label = provider.accountLabel ?? provider.name
    const kind = provider.builtin?.replace('-subscription', '')
    const id = kind + ':' + (slot ?? 'default')
    if (kind === 'github-copilot') {
      if (getGitHubCopilotSubscriptionManager(slot).exportToken())
        result.copies.push({ id, kind, label, expiresAt: null })
    } else if (kind === 'cursor') {
      const credential = getCursorSubscriptionManager(slot).exportCredential()
      if (credential)
        result.copies.push({
          id,
          kind,
          label,
          expiresAt: credential.expiresAtMs === null ? null : new Date(credential.expiresAtMs).toISOString(),
        })
    } else if (kind === 'codex') {
      const status = getCodexSubscriptionManager(slot).peekStatus()
      if (status?.authenticated)
        result.logins.push({ id, kind, label, email: status.account?.type === 'chatgpt' ? status.account.email : null })
    } else if (kind === 'claude') {
      const status = getClaudeSubscriptionManager(slot).peekStatus()
      if (status?.authenticated && status.state !== 'signing-in')
        result.logins.push({ id, kind, label, email: status.account?.email ?? null })
    } else if (kind === 'grok') {
      const status = getGrokSubscriptionManager(slot).getStatusSnapshot()
      if (status?.authenticated) result.logins.push({ id, kind, label, email: status.account?.email ?? null })
    }
  }
  for (const skill of await listSkills('', skillsHome())) {
    result.skills.push({
      name: skill.name,
      description: skill.description,
      ...(await measureSkillDirectory(skill.dir).catch(() => ({
        files: 0,
        bytes: 0,
        scripts: false,
        problem: 'unreadable' as const,
      }))),
    })
  }
  result.mcpServers = listMcpServers().map((server) => {
    const { target, warnings, recommended } = transformMcpServerForBot(server, os.homedir())
    return { id: server.id, name: server.name, transport: server.transport, target, warnings, recommended }
  })
  return result
}
