import type { IpcMainInvokeEvent } from 'electron'
import type { SubagentProfileModelMetaResult } from '../../shared/subagent-profile-effort'
import { validateSubagentProfileEffort, validateSubagentProfileFastMode } from '../../shared/subagent-profile-effort'
import type {
  ConversationSubagentProfileConfigPayload,
  SubagentProfileCandidate,
  SubagentProfileCatalog,
  SubagentProfileConfigPayload,
  SubagentProfileDiagnostic,
  SubagentProfileRulesV1,
  SubagentProfileSaveResult,
} from '../../shared/subagent-profiles'
import { isUnavailableClaudeFable } from '../../shared/subagent-profiles'
import { getConversation, listConversations, listWorkspaces } from '../store'
import { agentToDto, listAgents } from './agents'
import { listEffectiveAgents, mergeVirtualSubagents } from './virtual-subagents'
import { getProvider } from './catalog'
import {
  getConversationSubagentProfileRules,
  getGlobalSubagentProfileRules,
  setConversationSubagentProfileRules,
  setConversationSubagentProfilesEnabled,
  setConversationSubagentsEnabled,
  setGlobalSubagentProfileRules,
  validateSubagentProfileRules,
} from './subagent-profile-config'
import { getSubagentProfileModelMeta } from './subagent-profile-model-meta'
import { subagentModelCatalog, subagentProviderStatus } from './subagent-provider-runtime'

interface SubagentProfileIpcDeps {
  mhandle: (channel: string, fn: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) => void
}

function candidates(rules: SubagentProfileRulesV1 | null): SubagentProfileCandidate[] {
  if (!rules) return []
  return [
    ...(rules.default ?? []),
    ...Object.values(rules.byCategory ?? {}).flat(),
    ...Object.values(rules.byAgent ?? {}).flat(),
  ]
}

async function referentialDiagnostics(rules: SubagentProfileRulesV1 | null): Promise<SubagentProfileDiagnostic[]> {
  const diagnostics: SubagentProfileDiagnostic[] = []
  const seen = new Set<string>()
  for (const candidate of candidates(rules)) {
    const key = `${candidate.providerId}\0${candidate.modelId}\0${candidate.effort}\0${candidate.fastMode === true}`
    if (seen.has(key)) continue
    seen.add(key)
    const provider = getProvider(candidate.providerId)
    const status = provider ? await subagentProviderStatus(candidate.providerId) : 'missing'
    if (!provider) {
      diagnostics.push({
        code: 'provider-missing',
        severity: 'warning',
        message: `Provider “${candidate.providerId}” no longer exists.`,
      })
    } else if (status === 'unsupported') {
      diagnostics.push({
        code: 'provider-unsupported',
        severity: 'error',
        message: `Provider “${candidate.providerId}” cannot execute deterministic subagent profiles.`,
      })
      continue
    } else {
      if (status === 'disconnected') {
        diagnostics.push({
          code: 'provider-disconnected',
          severity: 'error',
          message: `Provider “${candidate.providerId}” is not authenticated. Sign in before using it for subagents.`,
        })
        continue
      }
      if (status === 'no-key') {
        diagnostics.push({
          code: 'no-key',
          severity: 'warning',
          message: `Provider “${candidate.providerId}” has no API key.`,
        })
      }
      const catalog = await subagentModelCatalog(candidate.providerId)
      const basename = candidate.modelId.split('/').pop()
      if (catalog.status === 'unavailable') {
        diagnostics.push({
          code: 'catalog-unavailable',
          severity: 'warning',
          message: `Model catalog for “${candidate.providerId}” is unavailable; “${candidate.modelId}” will still be attempted.`,
        })
      } else if (isUnavailableClaudeFable(candidate.providerId, candidate.modelId, catalog.models)) {
        diagnostics.push({
          code: 'model-unavailable',
          severity: 'error',
          message: 'Fable is not available in the model catalog for this Claude account.',
        })
        continue
      } else if (!catalog.models.includes(candidate.modelId) && (!basename || !catalog.models.includes(basename))) {
        diagnostics.push({
          code: 'model-not-found',
          severity: 'warning',
          message: `Model “${candidate.modelId}” is not listed and will be attempted as a manual ID.`,
        })
      }
    }
    const metadata = await getSubagentProfileModelMeta(candidate.providerId, candidate.modelId)
    if (candidate.effort !== 'off') {
      diagnostics.push(...validateSubagentProfileEffort(candidate, metadata).diagnostics)
    }
    diagnostics.push(...validateSubagentProfileFastMode(candidate, metadata).diagnostics)
  }
  return diagnostics
}

async function inspect<T extends SubagentProfileConfigPayload>(payload: T): Promise<T> {
  return { ...payload, diagnostics: [...payload.diagnostics, ...(await referentialDiagnostics(payload.rules))] }
}

async function validateBeforeSave(rules: unknown): Promise<SubagentProfileSaveResult | SubagentProfileConfigPayload> {
  const parsed = validateSubagentProfileRules(rules)
  if (!parsed.ok) return parsed
  const inspected = await inspect(parsed.value)
  const errors = inspected.diagnostics.filter((item) => item.severity === 'error')
  return errors.length ? { ok: false, errors } : inspected
}

