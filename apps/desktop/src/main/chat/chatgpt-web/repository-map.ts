import fs from 'node:fs/promises'
import path from 'node:path'

const MAX_INDEXED_FILES = 25_000
const MAX_TREE_ENTRIES = 100
const MAX_LIST_ENTRIES = 40
const MAX_MAP_CHARS = 24_000

type DirectoryNode = {
  name: string
  files: number
  children: Map<string, DirectoryNode>
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.c': 'C',
  '.cc': 'C++',
  '.cpp': 'C++',
  '.cs': 'C#',
  '.css': 'CSS',
  '.dart': 'Dart',
  '.ex': 'Elixir',
  '.exs': 'Elixir',
  '.go': 'Go',
  '.html': 'HTML',
  '.java': 'Java',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript/JSX',
  '.kt': 'Kotlin',
  '.kts': 'Kotlin',
  '.lua': 'Lua',
  '.php': 'PHP',
  '.py': 'Python',
  '.rb': 'Ruby',
  '.rs': 'Rust',
  '.scala': 'Scala',
  '.sh': 'Shell',
  '.sql': 'SQL',
  '.swift': 'Swift',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript/React',
  '.vue': 'Vue',
}

const MANIFEST_NAMES = new Set([
  'Cargo.toml',
  'Gemfile',
  'Package.swift',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'deno.json',
  'deno.jsonc',
  'docker-compose.yml',
  'docker-compose.yaml',
  'go.mod',
  'package.json',
  'pnpm-workspace.yaml',
  'pyproject.toml',
  'requirements.txt',
  'settings.gradle',
  'settings.gradle.kts',
  'turbo.json',
])

const TECHNOLOGIES: Array<[string, string]> = [
  ['@angular/core', 'Angular'],
  ['@nestjs/core', 'NestJS'],
  ['@remix-run/react', 'Remix'],
  ['@sveltejs/kit', 'SvelteKit'],
  ['electron', 'Electron'],
  ['express', 'Express'],
  ['fastify', 'Fastify'],
  ['next', 'Next.js'],
  ['react', 'React'],
  ['svelte', 'Svelte'],
  ['vite', 'Vite'],
  ['vue', 'Vue'],
  ['vitest', 'Vitest'],
]

function safeText(value: string, max = 240): string {
  return value.replace(/\s+/g, ' ').replaceAll('`', "'").slice(0, max)
}

const inlineCode = (value: string) => `\`${safeText(value)}\``

function normalizeFileList(raw: string): { files: string[]; truncated: boolean } {
  const unique = new Set<string>()
  let truncated = false
  for (const rawPath of raw.split(/\r?\n/)) {
    const candidate = rawPath.trim().replaceAll('\\', '/')
    if (!candidate || candidate.startsWith('/') || candidate === '..' || candidate.startsWith('../')) continue
    const normalized = path.posix.normalize(candidate).replace(/^\.\//, '')
    if (!normalized || normalized === '.' || normalized.startsWith('../')) continue
    unique.add(normalized)
    if (unique.size >= MAX_INDEXED_FILES) {
      truncated = true
      break
    }
  }
  return { files: [...unique].sort(), truncated }
}

function directoryTree(files: string[]): string[] {
  const root: DirectoryNode = { name: '', files: 0, children: new Map() }
  for (const file of files) {
    root.files++
    const parts = file.split('/').slice(0, -1)
    let node = root
    for (const part of parts) {
      let child = node.children.get(part)
      if (!child) {
        child = { name: part, files: 0, children: new Map() }
        node.children.set(part, child)
      }
      child.files++
      node = child
    }
  }

  const lines: string[] = []
  const visit = (node: DirectoryNode, depth: number) => {
    if (depth >= 3 || lines.length >= MAX_TREE_ENTRIES) return
    const children = [...node.children.values()].sort(
      (left, right) => right.files - left.files || left.name.localeCompare(right.name)
    )
    for (const child of children) {
      if (lines.length >= MAX_TREE_ENTRIES) return
      lines.push(`${'  '.repeat(depth)}- ${safeText(child.name, 120)}/ — ${child.files} file(s)`)
      visit(child, depth + 1)
    }
  }
  visit(root, 0)
  if (lines.length >= MAX_TREE_ENTRIES) lines.push(`… (tree limited to ${MAX_TREE_ENTRIES} directories)`)
  return lines
}

function languageSummary(files: string[]): string {
  const counts = new Map<string, number>()
  for (const file of files) {
    const language = LANGUAGE_BY_EXTENSION[path.posix.extname(file).toLowerCase()]
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1)
  }
  const sorted = [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  return sorted.length
    ? sorted
        .slice(0, 12)
        .map(([name, count]) => `${name}: ${count}`)
        .join(', ')
    : '(not inferred)'
}

function likelyEntrypoints(files: string[]): string[] {
  const basename =
    /^(?:app|bootstrap|cli|client|index|main|server|worker)\.(?:[cm]?[jt]sx?|py|rb|rs|go|java|kt|swift)$/i
  return files
    .filter((file) => basename.test(path.posix.basename(file)))
    .sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right))
    .slice(0, MAX_LIST_ENTRIES)
}

