/** Notes traversal protection belongs in safePageId so IPC and MCP callers share the same guard. Tests cover the pure rule and real temporary filesystem writes. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { freshDb, closeDb } from '../helpers/db'
import { makeWorkspace, makeConversation } from '../helpers/factories'
import { safePageId, writePage, readPage, listPages, disposeNotes } from '../../src/main/notes/notes-service'

describe('safePageId — path traversal guard (#264)', () => {
  it('rejects traversal, separators, and dangerous names, including encoded input', () => {
    expect(safePageId('../../etc/passwd')).toBeNull()
    expect(safePageId('..\\..\\x')).toBeNull()
    expect(safePageId('a/b')).toBeNull()
    expect(safePageId('..')).toBeNull()
    expect(safePageId('.')).toBeNull()
    expect(safePageId('')).toBeNull()
    expect(safePageId('%2e%2e%2f%2e%2e%2fx')).toBeNull() // ../../x percent-encoded
    expect(safePageId('a%2fb')).toBeNull() // a/b percent-encoded
  })

  it('accepts a valid page UUID and returns it unchanged', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000'
    expect(safePageId(uuid)).toBe(uuid)
  })
})

describe('writePage/readPage keep traversal page IDs inside the notebook (#264)', () => {
  let cwd: string
  beforeEach(() => {
    freshDb()
    cwd = mkdtempSync(path.join(os.tmpdir(), 'notes-cwd-'))
    execFileSync('git', ['init', '-q'], { cwd }) // Provide a writable location for best-effort excludeFromGitInfo.
  })
  afterEach(() => {
    disposeNotes() // Close filesystem watchers before removing the temporary directory.
    rmSync(cwd, { recursive: true, force: true })
    closeDb()
  })

  it('pageId="../../x" cannot access files outside .agents/notes; valid UUIDs remain writable', async () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id, { cwd })

    // Reject traversal writes and reads; blocked reads return an empty string.
    await writePage('conv', conv.id, '../../x', 'pwn')
    expect(existsSync(path.join(cwd, 'x.md'))).toBe(false)
    expect(existsSync(path.join(cwd, '.agents', 'x.md'))).toBe(false)
    expect(await readPage('conv', conv.id, '../../x')).toBe('')

    // The default page UUID writes and reads inside the notebook.
    const pages = await listPages('conv', conv.id) // Create the notebook and its default page.
    const pageId = pages[0]!.id
    await writePage('conv', conv.id, pageId, 'valid content')
    expect(await readPage('conv', conv.id, pageId)).toBe('valid content')
    expect(existsSync(path.join(cwd, '.agents', 'notes', `${pageId}.md`))).toBe(true)
  })
})
