import {
  MAESTRO_CONFIG_VERSION,
  cloneMaestroConfig,
  createDefaultMaestroConfig,
  type MaestroConfigDiagnostic,
  type MaestroConfigPayload,
  type MaestroTurnSnapshotV1,
} from '../../shared/maestro'
import { validateMaestroConfig, type MaestroConfigSaveResult } from '../../shared/maestro-config-validation'
import { getAppSetting, getConversation, getConvUiPrefs, patchConvUiPrefs, setAppSetting } from '../store'

export { validateMaestroConfig, type MaestroConfigSaveResult }

export const MAESTRO_CONFIG_SETTING_KEY = 'chat.maestro.v1'

const diagnostic = (message: string, resourceId?: string): MaestroConfigDiagnostic => ({
  code: 'invalid-structure',
  message,
  severity: 'error',
  ...(resourceId ? { resourceId } : {}),
})

function corruptPayload(message: string): MaestroConfigPayload {
  return {
    config: createDefaultMaestroConfig(),
    source: 'safe-default',
    diagnostics: [{ code: 'config-corrupt', message, severity: 'warning' }],
    hasConversationOverride: false,
  }
}

export function getGlobalMaestroConfig(): MaestroConfigPayload {
  const raw = getAppSetting(MAESTRO_CONFIG_SETTING_KEY)
  if (!raw) {
    return {
      config: createDefaultMaestroConfig(),
      source: 'safe-default',
      diagnostics: [],
      hasConversationOverride: false,
    }
  }
  try {
    const parsed = validateMaestroConfig(JSON.parse(raw))
    return parsed.ok ? parsed.value : corruptPayload(parsed.errors.map((item) => item.message).join(' '))
  } catch {
    return corruptPayload('Global Maestro configuration is corrupt and was replaced with the safe default.')
  }
}

export function setGlobalMaestroConfig(value: unknown): MaestroConfigSaveResult {
  const parsed = validateMaestroConfig(value)
  if (!parsed.ok) return parsed
  setAppSetting(MAESTRO_CONFIG_SETTING_KEY, JSON.stringify(parsed.value.config))
  return { ok: true, value: getGlobalMaestroConfig() }
}

export function getConversationMaestroConfig(conversationId: string): MaestroConfigPayload {
  const prefs = getConvUiPrefs(conversationId)
  const override = prefs.maestro?.config
  if (override === undefined) return getGlobalMaestroConfig()
  const parsed = validateMaestroConfig(override)
  if (!parsed.ok) {
    const global = getGlobalMaestroConfig()
    return {
      ...global,
      diagnostics: [
        ...global.diagnostics,
        {
          code: 'config-corrupt',
          message: `Conversation Maestro override is corrupt and was ignored. ${parsed.errors.map((item) => item.message).join(' ')}`,
          severity: 'warning',
        },
      ],
      hasConversationOverride: true,
    }
  }
  return {
    ...parsed.value,
    source: prefs.maestro?.projectScoped === true ? 'project' : 'conversation',
    hasConversationOverride: true,
  }
}

export function setConversationMaestroConfig(conversationId: string, value: unknown | null): MaestroConfigSaveResult {
  const conversation = getConversation(conversationId)
  if (conversation?.experience !== 'maestro') {
    return { ok: false, errors: [diagnostic('Maestro overrides require a Maestro conversation.')] }
  }
  const prefs = getConvUiPrefs(conversationId)
  if (value == null) {
    const next = { ...(prefs.maestro ?? {}) }
    delete next.config
    delete next.projectScoped
    patchConvUiPrefs(conversationId, { maestro: next })
    return { ok: true, value: getConversationMaestroConfig(conversationId) }
  }
  const parsed = validateMaestroConfig(value)
  if (!parsed.ok) return parsed
  patchConvUiPrefs(conversationId, {
    maestro: { ...(prefs.maestro ?? {}), config: parsed.value.config, projectScoped: false },
  })
  return { ok: true, value: getConversationMaestroConfig(conversationId) }
}

/** Host-only save path for cloud jobs. The marker makes physical agent resolution portable without changing V1. */
export function setProjectConversationMaestroConfig(conversationId: string, value: unknown): MaestroConfigSaveResult {
  const conversation = getConversation(conversationId)
  if (conversation?.experience !== 'maestro') {
    return { ok: false, errors: [diagnostic('Shared Maestro configuration requires a Maestro conversation.')] }
  }
  const parsed = validateMaestroConfig(value)
  if (!parsed.ok) return parsed
  const prefs = getConvUiPrefs(conversationId)
  patchConvUiPrefs(conversationId, {
    maestro: { ...(prefs.maestro ?? {}), config: parsed.value.config, projectScoped: true },
  })
  return { ok: true, value: getConversationMaestroConfig(conversationId) }
}

export function freezeMaestroTurn(conversationId: string, frozenAt = Date.now()): MaestroTurnSnapshotV1 {
  const payload = getConversationMaestroConfig(conversationId)
  const config = cloneMaestroConfig(payload.config)
  return {
    version: MAESTRO_CONFIG_VERSION,
    strategy: config.strategy,
    pool: config.pool,
    source: payload.source,
    diagnostics: payload.diagnostics.map((item) => ({ ...item })),
    frozenAt,
  }
}
