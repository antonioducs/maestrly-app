/**
 * Cursor model catalog helpers for the native subscription adapter.
 * Never invents Fast/Standard params — catalog from Cursor.models.list() is source of truth.
 */
import type { ModelParameterDefinition, ModelParameterValue, ModelSelection, ModelVariant } from '@cursor/sdk'

/** Cursor product limits; other models use the models.dev catalog window. */
export function cursorProviderContextWindow(modelId: string): number | undefined {
  const id = modelId.trim().toLowerCase()
  if (/^grok(?:-|$)/.test(id)) return 256_000
  if (/^composer(?:-|$)/.test(id)) return 200_000
  return undefined
}

export interface CursorPublishedUsagePricing {
  inputPer1M: number
  outputPer1M: number
}

/** The subscription charge depends on the account; only SDK-reported costs are used. */
export function cursorPublishedUsagePricing(
  _modelId: string,
  _fastMode: boolean | undefined
): CursorPublishedUsagePricing | null {
  return null
}

/** Unknown billing remains unknown instead of estimating from unrelated API tariffs. */
export function estimateCursorPublishedCostUsd(
  _modelId: string,
  _fastMode: boolean | undefined,
  _usage: { input: number; output: number; cachedInput?: number; cacheCreate?: number }
): number | null {
  return null
}

/**
 * Catalog entry shape returned by the SDK. `displayName` is required on the live
 * SDK `ModelListItem`, but we keep it optional here so offline fixtures and
 * partial normalizations stay type-safe without inventing labels.
 */
export interface CursorModelCatalogEntry {
  id: string
  displayName?: string
  description?: string
  aliases?: string[]
  parameters?: ModelParameterDefinition[]
  variants?: ModelVariant[]
}

export interface CursorModelListResult {
  models: CursorModelCatalogEntry[]
}

/** Normalize SDK list payloads (array or { models }). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function normalizeCursorModelList(raw: unknown): CursorModelCatalogEntry[] {
  const entries = Array.isArray(raw) ? raw : isRecord(raw) ? array(raw.models) : []
  const result = new Map<string, CursorModelCatalogEntry>()
  for (const entry of entries) {
    if (!isRecord(entry) || !stringValue(entry.id)) continue
    const model: CursorModelCatalogEntry = { id: entry.id.trim() }
    if (stringValue(entry.displayName)) model.displayName = entry.displayName
    if (stringValue(entry.description)) model.description = entry.description
    if (Array.isArray(entry.aliases)) model.aliases = entry.aliases.filter(stringValue)
    if (Array.isArray(entry.parameters)) {
      model.parameters = entry.parameters.flatMap((parameter) => {
        if (!isRecord(parameter) || !stringValue(parameter.id)) return []
        return [
          {
            id: parameter.id,
            ...(stringValue(parameter.displayName) ? { displayName: parameter.displayName } : {}),
            values: array(parameter.values).flatMap((value) => {
              if (!isRecord(value) || !stringValue(value.value)) return []
              return [
                { value: value.value, ...(stringValue(value.displayName) ? { displayName: value.displayName } : {}) },
              ]
            }),
          },
        ]
      })
    }
    if (Array.isArray(entry.variants)) {
      model.variants = entry.variants.flatMap((variant) => {
        if (!isRecord(variant) || !Array.isArray(variant.params)) return []
        if (!variant.params.every((param) => isRecord(param) && stringValue(param.id) && stringValue(param.value)))
          return []
        return [
          {
            displayName: typeof variant.displayName === 'string' ? variant.displayName : '',
            params: variant.params.map((param) => ({ id: param.id as string, value: param.value as string })),
            ...(variant.isDefault === true ? { isDefault: true } : {}),
          },
        ]
      })
    }
    if (!result.has(model.id)) result.set(model.id, model)
  }
  return [...result.values()]
}

/** Build ModelSelection without inventing params. Passes params through only when provided. */
export function toCursorModelSelection(model: {
  id: string
  params?: ReadonlyArray<{ id: string; value: string }>
}): ModelSelection {
  const id = model.id.trim()
  if (!id) {
    throw new Error('model.id is required')
  }
  if (!model.params || model.params.length === 0) {
    return { id }
  }
  const params: ModelParameterValue[] = model.params.map((p) => ({
    id: String(p.id),
    value: String(p.value),
  }))
  return { id, params }
}