function workspacePatterns(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  if (value && typeof value === 'object' && Array.isArray((value as { packages?: unknown }).packages)) {
    return (value as { packages: unknown[] }).packages.filter((item): item is string => typeof item === 'string')
  }
  return []
}

async function rootPackageSummary(cwd: string, files: string[]): Promise<string[]> {
  if (!files.includes('package.json')) return []
  try {
    const raw = await fs.readFile(path.join(cwd, 'package.json'), 'utf8')
    if (raw.length > 1_000_000) return ['- `package.json` is too large to summarize automatically']
    const parsed = JSON.parse(raw) as {
      name?: unknown
      packageManager?: unknown
      main?: unknown
      module?: unknown
      bin?: unknown
      scripts?: unknown
      workspaces?: unknown
      dependencies?: unknown
      devDependencies?: unknown
    }
    const lines: string[] = []
    if (typeof parsed.name === 'string') lines.push(`- root package: ${inlineCode(parsed.name)}`)
    if (typeof parsed.packageManager === 'string') lines.push(`- package manager: ${inlineCode(parsed.packageManager)}`)
    const workspaces = workspacePatterns(parsed.workspaces)
    if (workspaces.length) lines.push(`- workspaces: ${workspaces.slice(0, 20).map(inlineCode).join(', ')}`)
    const entryValues = [parsed.main, parsed.module]
      .filter((item): item is string => typeof item === 'string')
      .concat(
        typeof parsed.bin === 'string'
          ? [parsed.bin]
          : parsed.bin && typeof parsed.bin === 'object'
            ? Object.values(parsed.bin).filter((item): item is string => typeof item === 'string')
            : []
      )
    if (entryValues.length) lines.push(`- declared entrypoints: ${entryValues.map(inlineCode).join(', ')}`)
    const scripts = parsed.scripts && typeof parsed.scripts === 'object' ? Object.keys(parsed.scripts) : []
    if (scripts.length) lines.push(`- scripts: ${scripts.slice(0, 30).map(inlineCode).join(', ')}`)
    const dependencies = {
      ...(parsed.dependencies && typeof parsed.dependencies === 'object' ? parsed.dependencies : {}),
      ...(parsed.devDependencies && typeof parsed.devDependencies === 'object' ? parsed.devDependencies : {}),
    }
    const technologies = TECHNOLOGIES.filter(([dependency]) => dependency in dependencies).map(([, name]) => name)
    if (technologies.length) lines.push(`- detected technologies: ${technologies.join(', ')}`)
    return lines
  } catch {
    return ['- `package.json` could not be parsed; use `read_file` to inspect it']
  }
}

/**
 * Compact structural map. It shows where to investigate without claiming file contents were read;
 * the coverage report generated at delivery repeats this distinction.
 */
export async function buildRepositoryMap(cwd: string, rawFiles: string): Promise<string> {
  const { files, truncated } = normalizeFileList(rawFiles)
  if (files.length === 0)
    return '## Automatic repository map\n(unavailable; use `glob` to discover the structure)'

  const manifests = files.filter((file) => MANIFEST_NAMES.has(path.posix.basename(file))).slice(0, MAX_LIST_ENTRIES)
  const rootFiles = files.filter((file) => !file.includes('/')).slice(0, MAX_LIST_ENTRIES)
  const entrypoints = likelyEntrypoints(files)
  const packageSummary = await rootPackageSummary(cwd, files)
  const sections = [
    '## Automatic repository map',
    `${files.length}${truncated ? '+' : ''} file(s) indexed. This map describes structure; it does not mean the content was read.`,
    `Languages by extension: ${languageSummary(files)}`,
    '',
    '### Main structure (up to 3 levels)',
    ...directoryTree(files),
  ]
  if (rootFiles.length) sections.push('', '### Root files', ...rootFiles.map((file) => `- ${inlineCode(file)}`))
  if (manifests.length)
    sections.push('', '### Manifests/workspaces', ...manifests.map((file) => `- ${inlineCode(file)}`))
  if (packageSummary.length) sections.push('', '### Root package signals', ...packageSummary)
  if (entrypoints.length) {
    sections.push(
      '',
      '### Likely entrypoints (confirm with `grep` and `read_file`)',
      ...entrypoints.map((file) => `- ${inlineCode(file)}`)
    )
  }
  sections.push(
    '',
    '> Before recommending changes, locate definitions and callers with `grep`/`glob` and read the relevant implementation, contracts and tests.'
  )
  const output = sections.join('\n')
  return output.length > MAX_MAP_CHARS ? `${output.slice(0, MAX_MAP_CHARS)}\n… (map truncated)` : output
}
