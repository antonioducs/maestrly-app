import { autonomousPolicy,assertAutonomousPermission } from './autonomous'
import { remoteChatPolicy, assertRemoteChatPermission, isWebManagedConversation } from './remote-policy'
/**
 * BYOK chat tool permission broker. Faithfully ported without Effect from opencode `permission.ts`
 * + `permission/saved.ts` + `util/wildcard.ts`.
 *
 * Model: ordered `{action,resource,effect}` ruleset (allow|deny|ask), last wildcard match wins.
 * Before acting, tools call `assert({action,resources})`. On `ask`, create a pending
 * request (Deferred in a Map) and emit 'asked' → service forwards to renderer; user response
 * (once|always|reject) returns through `reply()` and resolves/rejects the Promise. "always" persists
 * workspace `allow` rules (SQLite) and reapproves covered pending requests. YOLO = blanket allow.
 *
 * Differences from opencode: collapse agents/sources/connection; `projectId` = workspaceId; add
 * `toolName`/`title` for a better dialog; check deny ONLY against base rules
 * before merging saved rules (preserves brief's G1 asymmetry).
 */

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { getDb } from '../store'

export type RuleEffect = 'allow' | 'deny' | 'ask'
export interface Rule {
  action: string
  resource: string
  effect: RuleEffect
}
export type Ruleset = Rule[]

export type PermissionAction = 'bash' | 'edit' | 'read' | 'grep' | 'glob' | 'webfetch' | 'external_directory' | 'mcp'
export type Reply = 'once' | 'always' | 'reject'

export interface AssertInput {
  conversationId: string
  projectId: string
  action: string
  resources: string[]
  /** Patterns to persist as `allow` if user answers "always". */
  save?: string[]
  toolName?: string
  toolCallId?: string
  /** Contextual title from external bridges (cwd, reason, host, etc.). */
  title?: string
  /** Cancels only this gate without persisting rules. Used by protocols clearing server-side requests. */
  signal?: AbortSignal
}

export interface PermissionRequest {
  id: string
  conversationId: string
  projectId: string
  action: string
  resources: string[]
  save?: string[]
  toolName?: string
  toolCallId?: string
  title: string
}

export interface ReplyInput {
  requestId: string
  reply: Reply
  message?: string
}

/** Policy denial (never asks). */
export class DeniedError extends Error {
  constructor(readonly rules: Rule[]) {
    super('Operation denied by the permission policy.')
    this.name = 'PermissionDeniedError'
  }
}
/** User denied without feedback. */
export class RejectedError extends Error {
  constructor() {
    super('Operation denied by the user.')
    this.name = 'PermissionRejectedError'
  }
}
/** User denied WITH feedback (becomes a model message). */
export class CorrectedError extends Error {
  constructor(readonly feedback: string) {
    super(feedback)
    this.name = 'PermissionCorrectedError'
  }
}
/** Provider ended the request before user decision (turn complete/interrupt/request resolved). */
export class PermissionCancelledError extends Error {
  constructor() {
    super('Permission request was cancelled by the provider.')
    this.name = 'PermissionCancelledError'
  }
}

// ---- Wildcard matcher (verbatim opencode copy — already pure JS). ----
export function wildcardMatch(input: string, pattern: string): boolean {
  const normalized = input.replaceAll('\\', '/')
  let escaped = pattern
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  if (escaped.endsWith(' .*')) escaped = escaped.slice(0, -3) + '( .*)?'
  return new RegExp('^' + escaped + '$', process.platform === 'win32' ? 'si' : 's').test(normalized)
}

/** Resolves winning (action,resource) rule: last match; synthetic `ask` fallback. */
function evaluate(action: string, resource: string, ...rulesets: Ruleset[]): Rule {
  const flat = rulesets.flat()
  for (let i = flat.length - 1; i >= 0; i--) {
    const r = flat[i]
    if (wildcardMatch(action, r.action) && wildcardMatch(resource, r.resource)) return r
  }
  return { action, resource: '*', effect: 'ask' }
}

