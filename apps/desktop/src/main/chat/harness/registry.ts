import { HarnessConfigError, parseHarnessDefinition } from './schema'
import {
  DEFAULT_HARNESS_PROFILE_ID,
  type HarnessBinding,
  type HarnessProfile,
  type HarnessRegistry,
  type HarnessSources,
} from './types'

const PROFILE_PREFIX = 'profiles/'
const CONFIG_FILE = 'config.json'
const FOLDER_PATTERN = /^[a-z0-9][a-z0-9._-]*$/
const FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry)
  return Object.freeze(value)
}

/**
 * Prompt bodies are stored with normalized line endings and without the file's trailing newline, so
 * a checkout difference (CRLF/LF) never changes the compiled prompt or the compatibility hash.
 */
export function canonicalizeText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\n+$/, '')
}

interface ParsedPath {
  folderId: string
  file: string
}

/** Rejects traversal, absolute paths, URLs, nested folders and anything outside a profile folder. */
function parsePath(path: string): ParsedPath {
  if (!path.startsWith(PROFILE_PREFIX)) {
    throw new HarnessConfigError('catalog', path, 'source paths must start with "profiles/"')
  }
  const rest = path.slice(PROFILE_PREFIX.length)
  const segments = rest.split('/')
  if (segments.length !== 2) {
    throw new HarnessConfigError('catalog', path, 'expected exactly profiles/<profile>/<file>')
  }
  const [folderId, file] = segments as [string, string]
  if (!FOLDER_PATTERN.test(folderId)) {
    throw new HarnessConfigError('catalog', path, `invalid profile folder name "${folderId}"`)
  }
  if (!FILE_PATTERN.test(file)) {
    throw new HarnessConfigError(folderId, path, `invalid file name "${file}"`)
  }
  if (file !== CONFIG_FILE && !file.endsWith('.md')) {
    throw new HarnessConfigError(folderId, path, 'profile folders accept only config.json and .md files')
  }
  return { folderId, file }
}

function bindingKey(binding: HarnessBinding): string {
  return `${binding.providerKind}/${binding.endpoint ?? 'any'}`
}

function collectTextRefs(binding: HarnessBinding): string[] {
  const prompts = binding.overrides.prompts
  const refs: (string | null | undefined)[] = [
    prompts?.base,
    prompts?.styleAndWork,
    prompts?.subagent,
    prompts?.compaction,
    prompts?.developerPrefix?.base,
    prompts?.developerPrefix?.asyncTools,
    prompts?.ultra?.base,
    ...Object.values(prompts?.ultra?.byMode ?? {}),
    ...(binding.overrides.hooks ?? []).map((hook) => hook.text),
  ]
  return refs.filter((value): value is string => typeof value === 'string' && value.length > 0)
}

function buildProfile(folderId: string, files: Map<string, string>): HarnessProfile {
  const config = files.get(CONFIG_FILE)
  if (config === undefined) {
    throw new HarnessConfigError(folderId, CONFIG_FILE, 'every profile folder must declare config.json')
  }
  const definition = parseHarnessDefinition(folderId, CONFIG_FILE, config)

  const seen = new Set<string>()
  for (const binding of definition.bindings) {
    const key = bindingKey(binding)
    if (seen.has(key)) {
      throw new HarnessConfigError(folderId, CONFIG_FILE, `duplicate binding for ${key}`)
    }
    seen.add(key)
    if (binding.endpoint === 'official-openai' && binding.providerKind !== 'openai-responses') {
      throw new HarnessConfigError(
        folderId,
        CONFIG_FILE,
        `endpoint "official-openai" is only valid for openai-responses, not ${binding.providerKind}`
      )
    }
    for (const ref of collectTextRefs(binding)) {
      if (!files.has(ref)) {
        throw new HarnessConfigError(folderId, CONFIG_FILE, `referenced text "${ref}" does not exist in the profile`)
      }
    }
  }

  const texts: Record<string, string> = {}
  for (const [file, contents] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (file !== CONFIG_FILE) texts[file] = canonicalizeText(contents)
  }
  return deepFreeze({ folderId, definition, texts })
}

