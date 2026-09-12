import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { workspaceDataDir } from '../app-paths'
import { getDb, getWorkspace, listWorkspaces, transaction } from '../store'

const LEGACY_FILE = 'memory.md'

interface LegacySection {
  id: string
  title: string
  content: string
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export function splitLegacyMemory(workspaceId: string, sourceHash: string, content: string): LegacySection[] {
  if (content.length === 0) return []
  const headings = [...content.matchAll(/^#{1,3}[\t ]+(.+?)[\t ]*#*[\t ]*$/gm)]
  if (headings.length === 0) {
    return [
      {
        id: `legacy-${sha256([workspaceId, sourceHash, '0'].join('\0')).slice(0, 48)}`,
        title: 'Legacy project memory',
        content,
      },
    ]
  }

  const sections: Array<{ title: string; start: number; end: number }> = []
  const firstIndex = headings[0].index ?? 0
  const intro = content.slice(0, firstIndex)
  if (intro.trim()) sections.push({ title: 'Legacy project memory', start: 0, end: firstIndex })
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]
    const headingStart = heading.index ?? 0
    const start = index === 0 && !intro.trim() ? 0 : headingStart
    const end = headings[index + 1]?.index ?? content.length
    const title = (heading[1] ?? '').replace(/[\t ]+#+[\t ]*$/, '').trim() || 'Legacy project memory'
    sections.push({ title, start, end })
  }
  return sections.map((section, index) => ({
    id: `legacy-${sha256([workspaceId, sourceHash, String(index)].join('\0')).slice(0, 48)}`,
    title: section.title.slice(0, 240),
    content: content.slice(section.start, section.end),
  }))
}

async function sourceFor(workspaceId: string): Promise<string | undefined> {
  const workspace = getWorkspace(workspaceId)
  if (!workspace) return undefined
  const destination = path.join(workspaceDataDir(workspaceId), LEGACY_FILE)
  try {
    await fsp.access(destination)
    return destination
  } catch {
    // Older builds kept memory in the repository. Copy into userData without editing/removing the user's
    // file, then use the same app-owned migration journal.
  }
  const repositoryLegacy = path.join(workspace.path, '.agents', LEGACY_FILE)
  try {
    const content = await fsp.readFile(repositoryLegacy)
    await fsp.mkdir(path.dirname(destination), { recursive: true })
    await fsp.writeFile(destination, content, { flag: 'wx' })
    return destination
  } catch {
    return undefined
  }
}

function migrationRow(
  workspaceId: string,
  sourceHash: string
): { status: string; backup_path: string | null } | undefined {
  return getDb()
    .prepare('SELECT status, backup_path FROM local_memory_migrations WHERE workspace_id = ? AND source_hash = ?')
    .get(workspaceId, sourceHash) as { status: string; backup_path: string | null } | undefined
}

function verifyImported(workspaceId: string, sections: LegacySection[], sourceHash: string): void {
  const statement = getDb().prepare('SELECT content FROM local_memories WHERE workspace_id = ? AND id = ?')
  const imported = sections.map((section) => {
    const row = statement.get(workspaceId, section.id) as { content: string } | undefined
    if (!row) throw new Error(`legacy memory verification failed for ${section.id}`)
    return row.content
  })
  if (imported.length !== sections.length || sha256(imported.join('')) !== sourceHash) {
    throw new Error('legacy memory verification failed: count/hash mismatch')
  }
}

export async function migrateLegacyMemory(workspaceId: string): Promise<void> {
  const source = await sourceFor(workspaceId)
  if (!source) return
  const raw = await fsp.readFile(source)
  const content = raw.toString('utf8')
  const sourceHash = sha256(raw)
  const sections = splitLegacyMemory(workspaceId, sourceHash, content)
  const existing = migrationRow(workspaceId, sourceHash)
  if (!existing) {
    const now = Date.now()
    transaction(() => {
      const insert = getDb().prepare(
        `INSERT OR IGNORE INTO local_memories
         (id, workspace_id, title, content, type, status, scope, tags_json, importance, pinned, source,
          origin_conversation_id, origin_message_id, supersedes_id, promoted_path, content_hash,
          created_at, updated_at, last_used_at, use_count)
         VALUES (?, ?, ?, ?, 'reference', 'active', '', '["legacy"]', 0, 0, 'legacy-import',
                 NULL, NULL, NULL, NULL, ?, ?, ?, NULL, 0)`
      )
      for (const section of sections) {
        insert.run(section.id, workspaceId, section.title, section.content, sha256(section.content), now, now)
      }
      getDb()
        .prepare(
          `INSERT INTO local_memory_migrations
           (workspace_id, source_hash, imported_count, backup_path, status, error, created_at, updated_at)
           VALUES (?, ?, ?, NULL, 'imported', NULL, ?, ?)`
        )
        .run(workspaceId, sourceHash, sections.length, now, now)
    })
  }

  verifyImported(workspaceId, sections, sourceHash)
  const backup = path.join(path.dirname(source), `legacy-memory.${sourceHash}.md`)
  try {
    await fsp.rename(source, backup)
  } catch (error) {
    try {
      const currentBackup = await fsp.readFile(backup)
      if (sha256(currentBackup) !== sourceHash) throw error
      await fsp.rm(source, { force: true })
    } catch {
      getDb()
        .prepare(
          `UPDATE local_memory_migrations SET status = 'backup-failed', error = ?, updated_at = ?
           WHERE workspace_id = ? AND source_hash = ?`
        )
        .run(error instanceof Error ? error.message : String(error), Date.now(), workspaceId, sourceHash)
      throw error
    }
  }
  getDb()
    .prepare(
      `UPDATE local_memory_migrations SET status = 'completed', backup_path = ?, error = NULL, updated_at = ?
       WHERE workspace_id = ? AND source_hash = ?`
    )
    .run(backup, Date.now(), workspaceId, sourceHash)
}

export async function migrateAllLegacyMemories(): Promise<void> {
  for (const workspace of listWorkspaces()) {
    try {
      await migrateLegacyMemory(workspace.id)
    } catch (error) {
      console.warn('[memory] legacy migration failed:', error instanceof Error ? error.message : error)
    }
  }
}

export function getLegacyMemoryBackups(workspaceId: string): Array<{ path: string; hash: string; status: string }> {
  return (
    getDb()
      .prepare(
        `SELECT source_hash, backup_path, status FROM local_memory_migrations
         WHERE workspace_id = ? ORDER BY updated_at DESC`
      )
      .all(workspaceId) as Array<{ source_hash: string; backup_path: string | null; status: string }>
  )
    .filter((row): row is { source_hash: string; backup_path: string; status: string } => Boolean(row.backup_path))
    .map((row) => ({ path: row.backup_path, hash: row.source_hash, status: row.status }))
}