// ---- Default rulesets (BYOK gates dangerous actions; inverted opencode build-agent port). ----
export const BYOK_DEFAULT_RULESET: Ruleset = [
  { action: '*', resource: '*', effect: 'allow' }, // Unrestricted read/grep/glob.
  { action: 'bash', resource: '*', effect: 'ask' },
  { action: 'edit', resource: '*', effect: 'ask' }, // Covers write/edit.
  { action: 'webfetch', resource: '*', effect: 'ask' },
  { action: 'external_directory', resource: '*', effect: 'ask' },
  { action: 'mcp', resource: '*', effect: 'ask' }, // External MCP server tools → request approval.
  { action: 'read', resource: '*.env', effect: 'ask' },
  { action: 'read', resource: '*.env.*', effect: 'ask' },
  { action: 'read', resource: '*.env.example', effect: 'allow' },
]
export const YOLO_RULESET: Ruleset = [{ action: '*', resource: '*', effect: 'allow' }]

/** "Approve for me" (auto): allows most actions; asks for dangerous ones (bash + external directory). */
export const AUTO_RULESET: Ruleset = [
  { action: '*', resource: '*', effect: 'allow' },
  { action: 'bash', resource: '*', effect: 'ask' },
  { action: 'external_directory', resource: '*', effect: 'ask' },
  { action: 'read', resource: '*.env', effect: 'ask' },
  { action: 'read', resource: '*.env.*', effect: 'ask' },
  { action: 'read', resource: '*.env.example', effect: 'allow' },
]

interface Pending {
  request: PermissionRequest
  resolve: (reply: 'once' | 'always') => void
  reject: (e: Error) => void
}

function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function titleFor(action: string, resources: string[]): string {
  const first = resources[0] ?? '*'
  switch (action) {
    case 'bash':
      return `Run command: ${first}`
    case 'edit':
      return `Write file: ${first}`
    case 'webfetch':
      return `Fetch URL: ${first}`
    case 'external_directory':
      return `Access directory outside the project: ${first}`
    case 'mcp':
      return `Use MCP tool: ${first}`
    default:
      return `Allow ${action}: ${first}`
  }
}

export interface PermissionBrokerDeps {
  /** Effective base conversation ruleset (from permission mode: full/ask/auto). */
  rulesetFor: (conversationId: string) => Ruleset
}

export class PermissionBroker extends EventEmitter {
  private pending = new Map<string, Pending>()

  constructor(private deps: PermissionBrokerDeps) {
    super()
  }

  /** Effective conversation base rules (depend on chosen permission mode). */
  private baseRules(conversationId: string): Ruleset {
    return this.deps.rulesetFor(conversationId)
  }

  /** Persisted workspace `allow` rules. */
  private savedRules(projectId: string): Ruleset {
    const rows = getDb()
      .prepare('SELECT action, resource FROM permission_saved WHERE project_id = ?')
      .all(projectId) as Array<{ action: string; resource: string }>
    return rows.map((r) => ({ action: r.action, resource: r.resource, effect: 'allow' as const }))
  }

  private savedAdd(projectId: string, action: string, resources: string[]): void {
    const stmt = getDb().prepare(
      `INSERT INTO permission_saved (id, project_id, action, resource)
       VALUES (?,?,?,?) ON CONFLICT(project_id, action, resource) DO NOTHING`
    )
    for (const resource of resources) stmt.run(randomUUID(), projectId, action, resource)
  }

  private denied(input: AssertInput, rules: Ruleset): boolean {
    return input.resources.some((res) => evaluate(input.action, res, rules).effect === 'deny')
  }

  private evaluateInput(input: AssertInput): { effect: RuleEffect; rules: Ruleset } {
    const base = this.baseRules(input.conversationId)
    if (this.denied(input, base)) return { effect: 'deny', rules: base } // deny: base rules only (G1).
    const all = [...base, ...this.savedRules(input.projectId)]
    const effs = input.resources.map((res) => evaluate(input.action, res, all).effect)
    const effect: RuleEffect = effs.includes('deny') ? 'deny' : effs.includes('ask') ? 'ask' : 'allow'
    return { effect, rules: all }
  }

  private buildRequest(input: AssertInput): PermissionRequest {
    return {
      id: 'per_' + randomUUID(),
      conversationId: input.conversationId,
      projectId: input.projectId,
      action: input.action,
      resources: input.resources,
      save: input.save,
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      title: input.title ?? titleFor(input.action, input.resources),
    }
  }

