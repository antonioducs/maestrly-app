/**
 * Fast file AND folder search for chat `@` autocomplete. Walks the conversation cwd
 * (skipping .git/node_modules/etc), filters by case-insensitive substring, and prioritizes name matches.
 * Folders have kind:'dir' (chat references their listing). Caps both scan and result counts.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { ChatFileHit } from '../../shared/chat'

// Do not skip all dot-directories (keep .github/.vscode searchable); list LARGE dot-directories by name.
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', '.next', '.cache', 'coverage', '.turbo', '.agents', '.claude', '.venv', '.idea', '.vs', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.svn', '.hg', '.terraform'])
const MAX_SCAN = 8000
const MAX_RESULTS = 30

export async function searchFiles(cwd: string, query: string, limit = MAX_RESULTS): Promise<ChatFileHit[]> {
  const q = query.trim().toLowerCase()
  const hits: { hit: ChatFileHit; score: number }[] = []
  let scanned = 0

  const consider = (rel: string, name: string, kind: 'file' | 'dir') => {
    const lower = name.toLowerCase()
    if (!q) {
      hits.push({ hit: { path: rel, name, kind }, score: kind === 'dir' ? 1 : 0 })
    } else if (lower.includes(q)) {
      hits.push({ hit: { path: rel, name, kind }, score: lower.startsWith(q) ? 3 : 2 })
    } else if (rel.toLowerCase().includes(q)) {
      hits.push({ hit: { path: rel, name, kind }, score: 1 })
    }
  }

  async function walk(dir: string): Promise<void> {
    if (scanned >= MAX_SCAN || hits.length >= limit * 4) return
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (scanned >= MAX_SCAN) return
      const full = path.join(dir, e.name)
      const rel = path.relative(cwd, full).replaceAll('\\', '/')
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        consider(rel + '/', e.name, 'dir')
        await walk(full)
      } else if (e.isFile()) {
        scanned++
        consider(rel, e.name, 'file')
      }
    }
  }

  await walk(cwd)
  // On equal scores, files precede folders; then prefer shorter paths.
  hits.sort((a, b) => b.score - a.score || (a.hit.kind === b.hit.kind ? 0 : a.hit.kind === 'file' ? -1 : 1) || a.hit.path.length - b.hit.path.length)
  return hits.slice(0, limit).map((h) => h.hit)
}