/**
 * Detect a Fast/speed-style parameter from catalog metadata.
 * Matching is conservative: id/displayName contains "fast" or values look like fast|standard|off|on|true|false.
 */
export function findCursorFastParameter(model: CursorModelCatalogEntry): ModelParameterDefinition | undefined {
  const parameters = cursorModelParameters(model)
  for (const param of parameters) {
    const id = param.id?.toLowerCase?.() ?? ''
    const display = param.displayName?.toLowerCase?.() ?? ''
    if (id.includes('fast') || display.includes('fast') || id.includes('speed') || display.includes('speed')) {
      return param
    }
    const values = (param.values ?? []).map((v) => String(v.value).toLowerCase())
    if (values.some((v) => v === 'fast' || v === 'standard' || v === 'priority')) {
      return param
    }
  }
  // Variants may encode Standard vs Fast without a free-form param list.
  return undefined
}

const CURSOR_EFFORT_VALUES = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

/**
 * Effective parameter definitions. Some Cursor catalogs publish only `variants`, so fold their parameter
 * values into synthetic definitions without inventing either an id or a value.
 */
export function cursorModelParameters(model: CursorModelCatalogEntry): ModelParameterDefinition[] {
  const byId = new Map<string, ModelParameterDefinition>()
  for (const parameter of model.parameters ?? []) {
    if (!parameter.id) continue
    byId.set(parameter.id, {
      ...parameter,
      values: [...(parameter.values ?? [])],
    })
  }
  for (const variant of model.variants ?? []) {
    for (const value of variant.params ?? []) {
      if (!value.id) continue
      const existing = byId.get(value.id) ?? { id: value.id, values: [] }
      if (!existing.values.some((candidate) => String(candidate.value) === String(value.value))) {
        existing.values.push({ value: String(value.value) })
      }
      byId.set(value.id, existing)
    }
  }
  return [...byId.values()]
}

/** Detects the model-native effort/reasoning axis exposed by the Cursor catalog. */
export function findCursorReasoningParameter(model: CursorModelCatalogEntry): ModelParameterDefinition | undefined {
  const parameters = cursorModelParameters(model)
  const semantic = parameters.find((parameter) => {
    const id = parameter.id.toLowerCase()
    const display = parameter.displayName?.toLowerCase() ?? ''
    return /effort|reason|thinking/.test(id) || /effort|reason|thinking/.test(display)
  })
  if (semantic) return semantic

  // Defensive fallback for catalogs with an opaque parameter id: require at least two values and accept only
  // the known effort vocabulary. This cannot mistake the boolean Fast axis for reasoning.
  return parameters.find((parameter) => {
    const values = parameter.values.map((entry) => String(entry.value).trim().toLowerCase()).filter(Boolean)
    return values.length >= 2 && values.every((value) => CURSOR_EFFORT_VALUES.has(value))
  })
}

/** Values shown in the shared reasoning picker, preserving the catalog order and wire spelling. */
export function cursorReasoningEfforts(model: CursorModelCatalogEntry): string[] {
  const parameter = findCursorReasoningParameter(model)
  if (!parameter) return []
  return [...new Set(parameter.values.map((entry) => String(entry.value).trim()).filter(Boolean))]
}

function pickCursorReasoningEffortValue(parameter: ModelParameterDefinition, requested: string): string | undefined {
  const wanted = requested.trim().toLowerCase()
  if (!wanted || wanted === 'off') return undefined
  const hit = parameter.values.find((entry) => String(entry.value).trim().toLowerCase() === wanted)
  return hit ? String(hit.value) : undefined
}

/**
 * Prefer an unambiguous non-Fast / Standard value from the catalog.
 * Only accepts semantic values proven/safe: `false`, `off`, `standard`.
 * Does **not** treat `default`, `normal`, `slow`, or `0` as Fast-off.
 */
export function pickStandardFastOffValue(param: ModelParameterDefinition): string | undefined {
  const values = param.values ?? []
  const ranked = ['false', 'off', 'standard'] as const
  for (const want of ranked) {
    const hit = values.find((v) => String(v.value).toLowerCase() === want)
    if (hit) return String(hit.value)
  }
  return undefined
}

