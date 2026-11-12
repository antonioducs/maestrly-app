// Spike: publishes the built viewer, with a board the agent drew, as an artifact on a throwaway host. Build first: the
// artifact host, the whiteboard package, then this viewer.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openArtifactHost } from '../../artifact-host/dist/index.js'
import { applyOps, checkBoard, emptyBoard } from '../dist/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundle = path.resolve(here, '../build/viewer')

export const SAMPLE_OPS = [
  { op: 'section', id: 'client', title: 'Client' },
  { op: 'section', id: 'backend', title: 'Backend' },
  { op: 'section', id: 'data', title: 'Data' },
  { op: 'card', id: 'web', text: 'Web app (React)', in: 'client', color: 'blue' },
  { op: 'card', id: 'mobile', text: 'Mobile app', in: 'client', color: 'blue' },
  { op: 'card', id: 'api', text: 'API gateway', in: 'backend', color: 'yellow' },
  { op: 'card', id: 'auth', text: 'Auth service: sessions, OAuth and SSO', in: 'backend', color: 'yellow' },
  { op: 'card', id: 'db', text: 'Postgres', in: 'data', color: 'green', shape: 'ellipse' },
  { op: 'card', id: 'decide', text: 'Cache?', in: 'data', shape: 'diamond', color: 'orange' },
  { op: 'connect', from: 'web', to: 'api', label: 'HTTPS' },
  { op: 'connect', from: 'mobile', to: 'api' },
  { op: 'connect', from: 'api', to: 'auth' },
  { op: 'connect', from: 'api', to: 'db', label: 'SQL' },
  { op: 'connect', from: 'api', to: 'decide', dashed: true },
  { op: 'text', id: 'note', text: 'Drawn by the agent through applyOps', size: 'l', at: { x: 0, y: -120 } },
]
/** What the agent does after checking the board: the arrow to "Cache?" cut through the auth card. */
export const FIX_OPS = [{ op: 'move', id: 'auth', in: 'backend', to: { near: 'api', side: 'below' } }]

function walk(directory, prefix = '') {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name)
    const relative = prefix ? `${prefix}/${name}` : name
    return statSync(full).isDirectory() ? walk(full, relative) : [{ path: relative, bytes: readFileSync(full) }]
  })
}

export async function startSpikeHost(port = 0) {
  const drawn = applyOps(emptyBoard(), { baseRevision: 0, ops: SAMPLE_OPS, now: Date.now() })
  if (!drawn.ok) throw new Error(`${drawn.error.code}: ${drawn.error.message}`)
  const warnings = checkBoard(drawn.board)
  const fixed = applyOps(drawn.board, { baseRevision: drawn.board.revision, ops: FIX_OPS, now: Date.now() })
  if (!fixed.ok) throw new Error(`${fixed.error.code}: ${fixed.error.message}`)
  const result = fixed
  const saved = { revision: result.board.revision, elements: [...result.board.elements.values()] }
  const files = [...walk(bundle), { path: 'board.json', bytes: Buffer.from(JSON.stringify(saved)) }]

  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'whiteboard-spike-'))
  const host = await openArtifactHost({ dataDir, port, quotaBytes: 512 * 1024 * 1024 })
  const detail = await host.admin.create({
    title: 'Whiteboard spike',
    owner: { kind: 'local', id: 'local' },
    origin: { workspaceId: null, conversationId: 'spike', conversationTitle: null },
    files,
  })
  return {
    /** What the check found on the first drawing, and after the agent's fix. */
    warnings: { drawn: warnings, fixed: checkBoard(result.board) },
    revision: result.board.revision,
    files: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes.byteLength, 0),
    origin: `http://127.0.0.1:${host.port}`,
    /** Owner tickets work once: each call makes a fresh link. */
    async ownerUrl() {
      const { ticket } = await host.admin.mintOwnerTicket(detail.id)
      return `http://127.0.0.1:${host.port}/a/${detail.id}#o=${ticket}`
    },
    async close() {
      await host.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}
