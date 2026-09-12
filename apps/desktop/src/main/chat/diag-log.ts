/**
 * PERSISTENT chat streaming diagnostic log — JSONL in `userData/logs/chat-stream-diag.jsonl`.
 * Reason: stream cuts are rare/random (impractical to reproduce in dev while watching terminal logs);
 * the file captures post-mortem evidence in PRODUCTION — users work normally and logs tell the story afterward.
 * Writes operational events without message content, including per-call usage/cache and retry decisions.
 * Best-effort: never throws. Simple rotation: >8MB → rename to .1 (keeps at most ~16MB).
 */
import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'

let ensured = false

export function chatDiag(entry: Record<string, unknown>): void {
  const line = { ts: new Date().toISOString(), ...entry }
  console.log('[chat-diag]', JSON.stringify(line))
  try {
    const file = path.join(app.getPath('userData'), 'logs', 'chat-stream-diag.jsonl')
    if (!ensured) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      ensured = true
    }
    try {
      if (fs.statSync(file).size > 8_000_000) fs.renameSync(file, `${file}.1`)
    } catch {
      /* First write (stat fails) — continue. */
    }
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`)
  } catch {
    /* Best-effort: diagnostics never crash the turn. */
  }
}
