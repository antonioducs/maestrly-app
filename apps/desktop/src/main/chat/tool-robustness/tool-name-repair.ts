/**
 * Maps a tool name the model invented onto an available tool, deterministically and only when exactly one tool
 * matches. Distance-based matching only suggests: a typo must never run a different, possibly destructive, tool.
 *
 * The cleanup rules follow what Hermes Agent and OpenClaw observed in the field (XML fragments in names, `functions.`
 * and `default_api.` namespaces, `:N` suffixes, harness aliases); no code is copied.
 */

export type ToolNameResolution =
  | { kind: 'exact'; name: string }
  | { kind: 'repaired'; name: string; rule: 'cleanup' | 'case' | 'separators' | 'alias' }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'unknown'; suggestions: string[] }

const PREFIXES = ['functions.', 'functions/', 'default_api.', 'default_api:', 'mcp__maestrly__', 'maestrly_']

/** Names other harnesses use for a tool Maestrly has, keyed by the squashed name (lowercase, no separators). */
const ALIASES: Record<string, readonly string[]> = {
  read: ['readfile', 'view', 'viewfile', 'openfile', 'fileread', 'cat'],
  write: ['writefile', 'createfile', 'filewrite', 'writetofile'],
  edit: [
    'editfile',
    'strreplace',
    'strreplacebasededittool',
    'multiedit',
    'searchreplace',
    'replaceinfile',
    'applyedit',
  ],
  bash: ['shell', 'runterminalcmd', 'runcommand', 'executecommand', 'runshellcommand', 'execcommand', 'terminal'],
  grep: ['grepsearch', 'ripgrep', 'rg', 'searchfilecontent', 'searchcode'],
  glob: ['findfiles', 'filesearch', 'globfiles'],
  webfetch: ['fetch', 'fetchurl', 'readurl', 'urlfetch'],
  web_search: ['websearch', 'searchweb', 'googlesearch', 'internetsearch'],
  todo_write: ['todowrite', 'updatetodos', 'writetodos', 'todo'],
  task: ['agent', 'dispatchagent', 'subagent'],
  ask_question: ['askuserquestion', 'askuser', 'askfollowupquestion'],
  use_skill: ['skill', 'loadskill'],
  review_plan: ['exitplanmode', 'submitplan'],
}

const ALIAS_TARGET = new Map<string, string>(
  Object.entries(ALIASES).flatMap(([target, names]) => names.map((name) => [name, target] as const))
)

function separated(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s.\-/:]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase()
}

function squashed(name: string): string {
  return separated(name).replace(/_/g, '')
}

