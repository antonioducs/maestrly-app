import { createHash } from 'node:crypto'
import path from 'node:path'
import {
  SHARED_MEMORY_STATUSES,
  SHARED_MEMORY_TYPES,
  type SharedKnowledgeDocument,
  type SharedMemoryStatus,
  type SharedMemoryType,
} from '../../../shared/memory'

interface ParsedFrontmatter {
  values: Record<string, unknown>
  body: string
  bodyStartLine: number
  warnings: string[]
}

function scalar(value: string): unknown {
  const trimmed = value.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null' || trimmed === '~') return null
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    // Promotion emits JSON arrays. Parse that exact format first so quoted commas/escapes round-trip;
    // retain the small YAML-like fallback for hand-authored `[one, two]` values.
    try {
      return JSON.parse(trimmed) as unknown
    } catch {
      // fall through to the permissive inline-list parser
    }
    const inside = trimmed.slice(1, -1).trim()
    if (!inside) return []
    return inside.split(',').map((item) => String(scalar(item)).trim())
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as unknown
    } catch {
      // malformed quoted scalars remain observable through field validation
    }
  }
  return trimmed.replace(/^(['"])(.*)\1$/, '$2')
}

function parseFrontmatter(raw: string): ParsedFrontmatter {
  const normalized = raw.replaceAll('\r\n', '\n')
  if (!normalized.startsWith('---\n')) return { values: {}, body: normalized, bodyStartLine: 1, warnings: [] }
  const closing = normalized.indexOf('\n---\n', 4)
  if (closing < 0) {
    return { values: {}, body: normalized, bodyStartLine: 1, warnings: ['frontmatter is not closed'] }
  }
  const values: Record<string, unknown> = {}
  const warnings: string[] = []
  const lines = normalized.slice(4, closing).split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const match = /^([a-zA-Z_][\w-]*):\s*(.*)$/.exec(line)
    if (!match) {
      warnings.push(`invalid frontmatter at line ${index + 2}`)
      continue
    }
    const [, key, rawValue] = match
    if (key in values) warnings.push(`duplicate frontmatter key: ${key}`)
    values[key] = scalar(rawValue)
  }
  return {
    values,
    body: normalized.slice(closing + 5),
    bodyStartLine: lines.length + 3,
    warnings,
  }
}

function strings(value: unknown, field: string, warnings: string[]): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    warnings.push(`${field} must be a string array`)
    return []
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))]
}

function inferredType(relativePath: string): SharedMemoryType {
  const segments = relativePath.replaceAll(path.sep, '/').split('/').filter(Boolean)
  const knowledge = segments.lastIndexOf('knowledge')
  const candidate = knowledge >= 0 ? segments[knowledge + 1] : segments[0]
  return SHARED_MEMORY_TYPES.includes(candidate as SharedMemoryType) ? (candidate as SharedMemoryType) : 'reference'
}

export function parseSharedKnowledgeDocument(input: {
  root: string
  relativePath: string
  raw: string
  modifiedAt: number
}): SharedKnowledgeDocument {
  const frontmatter = parseFrontmatter(input.raw)
  const warnings = [...frontmatter.warnings]
  const fallbackId = input.relativePath.replaceAll(path.sep, '/').replace(/\.md$/i, '')
  const idValue = frontmatter.values.id
  const id = typeof idValue === 'string' && idValue.trim() ? idValue.trim() : fallbackId
  if (idValue !== undefined && (typeof idValue !== 'string' || !idValue.trim())) warnings.push('id must be a string')

  const typeValue = frontmatter.values.type
  let type = inferredType(input.relativePath)
  if (typeValue !== undefined) {
    if (typeof typeValue === 'string' && SHARED_MEMORY_TYPES.includes(typeValue as SharedMemoryType)) {
      type = typeValue as SharedMemoryType
    } else warnings.push(`invalid type: ${String(typeValue)}`)
  }
  const statusValue = frontmatter.values.status
  let status: SharedMemoryStatus = 'active'
  if (statusValue !== undefined) {
    if (typeof statusValue === 'string' && SHARED_MEMORY_STATUSES.includes(statusValue as SharedMemoryStatus)) {
      status = statusValue as SharedMemoryStatus
    } else warnings.push(`invalid status: ${String(statusValue)}`)
  }
  const scopeValue = frontmatter.values.scope
  const scope = typeof scopeValue === 'string' ? scopeValue.trim() : ''
  if (scopeValue !== undefined && typeof scopeValue !== 'string') warnings.push('scope must be a string')
  const tags = strings(frontmatter.values.tags, 'tags', warnings)
  const supersedes = strings(frontmatter.values.supersedes, 'supersedes', warnings)
  const alwaysValue = frontmatter.values.always_apply
  const alwaysApply = alwaysValue === true
  if (alwaysValue !== undefined && typeof alwaysValue !== 'boolean') warnings.push('always_apply must be boolean')

  const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(frontmatter.body)
  const title = (heading?.[1]?.trim() || path.basename(input.relativePath, path.extname(input.relativePath))).slice(
    0,
    240,
  )
  const headingOffset = heading?.index ?? 0
  const startLine = frontmatter.bodyStartLine + frontmatter.body.slice(0, headingOffset).split('\n').length - 1
  const normalizedPath = input.relativePath.replaceAll(path.sep, '/')
  return {
    id,
    root: input.root,
    relativePath: normalizedPath,
    title,
    content: frontmatter.body,
    type,
    status,
    scope,
    tags,
    supersedes,
    alwaysApply,
    contentHash: createHash('sha256').update(input.raw).digest('hex'),
    modifiedAt: input.modifiedAt,
    provenance: {
      repo: input.root,
      path: normalizedPath,
      ...(heading ? { heading: heading[1]?.trim(), startLine } : { startLine: frontmatter.bodyStartLine }),
      endLine: input.raw.replaceAll('\r\n', '\n').split('\n').length,
    },
    warnings,
    eligibleForContext: warnings.length === 0 && status === 'active',
  }
}
