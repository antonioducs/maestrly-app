/**
 * Shared BYOK chat tool utilities. Ported without Effect from opencode
 * `file-mutation.ts` (BOM + KeyedMutex), `tool-output-store.ts` (bounding), `read-filesystem.ts`
 * (binary detection), and `filesystem/schema.ts` (mime/Entry).
 */

import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'
import type { z } from 'zod'
import type { PermissionAction } from '../permission'
import type { ChatQuestion } from '../../../shared/chat'

export type { PermissionAction }

export type ReviewEvidenceKind = 'diff' | 'search' | 'read' | 'context-search' | 'context-read'

export interface StructuredReviewFinding {
  id: string
  severity: 'blocking' | 'important' | 'optional'
  title: string
  details: string
  paths?: string[]
}

export interface StructuredReviewDecision {
  result: 'clean' | 'findings'
  summary: string
  findings?: StructuredReviewFinding[]
}

export type SubmitReviewResult = { ok: true; idempotent?: true } | { ok: false; error: string }

/** Host-owned callbacks available only in an isolated reviewer turn. */
export interface ReviewerToolRuntime {
  recordEvidence(kind: ReviewEvidenceKind): void
  submitReview(decision: StructuredReviewDecision): SubmitReviewResult
  searchExecutionContext(input: { query: string; limit?: number }): unknown | Promise<unknown>
  readExecutionContext(input: { around_seq: number; limit?: number }): unknown | Promise<unknown>
  /** Present on the fresh host recorder so the turn outcome can carry the accepted structured decision. */
  decision?(): StructuredReviewDecision | null
}

/** Context passed to each tool execute (replaces opencode Location/Permission environments). */
export interface ToolContext {
  conversationId: string
  /** workspaceId — key for saved permission rules. */
  projectId: string
  messageId: string
  toolCallId: string
  /** Conversation working directory (worktree/root). Tools operate relative to it. */
  cwd: string
  signal: AbortSignal
  /** Permission gate; resolves on allow, throws on deny/reject. */
  ask: (action: PermissionAction, resources: string[], save?: string[]) => Promise<void>
  /** ask_question (mark X): presents user questions and blocks until answered. [] = dismissed. */
  askQuestion: (questions: ChatQuestion[]) => Promise<string[][]>
  /** review_plan (chat): registers the drawer plan and SIGNALS the runner to cut at the step boundary
   * (submit & release — user decision starts a new turn). Absent = tool must not be used. */
  /** Returns false when another source owns the pending Plan slot. */
  submitPlan?: (plan: string, title?: string) => boolean
  /** generate_image: publishes the already-written artifact's `generated-image` part in the assistant message
   * (runner wires this to `apply`). Absent = do not register the tool for this turn. */
  emitGeneratedImage?: (image: GeneratedImageEmission) => void
  /** generate_image: lets the runner supply the Codex runtime/account that should draw. When absent, the
   * tool resolves the connected subscription through the manager (non-Codex provider path). */
  generateImage?: (
    prompt: string,
    signal: AbortSignal,
    onUsage?: (usage: GeneratedImageUsage) => void
  ) => Promise<GeneratedImageEmission>
  /** generate_image: accounts for usage as soon as available, even if later materialization fails. */
  onGeneratedImageUsage?: (usage: GeneratedImageUsage) => void
  /** Reviewer-only host runtime. Normal turns deliberately omit it. */
  reviewer?: ReviewerToolRuntime
}

/** Artifact already written to the store (`generated-images.ts`) — only the opaque handle travels, never bytes. */
export interface GeneratedImageEmission {
  artifactId: string
  name: string
  mediaType: string
  byteSize: number
  revisedPrompt?: string
  /** Authoritative ephemeral-thread usage; excludes asset/image pricing. */
  usage?: GeneratedImageUsage
}

/** Disjoint buckets reported by Codex for an auxiliary generation. */
export interface GeneratedImageUsage {
  providerId: string
  modelId: string
  /** Input not served from cache; cachedInput is a separate bucket. */
  input: number
  output: number
  cachedInput?: number
  cacheCreate?: number
}

/** Tool definition (becomes AI SDK `tool()` through toAiTool in index.ts). */
export interface ToolDef<P extends z.ZodTypeAny = z.ZodTypeAny, R = unknown> {
  name: string
  description: string
  parameters: P
  execute: (args: z.infer<P>, ctx: ToolContext) => Promise<R>
  /** How to render R as model-visible text. */
  toModelText: (args: z.infer<P>, result: R) => string
}

/** Typing helper for declaring tools while preserving schema inference. */
export function defineTool<P extends z.ZodTypeAny, R>(def: ToolDef<P, R>): ToolDef<P, R> {
  return def
}

// ---- MIME (minimal ext→mime map; directory = x-directory). ----
const MIME: Record<string, string> = {
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.js': 'text/javascript',
  '.jsx': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.css': 'text/css',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.yml': 'text/yaml',
  '.yaml': 'text/yaml',
  '.toml': 'text/toml',
  '.sh': 'text/x-sh',
  '.py': 'text/x-python',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.c': 'text/x-c',
  '.h': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.java': 'text/x-java',
  '.rb': 'text/x-ruby',
  '.php': 'text/x-php',
  '.sql': 'text/x-sql',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
}
export function mimeOf(p: string): string {
  return MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream'
}