async function catalogForConversation(conversationId?: string): Promise<SubagentProfileCatalog> {
  const byName = new Map<string, Awaited<ReturnType<typeof listAgents>>[number]>()
  if (conversationId) {
    // EFFECTIVE conversation catalog: physical cwd agents + virtual agents from conversation/global rules.
    // Agents exclusive to ANOTHER conversation never leak here (the layer reads only this conversation's rules).
    const cwd = getConversation(conversationId)?.cwd
    if (cwd) {
      for (const agent of await listEffectiveAgents({ cwd, conversationId })) {
        if (!byName.has(agent.name)) byName.set(agent.name, agent)
      }
    }
  } else {
    const cwds = new Set<string>()
    for (const workspace of listWorkspaces()) {
      for (const conversation of listConversations(workspace.id, true)) {
        if (conversation.cwd) cwds.add(conversation.cwd)
      }
    }
    if (cwds.size === 0) cwds.add(process.cwd())
    for (const cwd of cwds) {
      for (const agent of await listAgents(cwd)) if (!byName.has(agent.name)) byName.set(agent.name, agent)
    }
    // GLOBAL byAgent aliases enter the global catalog (without conversationId) through a merge without conversation rules.
    const merged = mergeVirtualSubagents({
      agents: [...byName.values()],
      globalRules: getGlobalSubagentProfileRules().rules,
    })
    byName.clear()
    for (const agent of merged) byName.set(agent.name, agent)
  }
  const agents = [...byName.values()].map(agentToDto).sort((a, b) => a.name.localeCompare(b.name))
  const categories = [...new Set(agents.flatMap((agent) => (agent.category ? [agent.category] : [])))].sort()
  return { agents, categories }
}

/** Domain IPC boundary; service.ts needs only one wiring line. */
export function registerSubagentProfileIpc(deps: SubagentProfileIpcDeps): void {
  deps.mhandle('chat:subagent-profiles:get-global', () => inspect(getGlobalSubagentProfileRules()))
  deps.mhandle('chat:subagent-profiles:set-global', async (_event, rules: unknown) => {
    const checked = await validateBeforeSave(rules)
    if ('ok' in checked) return checked
    const result = setGlobalSubagentProfileRules(checked.rules)
    return result.ok ? { ...result, value: checked } : result
  })
  deps.mhandle('chat:subagent-profiles:get-conversation', (_event, conversationId: string) =>
    typeof conversationId === 'string'
      ? inspect(getConversationSubagentProfileRules(conversationId))
      : Promise.resolve({
          rules: null,
          diagnostics: [],
          enabled: true,
          subagentsEnabled: true,
        } satisfies ConversationSubagentProfileConfigPayload)
  )
  deps.mhandle('chat:subagents:set-conversation-enabled', (_event, conversationId: string, enabled: boolean) => {
    if (typeof conversationId !== 'string' || typeof enabled !== 'boolean')
      return {
        ok: false,
        errors: [{ code: 'invalid-structure', severity: 'error', message: 'Invalid conversation subagent state.' }],
      }
    return setConversationSubagentsEnabled(conversationId, enabled)
  })
  deps.mhandle(
    'chat:subagent-profiles:set-conversation-enabled',
    async (_event, conversationId: string, enabled: boolean) => {
      if (typeof conversationId !== 'string' || typeof enabled !== 'boolean')
        return {
          ok: false,
          errors: [{ code: 'invalid-structure', severity: 'error', message: 'Invalid conversation profile state.' }],
        }
      const result = setConversationSubagentProfilesEnabled(conversationId, enabled)
      return result.ok ? { ...result, value: await inspect(result.value) } : result
    }
  )
  deps.mhandle(
    'chat:subagent-profiles:set-conversation',
    async (_event, conversationId: string, rules: unknown | null) => {
      if (typeof conversationId !== 'string')
        return {
          ok: false,
          errors: [{ code: 'invalid-structure', severity: 'error', message: 'Invalid conversation.' }],
        }
      if (rules == null) return setConversationSubagentProfileRules(conversationId, null)
      const checked = await validateBeforeSave(rules)
      if ('ok' in checked) return checked
      const result = setConversationSubagentProfileRules(conversationId, checked.rules)
      return result.ok ? { ...result, value: { ...checked, enabled: result.value.enabled } } : result
    }
  )
  deps.mhandle('chat:subagent-profiles:catalog', (_event, conversationId?: string) =>
    catalogForConversation(typeof conversationId === 'string' ? conversationId : undefined)
  )
  deps.mhandle('chat:subagent-profiles:model-catalog', (_event, providerId: string) =>
    typeof providerId === 'string' && providerId
      ? subagentModelCatalog(providerId)
      : Promise.resolve({ status: 'unavailable', models: [] } as const)
  )
  deps.mhandle(
    'chat:subagent-profiles:model-meta',
    (_event, providerId: string, modelId: string): Promise<SubagentProfileModelMetaResult> =>
      typeof providerId === 'string' && providerId && typeof modelId === 'string' && modelId
        ? getSubagentProfileModelMeta(providerId, modelId)
        : Promise.resolve({ status: 'unavailable', meta: null })
  )
}