/** Spellings the model may have meant, from the raw name outward. */
function cleanedCandidates(raw: string): string[] {
  const candidates = new Set<string>()
  const add = (value: string) => {
    const trimmed = value.trim().replace(/^[`'"]+|[`'"]+$/g, '')
    if (trimmed) candidates.add(trimmed)
  }
  const cut = raw.trim().split(/["'<>\s(]/, 1)[0] ?? ''
  for (const base of [raw.trim(), cut]) {
    add(base)
    const unsuffixed = base.replace(/:\d+$/, '')
    add(unsuffixed)
    for (const prefix of PREFIXES) {
      if (unsuffixed.toLowerCase().startsWith(prefix)) add(unsuffixed.slice(prefix.length))
    }
    const segments = unsuffixed.split(/[./]/).filter(Boolean)
    if (segments.length > 1) add(segments[segments.length - 1])
  }
  return [...candidates]
}

function uniqueMatch(names: readonly string[], key: (name: string) => string, wanted: string): string[] {
  return names.filter((name) => key(name) === wanted)
}

/** Optimal string alignment distance (Damerau-Levenshtein with adjacent transpositions). */
export function editDistance(left: string, right: string): number {
  const rows = left.length + 1
  const cols = right.length + 1
  const table: number[][] = Array.from({ length: rows }, (_row, i) =>
    Array.from({ length: cols }, (_col, j) => (i === 0 ? j : j === 0 ? i : 0))
  )
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1
      table[i][j] = Math.min(table[i - 1][j] + 1, table[i][j - 1] + 1, table[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        table[i][j] = Math.min(table[i][j], table[i - 2][j - 2] + 1)
      }
    }
  }
  return table[rows - 1][cols - 1]
}

function suggestionsFor(raw: string, available: readonly string[]): string[] {
  const wanted = cleanedCandidates(raw)
    .map(separated)
    .filter((candidate) => candidate.length > 0)
  if (!wanted.length) return []
  const closeness = (name: string): number => {
    const target = separated(name)
    let best = Number.POSITIVE_INFINITY
    for (const candidate of wanted) {
      const distance = editDistance(candidate, target)
      if (distance <= Math.max(1, Math.floor(candidate.length / 3))) best = Math.min(best, distance)
    }
    return best
  }
  return available
    .map((name) => ({ name, distance: closeness(name) }))
    .filter((entry) => Number.isFinite(entry.distance))
    .sort((left, right) => left.distance - right.distance || left.name.localeCompare(right.name))
    .slice(0, 3)
    .map((entry) => entry.name)
}

export function resolveToolName(raw: string, available: readonly string[]): ToolNameResolution {
  if (available.includes(raw)) return { kind: 'exact', name: raw }
  const candidates = cleanedCandidates(raw)
  const passes: Array<{ rule: 'cleanup' | 'case' | 'separators' | 'alias'; match: (candidate: string) => string[] }> = [
    { rule: 'cleanup', match: (candidate) => (available.includes(candidate) ? [candidate] : []) },
    {
      rule: 'case',
      match: (candidate) => uniqueMatch(available, (name) => name.toLowerCase(), candidate.toLowerCase()),
    },
    { rule: 'separators', match: (candidate) => uniqueMatch(available, squashed, squashed(candidate)) },
    {
      rule: 'alias',
      match: (candidate) => {
        const target = ALIAS_TARGET.get(squashed(candidate))
        return target && available.includes(target) ? [target] : []
      },
    },
  ]
  for (const pass of passes) {
    const matches = new Set(candidates.flatMap((candidate) => pass.match(candidate)))
    if (matches.size === 1) return { kind: 'repaired', name: [...matches][0], rule: pass.rule }
    if (matches.size > 1) return { kind: 'ambiguous', candidates: [...matches].sort() }
  }
  return { kind: 'unknown', suggestions: suggestionsFor(raw, available) }
}

const MAX_LISTED_TOOLS = 30

/** The message the model receives for a tool name that could not be repaired. */
export function unknownToolMessage(raw: string, resolution: ToolNameResolution, available: readonly string[]): string {
  const name = raw.trim()
  if (!name) {
    return (
      'This tool call had an empty name, so it was not executed. Call a tool by its exact name from your tool ' +
      'list, or answer in plain text.'
    )
  }
  const quoted = JSON.stringify(name.length > 80 ? `${name.slice(0, 80)}…` : name)
  if (resolution.kind === 'ambiguous') {
    return (
      `No tool is named ${quoted}, and it could mean ${resolution.candidates.map((entry) => `\`${entry}\``).join(' or ')}. ` +
      'The call was not executed. Call the tool by its exact name.'
    )
  }
  if (resolution.kind === 'unknown' && resolution.suggestions.length) {
    return (
      `No tool is named ${quoted}, so the call was not executed. Did you mean ` +
      `${resolution.suggestions.map((entry) => `\`${entry}\``).join(', ')}? Call the tool by its exact name.`
    )
  }
  const sorted = [...available].sort()
  const listed = sorted.slice(0, MAX_LISTED_TOOLS).join(', ')
  const more = sorted.length > MAX_LISTED_TOOLS ? `, and ${sorted.length - MAX_LISTED_TOOLS} more` : ''
  return (
    `No tool is named ${quoted}, so the call was not executed. Available tools include: ${listed}${more}. ` +
    'Call one of them by its exact name, or answer in plain text.'
  )
}