const BINARY_EXTS = new Set([
  '.zip',
  '.gz',
  '.tar',
  '.tgz',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.o',
  '.a',
  '.class',
  '.jar',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
  '.woff',
  '.woff2',
  '.ttf',
])
export function isBinaryExt(p: string): boolean {
  return BINARY_EXTS.has(path.extname(p).toLowerCase())
}

/** Heuristic: NUL byte OR >30% nonprintable bytes in the first ~4KB. */
export function isProbablyBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096)
  if (n === 0) return false
  let nonPrintable = 0
  for (let i = 0; i < n; i++) {
    const b = buf[i]
    if (b === 0) return true
    if (b < 9 || (b > 13 && b < 32)) nonPrintable++
  }
  return nonPrintable / n > 0.3
}

// ---- BOM (UTF-8) ----
export function hasUtf8Bom(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
}
export function stripBom(s: string): string {
  return s.replace(/^﻿+/, '')
}

// ---- line endings ----
export function detectEnding(t: string): '\n' | '\r\n' {
  return t.includes('\r\n') ? '\r\n' : '\n'
}
export function toEnding(t: string, e: '\n' | '\r\n'): string {
  const lf = t.replace(/\r\n/g, '\n')
  return e === '\n' ? lf : lf.replace(/\n/g, '\r\n')
}

export function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0
  let c = 0
  let i = 0
  while ((i = hay.indexOf(needle, i)) !== -1) {
    c++
    i += needle.length
  }
  return c
}

/** Diff preview (up to 6 lines per side, each truncated to 240 chars). */
export function previewDiff(oldStr: string, newStr: string): string {
  const fmt = (s: string, sign: '-' | '+') => {
    const lines = s.split('\n')
    const shown = lines.slice(0, 6).map((l) => sign + (l.length > 240 ? l.slice(0, 240) + '…' : l))
    if (lines.length > 6) shown.push(sign + '…')
    return shown.join('\n')
  }
  return '```diff\n' + fmt(oldStr, '-') + '\n' + fmt(newStr, '+') + '\n```'
}

// ---- File lock (KeyedMutex port): serializes write/edit on the same file. ----
const locks = new Map<string, Promise<unknown>>()
export function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  let lock!: Promise<unknown>
  lock = next
    .catch(() => {})
    .then(() => {
      if (locks.get(key) === lock) locks.delete(key)
    })
  locks.set(key, lock)
  return next
}

// ---- Cwd-relative path resolution + escape flag (external_directory). ----
export function resolveInside(cwd: string, p: string): { abs: string; external: boolean } {
  const abs = path.resolve(cwd, p)
  const root = path.resolve(cwd)
  const rel = path.relative(root, abs)
  const external = rel.startsWith('..') || path.isAbsolute(rel)
  return { abs, external }
}

/** Reviewer-only realpath jail: lexical in-cwd symlinks cannot disclose files outside the checkout. */
export async function assertReviewerPathInside(
  ctx: Pick<ToolContext, 'cwd' | 'reviewer'>,
  abs: string
): Promise<string> {
  if (!ctx.reviewer) return abs
  const [root, target] = await Promise.all([fs.promises.realpath(ctx.cwd), fs.promises.realpath(abs)])
  const rel = path.relative(root, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Reviewer path escapes the checkout')
  return target
}

// ---- Output bounding (simplified port of tool-output-store.ts). ----
const MAX_OUTPUT_LINES = 2000
const MAX_OUTPUT_BYTES = 50 * 1024

let spillDir: string | null = null
function getSpillDir(): string {
  if (!spillDir) {
    spillDir = path.join(app.getPath('userData'), 'chat-tool-output')
    try {
      fs.mkdirSync(spillDir, { recursive: true })
    } catch {
      /* best-effort */
    }
  }
  return spillDir
}

/** Bounds model-visible text (head+tail) and spills full output to a file on overflow. */
export function boundText(text: string, toolCallId: string): string {
  const byteLen = Buffer.byteLength(text, 'utf8')
  const lines = text.split('\n')
  if (lines.length <= MAX_OUTPUT_LINES && byteLen <= MAX_OUTPUT_BYTES) return text

  let spillPath = ''
  try {
    spillPath = path.join(getSpillDir(), `tool_${toolCallId}.txt`)
    fs.writeFileSync(spillPath, text, 'utf8')
  } catch {
    spillPath = ''
  }
  const headCount = Math.ceil(MAX_OUTPUT_LINES / 2)
  const tailCount = Math.floor(MAX_OUTPUT_LINES / 2)
  const head = lines.slice(0, headCount).join('\n')
  const tail = lines.slice(Math.max(headCount, lines.length - tailCount)).join('\n')
  const marker = spillPath
    ? `\n\n… output truncated; full content saved to ${spillPath} …\n\n`
    : '\n\n… output truncated …\n\n'
  return head + marker + tail
}