class Registry implements HarnessRegistry {
  readonly default: HarnessProfile
  readonly #byFolder: ReadonlyMap<string, HarnessProfile>
  readonly #exact: ReadonlyMap<string, HarnessProfile>
  readonly #lowercase: ReadonlyMap<string, HarnessProfile>
  readonly #ordered: readonly HarnessProfile[]

  constructor(profiles: readonly HarnessProfile[]) {
    const byFolder = new Map<string, HarnessProfile>()
    const exact = new Map<string, HarnessProfile>()
    const lowercase = new Map<string, HarnessProfile>()
    const definitionIds = new Map<string, string>()

    for (const profile of profiles) {
      byFolder.set(profile.folderId, profile)
      const previous = definitionIds.get(profile.definition.id)
      if (previous) {
        throw new HarnessConfigError(
          profile.folderId,
          CONFIG_FILE,
          `id "${profile.definition.id}" already declared by profile "${previous}"`
        )
      }
      definitionIds.set(profile.definition.id, profile.folderId)
      if (profile.folderId === DEFAULT_HARNESS_PROFILE_ID) continue

      const identities = [profile.folderId, ...(profile.definition.match?.aliases ?? [])].map((value) => value.trim())
      for (const value of identities) {
        const target = profile.definition.match?.caseInsensitive ? lowercase : exact
        const key = profile.definition.match?.caseInsensitive ? value.toLowerCase() : value
        const collision = target.get(key)
        if (collision) {
          throw new HarnessConfigError(
            profile.folderId,
            CONFIG_FILE,
            `identity "${value}" already matched by profile "${collision.folderId}"`
          )
        }
        target.set(key, profile)
      }
    }

    const fallback = byFolder.get(DEFAULT_HARNESS_PROFILE_ID)
    if (!fallback) {
      throw new HarnessConfigError('catalog', CONFIG_FILE, 'the mandatory "default" profile folder is missing')
    }
    for (const [key, profile] of lowercase) {
      const collision = exact.get(key)
      if (collision && collision !== profile) {
        throw new HarnessConfigError(
          profile.folderId,
          CONFIG_FILE,
          `identity "${key}" collides with profile "${collision.folderId}"`
        )
      }
    }

    this.default = fallback
    this.#byFolder = byFolder
    this.#exact = exact
    this.#lowercase = lowercase
    this.#ordered = Object.freeze(
      [...profiles].sort((a, b) => (a.folderId < b.folderId ? -1 : a.folderId > b.folderId ? 1 : 0))
    )
    Object.freeze(this)
  }

  get(folderId: string): HarnessProfile | null {
    return this.#byFolder.get(folderId) ?? null
  }

  /** Exact identity only: no substring, family, prefix stripping or nearby-version inference. */
  match(modelId: string): HarnessProfile | null {
    const trimmed = modelId.trim()
    if (!trimmed) return null
    return this.#exact.get(trimmed) ?? this.#lowercase.get(trimmed.toLowerCase()) ?? null
  }

  list(): readonly HarnessProfile[] {
    return this.#ordered
  }
}

/**
 * Builds the validated catalog from plain file sources. Ordering of the input never affects the
 * result and the returned registry exposes no mutation surface.
 */
export function createHarnessRegistry(sources: HarnessSources): HarnessRegistry {
  const folders = new Map<string, Map<string, string>>()
  for (const path of Object.keys(sources).sort()) {
    const { folderId, file } = parsePath(path)
    const bucket = folders.get(folderId) ?? new Map<string, string>()
    if (bucket.has(file)) throw new HarnessConfigError(folderId, path, 'duplicate file in profile folder')
    bucket.set(file, sources[path]!)
    folders.set(folderId, bucket)
  }
  if (folders.size === 0) {
    throw new HarnessConfigError('catalog', CONFIG_FILE, 'no harness profiles were discovered')
  }
  const profiles = [...folders.keys()].sort().map((folderId) => buildProfile(folderId, folders.get(folderId)!))
  return new Registry(profiles)
}

export { HarnessConfigError }