/**
 * Prefer an unambiguous Fast-on value from the catalog: `true`, `on`, `fast`.
 * Fast is only sent when the catalog proves an explicit value — never invented.
 */
export function pickFastOnValue(param: ModelParameterDefinition): string | undefined {
  const values = param.values ?? []
  const ranked = ['true', 'on', 'fast'] as const
  for (const want of ranked) {
    const hit = values.find((v) => String(v.value).toLowerCase() === want)
    if (hit) return String(hit.value)
  }
  return undefined
}

export interface CursorModelAxisResolution {
  selection: ModelSelection
  note: string
  canonicalParams: ReadonlyArray<{ id: string; value: string }>
}

export type CursorModelAxisResult = { ok: true; resolution: CursorModelAxisResolution } | { ok: false; error: string }

/**
 * Product-facing resolution: catalog is the single source of truth.
 * - `fastMode` undefined/auto → `{ id }` only (backend default applies).
 * - `fastMode` true  → explicit Fast-on value; fail closed if absent.
 * - `fastMode` false → explicit Standard/Fast-off value; fail closed if absent.
 * Returns canonical params so the session binding can compare effective model selection.
 */
export function resolveCursorModelAxes(
  models: readonly CursorModelCatalogEntry[],
  options: { modelId: string; fastMode?: boolean; reasoningEffort?: string | null }
): CursorModelAxisResult {
  const modelId = options.modelId?.trim()
  if (!modelId) return { ok: false, error: 'modelId is required' }
  const entry = findCursorModel(models, modelId)
  if (!entry) {
    return { ok: false, error: `Model "${modelId}" not found in the account catalog (${models.length} models).` }
  }
  const params: Array<{ id: string; value: string }> = []
  const notes: string[] = []

  if (options.fastMode !== undefined) {
    const fastParam = findCursorFastParameter(entry)
    if (!fastParam) {
      if (options.fastMode === true) {
        return {
          ok: false,
          error: `Model "${entry.id}" has no Fast/speed parameter in the catalog; cannot request Fast.`,
        }
      }
      notes.push(`Model "${entry.id}" has no Fast/speed axis; Standard is the only variant.`)
    } else {
      const wanted = options.fastMode === true ? pickFastOnValue(fastParam) : pickStandardFastOffValue(fastParam)
      if (wanted == null) {
        return {
          ok: false,
          error:
            `Model "${entry.id}" has parameter "${fastParam.id}" but no unambiguous ` +
            `${options.fastMode ? 'Fast-on' : 'Standard/off'} value (values: ` +
            `${(fastParam.values ?? []).map((v) => v.value).join(', ') || 'none'}). Refusing to guess.`,
        }
      }
      params.push({ id: fastParam.id, value: wanted })
      notes.push(`${options.fastMode ? 'Fast' : 'Standard'} explicit: ${fastParam.id}=${wanted}.`)
    }
  }

  const requestedEffort = options.reasoningEffort?.trim()
  if (requestedEffort && requestedEffort !== 'off') {
    const effortParam = findCursorReasoningParameter(entry)
    if (!effortParam) {
      return {
        ok: false,
        error: `Model "${entry.id}" has no reasoning/effort parameter in the catalog; cannot request "${requestedEffort}".`,
      }
    }
    const wanted = pickCursorReasoningEffortValue(effortParam, requestedEffort)
    if (wanted == null) {
      return {
        ok: false,
        error:
          `Model "${entry.id}" does not advertise reasoning effort "${requestedEffort}" ` +
          `(values: ${effortParam.values.map((value) => value.value).join(', ') || 'none'}).`,
      }
    }
    if (params.some((parameter) => parameter.id === effortParam.id)) {
      return {
        ok: false,
        error:
          `Model "${entry.id}" exposes Fast and reasoning through the same parameter ` +
          `"${effortParam.id}"; the requested axes cannot be combined safely.`,
      }
    }
    params.push({ id: effortParam.id, value: wanted })
    notes.push(`Reasoning explicit: ${effortParam.id}=${wanted}.`)
  }

  // Variant-only metadata proves listed combinations, not the Cartesian product.
  const variantOnly = params.filter((param) => !entry.parameters?.some((definition) => definition.id === param.id))
  if (
    variantOnly.length > 0 &&
    !entry.variants?.some((variant) =>
      params.every((param) => variant.params.some((value) => value.id === param.id && value.value === param.value))
    )
  ) {
    return { ok: false, error: `Model "${entry.id}" does not advertise the requested parameter combination.` }
  }

  // Stable snapshots/bindings regardless of the order used by the upstream catalog.
  params.sort((left, right) => left.id.localeCompare(right.id) || left.value.localeCompare(right.value))
  return {
    ok: true,
    resolution: {
      selection: { id: entry.id, ...(params.length ? { params } : {}) },
      note: notes.length ? notes.join(' ') : `Model "${entry.id}" has no explicit axes requested; sending id only.`,
      canonicalParams: params,
    },
  }
}

