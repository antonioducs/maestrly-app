import { promises as fsp } from 'node:fs'
import path from 'node:path'
import type { SharedKnowledgeDocument } from '../../../shared/memory'
import { parseSharedKnowledgeDocument } from './parser'

const MAX_FILES = 5_000
const MAX_FILE_BYTES = 1024 * 1024
const MAX_DEPTH = 20

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

export interface SharedKnowledgeDiscovery {
  root: string
  knowledgeRoot: string
  documents: SharedKnowledgeDocument[]
  warnings: string[]
}

export async function discoverSharedKnowledge(repositoryRoot: string): Promise<SharedKnowledgeDiscovery> {
  const root = await fsp.realpath(repositoryRoot)
  const lexicalKnowledge = path.join(root, '.agents', 'knowledge')
  const warnings: string[] = []
  let knowledgeRoot = lexicalKnowledge
  try {
    const info = await fsp.lstat(lexicalKnowledge)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      return { root, knowledgeRoot, documents: [], warnings: ['.agents/knowledge must be a regular directory'] }
    }
    knowledgeRoot = await fsp.realpath(lexicalKnowledge)
    if (!inside(root, knowledgeRoot)) {
      return { root, knowledgeRoot, documents: [], warnings: ['.agents/knowledge resolves outside repository'] }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { root, knowledgeRoot, documents: [], warnings }
    throw error
  }

  const documents: SharedKnowledgeDocument[] = []
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || documents.length >= MAX_FILES) {
      warnings.push('shared knowledge defensive limit reached')
      return
    }
    const entries = await fsp.readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (documents.length >= MAX_FILES) break
      const absolute = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        warnings.push(`symlink ignored: ${path.relative(root, absolute)}`)
        continue
      }
      if (entry.isDirectory()) {
        await visit(absolute, depth + 1)
        continue
      }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.md') continue
      const real = await fsp.realpath(absolute)
      if (!inside(knowledgeRoot, real)) {
        warnings.push(`path escape ignored: ${path.relative(root, absolute)}`)
        continue
      }
      const stat = await fsp.stat(real)
      if (stat.size > MAX_FILE_BYTES) {
        warnings.push(`file too large: ${path.relative(root, absolute)}`)
        continue
      }
      const relativePath = path.relative(root, real)
      const raw = await fsp.readFile(real, 'utf8')
      documents.push(parseSharedKnowledgeDocument({ root, relativePath, raw, modifiedAt: stat.mtimeMs }))
    }
  }
  await visit(knowledgeRoot, 0)

  const byId = new Map<string, SharedKnowledgeDocument[]>()
  for (const document of documents) {
    const grouped = byId.get(document.id) ?? []
    grouped.push(document)
    byId.set(document.id, grouped)
  }
  for (const [id, grouped] of byId) {
    if (grouped.length < 2) continue
    warnings.push(`duplicate shared knowledge id: ${id}`)
    for (const document of grouped) {
      document.warnings.push(`duplicate id: ${id}`)
      document.eligibleForContext = false
    }
  }

  const unique = new Map(documents.map((document) => [document.id, document]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const stack: string[] = []
  const visitSupersedes = (id: string): void => {
    if (visited.has(id)) return
    if (visiting.has(id)) {
      const start = stack.indexOf(id)
      const cycle = stack.slice(start).concat(id)
      warnings.push(`supersedes cycle: ${cycle.join(' -> ')}`)
      for (const cycleId of cycle) {
        const document = unique.get(cycleId)
        if (document) {
          document.warnings.push('supersedes cycle')
          document.eligibleForContext = false
        }
      }
      return
    }
    visiting.add(id)
    stack.push(id)
    for (const target of unique.get(id)?.supersedes ?? []) if (unique.has(target)) visitSupersedes(target)
    stack.pop()
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of unique.keys()) visitSupersedes(id)
  return { root, knowledgeRoot, documents, warnings }
}
