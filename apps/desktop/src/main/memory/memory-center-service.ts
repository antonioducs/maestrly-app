import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { shell } from 'electron'
import type {
  LocalMemoryFilters,
  LocalMemoryUpdateInput,
  MemorySearchHit,
  MemoryType,
  SharedKnowledgeDocument,
  SharedMemoryType,
} from '../../shared/memory'
import { checkKnowledgeGitVisibility, excludeFromGitInfo } from '../git-service'
import { getWorkspace } from '../store'
import {
  archiveLocalMemory,
  createLocalMemory,
  forgetLocalMemory,
  getLocalMemory,
  listLocalMemories,
  restoreLocalMemory,
  updateLocalMemory,
} from './local-memory-service'
import { getLegacyMemoryBackups } from './legacy-memory-migrator'
import { rebuildMemoryIndex, reconcileMemoryIndex } from './index'
import { retrieveHybridMemory } from './retrieval'
import { discoverSharedKnowledge } from './shared-knowledge'
import { isWorkspaceMemoryEnabled } from './access'

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

async function safeKnowledgeDirectory(repositoryRoot: string, type: SharedMemoryType): Promise<{
  realRoot: string
  directory: string
}> {
  const realRoot = await fsp.realpath(repositoryRoot)
  let cursor = realRoot
  for (const segment of ['.agents', 'knowledge', type]) {
    cursor = path.join(cursor, segment)
    try {
      const stat = await fsp.lstat(cursor)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${segment} is not a safe directory`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await fsp.mkdir(cursor)
    }
    const canonical = await fsp.realpath(cursor)
    if (!inside(realRoot, canonical)) throw new Error('knowledge path resolves outside repository')
    cursor = canonical
  }
  return { realRoot, directory: cursor }
}

export function renderSharedMemoryMarkdown(input: {
  id: string
  title: string
  content: string
  type: SharedMemoryType
  scope?: string
  tags?: string[]
  supersedes?: string[]
  alwaysApply?: boolean
}): string {
  const lines = [
    '---',
    `id: ${JSON.stringify(input.id)}`,
    `type: ${input.type}`,
    'status: active',
    ...(input.scope?.trim() ? [`scope: ${JSON.stringify(input.scope.trim())}`] : []),
    ...(input.tags?.length ? [`tags: ${JSON.stringify([...new Set(input.tags)])}`] : []),
    ...(input.supersedes?.length ? [`supersedes: ${JSON.stringify([...new Set(input.supersedes)])}`] : []),
    `always_apply: ${input.alwaysApply === true ? 'true' : 'false'}`,
    '---',
    '',
    `# ${input.title.trim()}`,
    '',
    input.content.trim(),
    '',
  ]
  return lines.join('\n')
}

function toSharedType(type: MemoryType, requested?: SharedMemoryType): SharedMemoryType {
  if (requested) return requested
  return type === 'preference' ? 'reference' : type
}

export async function listSharedMemories(workspaceId: string, repositoryRoot?: string): Promise<{
  documents: SharedKnowledgeDocument[]
  warnings: string[]
  repositoryRoot: string
}> {
  const workspace = getWorkspace(workspaceId)
  if (!workspace) throw new Error('workspace not found')
  const root = repositoryRoot ?? workspace.path
  const discovery = await discoverSharedKnowledge(root)
  return { documents: discovery.documents, warnings: discovery.warnings, repositoryRoot: discovery.root }
}

export async function searchMemoryCenter(
  workspaceId: string,
  query: string,
  repositoryRoot?: string,
): Promise<MemorySearchHit[]> {
  const workspace = getWorkspace(workspaceId)
  if (!workspace) throw new Error('workspace not found')
  if (!isWorkspaceMemoryEnabled(workspaceId)) {
    const needle = query.trim().toLocaleLowerCase()
    const locals: MemorySearchHit[] = listLocalMemories(workspaceId, { query, limit: 100 }).map((memory) => ({
      kind: 'local',
      id: memory.id,
      title: memory.title,
      content: memory.content,
      type: memory.type,
      status: memory.status,
      scope: memory.scope,
      tags: memory.tags,
      source: memory.source,
      pinned: memory.pinned,
      score: 0,
      updatedAt: memory.updatedAt,
      lastUsedAt: memory.lastUsedAt,
      useCount: memory.useCount,
    }))
    const discovery = await discoverSharedKnowledge(repositoryRoot ?? workspace.path)
    const shared: MemorySearchHit[] = discovery.documents
      .filter((document) =>
        [document.title, document.content, document.scope, document.relativePath, ...document.tags]
          .join('\n')
          .toLocaleLowerCase()
          .includes(needle),
      )
      .slice(0, 100)
      .map((document) => ({
        kind: 'shared',
        id: document.id,
        title: document.title,
        content: document.content,
        type: document.type,
        status: document.status,
        scope: document.scope,
        tags: document.tags,
        score: 0,
        repo: document.root,
        path: document.relativePath,
        heading: document.provenance.heading,
        startLine: document.provenance.startLine,
        endLine: document.provenance.endLine,
      }))
    return [...locals, ...shared].slice(0, 100)
  }
  return retrieveHybridMemory({
    workspaceId,
    query,
    roots: [{ root: repositoryRoot ?? workspace.path }],
    limit: 10,
    markUsed: false,
  })
}

export async function promoteLocalMemory(input: {
  workspaceId: string
  memoryId: string
  repositoryRoot?: string
  type?: SharedMemoryType
  scope?: string
  slug?: string
  overwrite?: boolean
}): Promise<{ path: string; markdown: string; gitIgnored: boolean; gitRule?: string }> {
  const workspace = getWorkspace(input.workspaceId)
  if (!workspace) throw new Error('workspace not found')
  const memory = getLocalMemory(input.workspaceId, input.memoryId)
  if (!memory) throw new Error('memory not found')
  const type = toSharedType(memory.type, input.type)
  const id = slugify(input.slug || memory.title || memory.id) || memory.id
  const markdown = renderSharedMemoryMarkdown({
    id,
    title: memory.title,
    content: memory.content,
    type,
    scope: input.scope ?? memory.scope,
    tags: memory.tags,
  })
  const root = input.repositoryRoot ?? workspace.path
  const { realRoot, directory } = await safeKnowledgeDirectory(root, type)
  const target = path.join(directory, `${id}.md`)
  if (!inside(realRoot, target)) throw new Error('promotion path escaped repository')
  const existing = await fsp.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new Error('promotion target is not a regular file')
  if (existing && !input.overwrite) throw new Error('shared memory already exists')
  if (existing) {
    const temporary = path.join(directory, `.${id}.${Date.now()}.tmp`)
    await fsp.writeFile(temporary, markdown, { encoding: 'utf8', flag: 'wx' })
    await fsp.rename(temporary, target)
  } else {
    await fsp.writeFile(target, markdown, { encoding: 'utf8', flag: 'wx' })
  }
  await excludeFromGitInfo(realRoot, [])
  const visibility = await checkKnowledgeGitVisibility(realRoot)
  const relativePath = path.relative(realRoot, target).replaceAll(path.sep, '/')
  updateLocalMemory(input.workspaceId, input.memoryId, { promotedPath: relativePath })
  await reconcileMemoryIndex(input.workspaceId, [{ root: realRoot }])
  return {
    path: relativePath,
    markdown,
    gitIgnored: visibility.ignored,
    ...(visibility.rule ? { gitRule: visibility.rule } : {}),
  }
}

export async function previewLocalMemoryPromotion(input: {
  workspaceId: string
  memoryId: string
  type?: SharedMemoryType
  scope?: string
  slug?: string
}): Promise<{ relativePath: string; markdown: string }> {
  const memory = getLocalMemory(input.workspaceId, input.memoryId)
  if (!memory) throw new Error('memory not found')
  const type = toSharedType(memory.type, input.type)
  const id = slugify(input.slug || memory.title || memory.id) || memory.id
  return {
    relativePath: `.agents/knowledge/${type}/${id}.md`,
    markdown: renderSharedMemoryMarkdown({
      id,
      title: memory.title,
      content: memory.content,
      type,
      scope: input.scope ?? memory.scope,
      tags: memory.tags,
    }),
  }
}

export async function openSharedMemorySource(workspaceId: string, relativePath: string): Promise<boolean> {
  const workspace = getWorkspace(workspaceId)
  if (!workspace || !relativePath || path.isAbsolute(relativePath) || relativePath.includes('\0')) return false
  const root = await fsp.realpath(workspace.path)
  const target = path.resolve(root, relativePath)
  if (!inside(root, target)) return false
  const real = await fsp.realpath(target).catch(() => undefined)
  if (!real || !inside(root, real)) return false
  const stat = await fsp.stat(real)
  if (!stat.isFile()) return false
  shell.showItemInFolder(real)
  return true
}

export function exportLocalMemoryData(workspaceId: string): { json: string; markdown: string } {
  const memories = listLocalMemories(workspaceId, { limit: 500 })
  const json = `${JSON.stringify({ schemaVersion: 1, workspaceId, exportedAt: Date.now(), memories }, null, 2)}\n`
  const markdown = memories
    .map(
      (memory) =>
        `# ${memory.title}\n\n- ID: \`${memory.id}\`\n- Type: ${memory.type}\n- Status: ${memory.status}\n- Scope: ${memory.scope || '—'}\n- Tags: ${memory.tags.join(', ') || '—'}\n- Source: ${memory.source}\n\n${memory.content}\n`,
    )
    .join('\n---\n\n')
  return { json, markdown }
}

export async function removeLegacyMemoryBackup(workspaceId: string, backupPath: string): Promise<boolean> {
  const allowed = getLegacyMemoryBackups(workspaceId).some((backup) => backup.path === backupPath)
  if (!allowed) return false
  await fsp.rm(backupPath, { force: true })
  return true
}

export const memoryCenterLocal = {
  list: listLocalMemories,
  get: getLocalMemory,
  create: createLocalMemory,
  update: updateLocalMemory,
  archive: archiveLocalMemory,
  restore: restoreLocalMemory,
  forget: forgetLocalMemory,
  backups: getLegacyMemoryBackups,
  rebuildIndex: rebuildMemoryIndex,
} as const

export type { LocalMemoryFilters, LocalMemoryUpdateInput }