export type CursorStandardSelectionResult =
  | { ok: true; selection: ModelSelection; note: string }
  | { ok: false; error: string; selection?: ModelSelection }

/**
 * Resolve an explicit Standard (non-Fast) selection from catalog entry.
 * - If no fast-like param: returns `{ id }` only (cannot force Standard; note says so).
 * - If fast-like param exists and has an off/standard value: sets it explicitly.
 * - If fast-like param exists but no safe off value: fails (do not guess).
 * Never injects `fast=true`.
 */
export function resolveCursorStandardSelection(
  model: CursorModelCatalogEntry,
  options?: { requireFastControl?: boolean }
): CursorStandardSelectionResult {
  const requireFastControl = options?.requireFastControl === true
  const fastParam = findCursorFastParameter(model)

  if (!fastParam) {
    if (requireFastControl) {
      return {
        ok: false,
        error: `Model "${model.id}" has no catalog parameter to disable Fast; refuse to guess.`,
        selection: { id: model.id },
      }
    }
    return {
      ok: true,
      selection: { id: model.id },
      note: `Model "${model.id}" exposes no Fast/speed parameter; sending id only (backend default applies).`,
    }
  }

  const offValue = pickStandardFastOffValue(fastParam)
  if (offValue == null) {
    return {
      ok: false,
      error:
        `Model "${model.id}" has parameter "${fastParam.id}" but no known Standard/off value ` +
        `(values: ${(fastParam.values ?? []).map((v) => v.value).join(', ') || 'none'}). Refusing to guess.`,
      selection: { id: model.id },
    }
  }

  return {
    ok: true,
    selection: { id: model.id, params: [{ id: fastParam.id, value: offValue }] },
    note: `Explicit Standard path: ${fastParam.id}=${offValue} (Fast disabled via catalog value).`,
  }
}

/** Find model by id or alias (case-insensitive). */
export function findCursorModel(
  models: readonly CursorModelCatalogEntry[],
  modelId: string
): CursorModelCatalogEntry | undefined {
  const want = modelId.trim().toLowerCase()
  if (!want) return undefined
  const exact = models.find((model) => model.id.toLowerCase() === want)
  if (exact) return exact
  const aliases = models.filter((model) => model.aliases?.some((alias) => alias.toLowerCase() === want))
  return aliases.length === 1 ? aliases[0] : undefined
}

/** Compact, safe summary lines for smoke stdout (no secrets). */
export function formatCursorModelCatalogLines(models: readonly CursorModelCatalogEntry[]): string[] {
  return models.map((m) => {
    const params = (m.parameters ?? [])
      .map((p) => {
        const vals = (p.values ?? []).map((v) => v.value).join('|')
        return `${p.id}[${vals || '?'}]`
      })
      .join(', ')
    const variants = (m.variants ?? [])
      .map((v) => {
        const ps = (v.params ?? []).map((p) => `${p.id}=${p.value}`).join(',')
        return `${v.displayName || 'variant'}(${ps})${v.isDefault ? '*' : ''}`
      })
      .join('; ')
    const bits = [
      m.id,
      m.displayName && m.displayName !== m.id ? `"${m.displayName}"` : '',
      params ? `params={${params}}` : '',
      variants ? `variants={${variants}}` : '',
    ].filter(Boolean)
    return bits.join(' ')
  })
}