  /**
   * Variant for protocol bridges reporting whether approval applies once
   * or to the session. Already-allowed rules resolve as `once`: no new user decision occurred.
   */
  async assertDecision(input: AssertInput): Promise<'once' | 'always'> {
    if (input.signal?.aborted) throw new PermissionCancelledError()
    const remote=remoteChatPolicy(input.conversationId)
    if(!remote&&isWebManagedConversation(input.conversationId))throw new Error('Remote conversation has no active lease.')
    const remoteEffect=remote?assertRemoteChatPermission(remote,input):null
    if(remoteEffect==='read')return 'once'
    const autonomous=autonomousPolicy(input.conversationId)
    if(autonomous){assertAutonomousPermission(autonomous,input);return 'once'}
    const r = remoteEffect==='ask'?{effect:'ask' as const,rules:[]}:this.evaluateInput(input)
    if (r.effect === 'deny') throw new DeniedError(r.rules)
    if (r.effect === 'allow') return 'once'
    const req = this.buildRequest(input)
    const d = deferred<'once' | 'always'>()
    this.pending.set(req.id, { request: req, resolve: d.resolve, reject: d.reject })
    const cancel = (): void => {
      const pending = this.pending.get(req.id)
      if (!pending) return
      this.pending.delete(req.id)
      this.emitResolved(pending.request, 'deny')
      pending.reject(new PermissionCancelledError())
    }
    input.signal?.addEventListener('abort', cancel, { once: true })
    this.emit('asked', req)
    try {
      return await d.promise
    } finally {
      input.signal?.removeEventListener('abort', cancel)
      this.pending.delete(req.id)
    }
  }

  /** Blocking gate called inside tool execute. Resolves on allow; throws on deny/reject. */
  async assert(input: AssertInput): Promise<void> {
    await this.assertDecision(input)
  }

  /** Emits 'resolved' (UI dismisses prompt + transitions tool state). */
  private emitResolved(req: PermissionRequest, decision: 'allow' | 'deny'): void {
    this.emit('resolved', {
      requestId: req.id,
      conversationId: req.conversationId,
      toolCallId: req.toolCallId,
      decision,
    })
  }

  /** Resolves a pending request (from permission:respond IPC). */
  reply(input: ReplyInput): void {
    const existing = this.pending.get(input.requestId)
    if (!existing) return
    if(input.reply==='always'&&(remoteChatPolicy(existing.request.conversationId)||isWebManagedConversation(existing.request.conversationId)))throw new Error('Web chat permissions are valid for one operation only.')

    if (input.reply === 'reject') {
      this.emitResolved(existing.request, 'deny')
      existing.reject(input.message ? new CorrectedError(input.message) : new RejectedError())
      this.pending.delete(input.requestId)
      // Cascade: reject all other pending requests in the SAME conversation (turn aborted).
      for (const [id, item] of this.pending) {
        if (item.request.conversationId !== existing.request.conversationId) continue
        this.emitResolved(item.request, 'deny')
        item.reject(new RejectedError())
        this.pending.delete(id)
      }
      return
    }

    if (input.reply === 'always' && existing.request.save?.length) {
      this.savedAdd(existing.request.projectId, existing.request.action, existing.request.save)
    }
    this.emitResolved(existing.request, 'allow')
    existing.resolve(input.reply)
    this.pending.delete(input.requestId)
    if (input.reply !== 'always' || !existing.request.save?.length) return

    // Cascade: a new saved rule may satisfy other pending requests — reapprove covered ones.
    for (const [id, item] of this.pending) {
      const base = this.baseRules(item.request.conversationId)
      if (this.denied(item.request, base)) continue
      const eff = [...base, ...this.savedRules(item.request.projectId)]
      if (item.request.resources.every((res) => evaluate(item.request.action, res, eff).effect === 'allow')) {
        this.emitResolved(item.request, 'allow')
        item.resolve('always')
        this.pending.delete(id)
      }
    }
  }

  /** Rejects all pending conversation requests (abort/teardown). */
  rejectConversation(conversationId: string): void {
    for (const [id, item] of this.pending) {
      if (item.request.conversationId !== conversationId) continue
      this.emitResolved(item.request, 'deny')
      item.reject(new RejectedError())
      this.pending.delete(id)
    }
  }

  pendingFor(conversationId: string): PermissionRequest[] {
    return [...this.pending.values()].map((p) => p.request).filter((r) => r.conversationId === conversationId)
  }
}
