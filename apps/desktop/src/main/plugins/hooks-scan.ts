import type { PackageTree } from './package-tree'

/**
 * Hook events Maestrly emulates for every model. It controls these moments itself: the turn's start and end, the
 * prompt, and each tool call through its own tools. Other events (permission requests, prompt expansion, compaction,
 * notifications, session end) are not included.
 */
export const SUPPORTED_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
] as const
export type PluginHookEvent = (typeof SUPPORTED_HOOK_EVENTS)[number]

/** One command hook, as the plugin declares it. */
export interface PluginHookSpec {
  event: PluginHookEvent
  /** A tool-name (or session-source) pattern, anchored; null matches everything. */
  matcher: string | null
  /** A shell command; `${CLAUDE_PLUGIN_ROOT}`/`${PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_DATA}`/`${PLUGIN_DATA}` are expanded. */
  command: string
  timeoutSec: number
  /** The file (or manifest field) that declares it. */
  source: string
}

export type HookSource = { path: string } | { inline: unknown; label: string }

export interface HookScanResult {
  hooks: PluginHookSpec[]
  /** Sources that declared at least one supported hook. */
  adapted: string[]
  /** Hooks not included: `<Event>` for an event Maestrly does not run, `<Event>: <type>` for a non-command hook. */
  unsupported: string[]
  /** Sources that are not a hooks file. */
  invalid: { source: string; detail: string }[]
  issues: { code: 'hook-invalid'; detail: string }[]
}

const DEFAULT_TIMEOUT_SEC = 60
const MAX_TIMEOUT_SEC = 600
const HOOKS_FILE_MAX_BYTES = 256 * 1024
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const supported = (event: string): event is PluginHookEvent =>
  (SUPPORTED_HOOK_EVENTS as readonly string[]).includes(event)

/** A matcher Maestrly can test: null for "everything", otherwise a valid pattern. */
export function hookMatcherPattern(matcher: string | null): RegExp | null {
  if (matcher === null || matcher === '' || matcher === '*') return null
  return new RegExp(`^(?:${matcher})$`)
}

async function readSource(tree: PackageTree, source: HookSource): Promise<{ label: string; json: unknown }> {
  if ('inline' in source) return { label: source.label, json: source.inline }
  const entry = tree.entries.get(source.path)
  if (!entry || (entry.mode !== 'file' && entry.mode !== 'executable')) return { label: source.path, json: undefined }
  const raw = await tree.read(source.path, HOOKS_FILE_MAX_BYTES)
  try {
    return { label: source.path, json: raw ? JSON.parse(raw.toString('utf8')) : undefined }
  } catch {
    return { label: source.path, json: undefined }
  }
}

/**
 * Reads the hooks a plugin declares (Claude Code's `hooks.json` shape: `{ hooks: { <Event>: [{ matcher?, hooks: [{
 * type: 'command', command, timeout? }] }] } }`). Only command hooks of the supported events are kept; everything
 * else is reported so it can be listed as not included.
 */
export async function scanHooks(tree: PackageTree, sources: readonly HookSource[]): Promise<HookScanResult> {
  const result: HookScanResult = { hooks: [], adapted: [], unsupported: [], invalid: [], issues: [] }
  const note = (subject: string) => {
    if (!result.unsupported.includes(subject)) result.unsupported.push(subject)
  }
  for (const source of sources) {
    const { label, json } = await readSource(tree, source)
    if (!isRecord(json) || !isRecord(json.hooks)) {
      result.invalid.push({ source: label, detail: 'unrecognized hooks format' })
      continue
    }
    let found = 0
    for (const [event, groups] of Object.entries(json.hooks)) {
      if (!Array.isArray(groups)) {
        result.invalid.push({ source: label, detail: `hooks.${event} is not a list` })
        continue
      }
      for (const group of groups) {
        if (!isRecord(group) || !Array.isArray(group.hooks)) continue
        const matcher = typeof group.matcher === 'string' && group.matcher.trim() ? group.matcher.trim() : null
        for (const hook of group.hooks) {
          if (!isRecord(hook)) continue
          const type = typeof hook.type === 'string' ? hook.type : 'command'
          if (!supported(event)) {
            note(event)
            continue
          }
          if (type !== 'command') {
            note(`${event}: ${type}`)
            continue
          }
          const command = typeof hook.command === 'string' ? hook.command.trim() : ''
          if (!command) continue
          try {
            hookMatcherPattern(matcher)
          } catch {
            result.issues.push({
              code: 'hook-invalid',
              detail: `${label}: ${event} matcher "${matcher}" is not a valid pattern`,
            })
            continue
          }
          const timeout =
            typeof hook.timeout === 'number' && Number.isFinite(hook.timeout) ? hook.timeout : DEFAULT_TIMEOUT_SEC
          result.hooks.push({
            event,
            matcher,
            command,
            timeoutSec: Math.min(MAX_TIMEOUT_SEC, Math.max(1, Math.round(timeout))),
            source: label,
          })
          found += 1
        }
      }
    }
    if (found) result.adapted.push(label)
  }
  return result
}
