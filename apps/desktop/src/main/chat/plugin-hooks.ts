import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ToolSet } from 'ai'
import type { ChatMessage, ChatPermMode, ChatStreamEvent, MessagePart, ToolOutput } from '../../shared/chat'
import { capabilityBehaviorFor } from '../../shared/chat-mode'
import type { ConvUiPrefs } from '../../shared/conversation'
import type { ChatBehavior } from '../../shared/conversation-experience'
import { runHookCommand } from '../plugins/hook-command'
import { hookMatcherPattern, type PluginHookEvent } from '../plugins/hooks-scan'
import { type ActivePluginHook, listPluginHooks } from '../plugins/runtime'
import { getConvUiPrefs } from '../store'
import { listConversationContextMessages } from './chat-store'
import { conversationShellEnv } from './conversation-env'
import { chatDiag } from './diag-log'
import { isPortableCompactionMarker } from './message'
import { claudeToolName, fromClaudeInput, toClaudeInput } from './plugin-hook-tools'
import { modelOutputToChatToolOutput } from './tool-output'

/**
 * Plugin hooks, emulated by Maestrly with Claude Code's contract (JSON on stdin; exit code, stdout JSON or stderr as
 * the answer) so they behave the same with every model. Maestrly runs them at the moments it controls: the session's
 * start, each prompt, each tool call through its own tools, and the end of a turn.
 */

export interface HookNotice {
  plugin: string
  event: PluginHookEvent
  text: string
  level: 'info' | 'error'
}

export interface HookTurnContext {
  conversationId: string
  cwd: string
  mode: ChatBehavior
  permMode: ChatPermMode
  signal: AbortSignal
  /** A JSONL transcript of the conversation's text, written on first use. */
  transcriptPath(): Promise<string>
  notify(notice: HookNotice): void
}

const PERMISSION_MODE: Record<ChatPermMode, string> = { full: 'bypassPermissions', auto: 'acceptEdits', ask: 'default' }
const NOTICE_MAX_CHARS = 500

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * Hooks run only where the conversation may run commands: Agent and Design modes. Code and plan reviewers run in Ask,
 * so they never run hooks.
 */
function canRunHooks(mode: ChatBehavior): boolean {
  return capabilityBehaviorFor(mode) === 'agent'
}

export function hooksActive(ctx: Pick<HookTurnContext, 'conversationId' | 'mode'>): boolean {
  return canRunHooks(ctx.mode) && listPluginHooks({ conversationId: ctx.conversationId }).length > 0
}

const TOOL_EVENTS: ReadonlySet<PluginHookEvent> = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure'])

/** Whether a conversation has hooks on tool calls: then every tool call must go through Maestrly's tools. */
export function hasToolHooks(conversationId: string, mode: ChatBehavior): boolean {
  return (
    canRunHooks(mode) && listPluginHooks({ conversationId }).some((hook) => TOOL_EVENTS.has(hook.spec.event))
  )
}

/** Whether a conversation has hooks on one event (and may run them in this mode). */
export function hasHookEvent(conversationId: string, mode: ChatBehavior, event: PluginHookEvent): boolean {
  return canRunHooks(mode) && listPluginHooks({ conversationId }).some((hook) => hook.spec.event === event)
}

/** Whether a conversation has hooks on events only a Maestrly-run turn has: the session's start, prompts, turn ends. */
export function pluginsWithTurnHooks(conversationId: string): string[] {
  const names = listPluginHooks({ conversationId })
    .filter((hook) => !TOOL_EVENTS.has(hook.spec.event))
    .map((hook) => hook.pluginName)
  return [...new Set(names)]
}

/**
 * Why a ChatGPT web companion cannot serve a conversation: its turns run in chatgpt.com, where Maestrly sees only
 * tool calls, so hooks on the session's start, prompts or turn ends could not run. Null when nothing stops it.
 */
export function companionHooksRefusal(conversationId: string, mode: ChatBehavior): string | null {
  if (!canRunHooks(mode)) return null
  const blocking = pluginsWithTurnHooks(conversationId)
  return blocking.length ? `companion-hooks-unsupported: ${blocking.join(', ')}` : null
}

interface HookAnswer {
  hook: ActivePluginHook
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  json: Record<string, unknown> | null
}

function matches(hook: ActivePluginHook, subject: string | undefined): boolean {
  if (subject === undefined) return true
  try {
    const pattern = hookMatcherPattern(hook.spec.matcher)
    return !pattern || pattern.test(subject)
  } catch {
    return false
  }
}

/** Runs the event's matching hooks in parallel; answers come back in the hooks' order. */
async function runEvent(
  ctx: HookTurnContext,
  event: PluginHookEvent,
  fields: Record<string, unknown>,
  subject?: string
): Promise<HookAnswer[]> {
  if (!canRunHooks(ctx.mode)) return []
  const hooks = listPluginHooks({ conversationId: ctx.conversationId }).filter(
    (hook) => hook.spec.event === event && matches(hook, subject)
  )
  if (!hooks.length) return []
  const stdin = JSON.stringify({
    session_id: ctx.conversationId,
    transcript_path: await ctx.transcriptPath().catch(() => ''),
    cwd: ctx.cwd,
    hook_event_name: event,
    permission_mode: PERMISSION_MODE[ctx.permMode],
    ...fields,
  })
  const answers = await Promise.all(
    hooks.map(async (hook): Promise<HookAnswer> => {
      const result = await runHookCommand({
        command: hook.command,
        cwd: ctx.cwd,
        env: {
          ...conversationShellEnv(ctx.conversationId),
          ...hook.env,
          CLAUDE_PROJECT_DIR: ctx.cwd,
        },
        stdin,
        timeoutMs: hook.spec.timeoutSec * 1000,
        signal: ctx.signal,
      })
      let json: Record<string, unknown> | null = null
      if (result.code === 0 && result.stdout.trim().startsWith('{')) {
        try {
          const parsed: unknown = JSON.parse(result.stdout)
          json = isRecord(parsed) ? parsed : null
        } catch {
          json = null
        }
      }
      return { hook, ...result, json }
    })
  )
  for (const answer of answers) {
    if (typeof answer.json?.systemMessage === 'string')
      ctx.notify({ plugin: answer.hook.pluginName, event, text: answer.json.systemMessage, level: 'info' })
    if (answer.code !== 0 && answer.code !== 2 && !ctx.signal.aborted)
      ctx.notify({
        plugin: answer.hook.pluginName,
        event,
        text: answer.timedOut
          ? `Hook timed out after ${answer.hook.spec.timeoutSec}s.`
          : (answer.stderr.trim() || `Hook exited with code ${answer.code}.`).slice(0, NOTICE_MAX_CHARS),
        level: 'error',
      })
  }
  return answers
}

const specific = (answer: HookAnswer): Record<string, unknown> =>
  isRecord(answer.json?.hookSpecificOutput) ? (answer.json.hookSpecificOutput as Record<string, unknown>) : {}
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined)
/** `continue: false` stops like a block, with its `stopReason`. */
const stopped = (answer: HookAnswer): string | undefined =>
  answer.json?.continue === false ? (text(answer.json.stopReason) ?? 'Stopped by a plugin hook.') : undefined

/**
 * Before a tool runs. A hook can deny it (`permissionDecision: 'deny'`, `decision: 'block'`, exit 2) or rewrite its
 * input (`updatedInput`). `allow` and `ask` never skip Maestrly's own permission: they change nothing here.
 */
export async function runPreToolUse(
  ctx: HookTurnContext,
  toolName: string,
  input: unknown
): Promise<{ block?: string; input: unknown; context: string[] }> {
  const name = claudeToolName(toolName, input)
  const answers = await runEvent(
    ctx,
    'PreToolUse',
    { tool_name: name, tool_input: toClaudeInput(toolName, input) },
    name
  )
  let next = input
  const context: string[] = []
  for (const answer of answers) {
    const out = specific(answer)
    const block =
      (answer.code === 2 ? (text(answer.stderr) ?? 'Blocked by a plugin hook.') : undefined) ??
      (out.permissionDecision === 'deny'
        ? (text(out.permissionDecisionReason) ?? 'Denied by a plugin hook.')
        : undefined) ??
      (answer.json?.decision === 'block' ? (text(answer.json.reason) ?? 'Blocked by a plugin hook.') : undefined) ??
      stopped(answer)
    if (block) return { block, input, context }
    if (isRecord(out.updatedInput)) next = fromClaudeInput(toolName, out.updatedInput, next)
    const extra = text(out.additionalContext)
    if (extra) context.push(extra)
  }
  return { input: next, context }
}

/** After a tool ran (or failed): what hooks report with exit 2, `decision: 'block'` or context reaches the model. */
export async function runPostToolUse(
  ctx: HookTurnContext,
  toolName: string,
  input: unknown,
  output: string,
  failed: boolean
): Promise<{ append: string[] }> {
  const name = claudeToolName(toolName, input)
  const answers = await runEvent(
    ctx,
    failed ? 'PostToolUseFailure' : 'PostToolUse',
    {
      tool_name: name,
      tool_input: toClaudeInput(toolName, input),
      ...(failed ? { error: output } : { tool_response: output }),
    },
    name
  )
  const append: string[] = []
  for (const answer of answers) {
    const out = specific(answer)
    const added =
      (answer.code === 2 ? text(answer.stderr) : undefined) ??
      (answer.json?.decision === 'block' ? text(answer.json.reason) : undefined) ??
      stopped(answer)
    if (added) append.push(added)
    const extra = text(out.additionalContext)
    if (extra) append.push(extra)
  }
  return { append }
}

/** Before a prompt reaches the model: hooks can block it or add context. Plain stdout is context too. */
export async function runUserPromptSubmit(
  ctx: HookTurnContext,
  prompt: string
): Promise<{ block?: string; context: string[] }> {
  const answers = await runEvent(ctx, 'UserPromptSubmit', { prompt })
  const context: string[] = []
  for (const answer of answers) {
    const block =
      (answer.code === 2 ? (text(answer.stderr) ?? 'Blocked by a plugin hook.') : undefined) ??
      (answer.json?.decision === 'block' ? (text(answer.json.reason) ?? 'Blocked by a plugin hook.') : undefined) ??
      stopped(answer)
    if (block) return { block, context }
    if (answer.code !== 0) continue
    const extra = answer.json ? text(specific(answer).additionalContext) : text(answer.stdout)
    if (extra) context.push(extra.trim())
  }
  return { context }
}

/** At a session's start (a new conversation, after clearing, after compacting): hooks add context. */
export async function runSessionStart(
  ctx: HookTurnContext,
  source: 'startup' | 'clear' | 'compact'
): Promise<{ context: string[] }> {
  const answers = await runEvent(ctx, 'SessionStart', { source }, source)
  const context: string[] = []
  for (const answer of answers) {
    if (answer.code === 2 && text(answer.stderr))
      ctx.notify({ plugin: answer.hook.pluginName, event: 'SessionStart', text: answer.stderr.trim(), level: 'info' })
    if (answer.code !== 0) continue
    const extra = answer.json ? text(specific(answer).additionalContext) : text(answer.stdout)
    if (extra) context.push(extra.trim())
  }
  return { context }
}

/** When a turn ends: a hook can keep the agent going with a reason (`decision: 'block'` or exit 2). */
export async function runStop(
  ctx: HookTurnContext,
  stopHookActive: boolean
): Promise<{ continueWith?: string; plugin?: string }> {
  const answers = await runEvent(ctx, 'Stop', { stop_hook_active: stopHookActive })
  for (const answer of answers) {
    if (answer.json?.continue === false) return {}
    const reason =
      (answer.code === 2 ? text(answer.stderr) : undefined) ??
      (answer.json?.decision === 'block' ? text(answer.json.reason) : undefined)
    if (reason) return { continueWith: reason.trim(), plugin: answer.hook.pluginName }
  }
  return {}
}

/** The prompt that keeps the agent going after a Stop hook asked for more. */
export function stopHookPrompt(plugin: string, reason: string): string {
  return `Stop hook feedback from the ${plugin} plugin:\n${reason}`
}

/** Hidden context a hook adds to the prompt, in the channel memory recall uses. */
export function hookContextPart(event: 'SessionStart' | 'UserPromptSubmit', texts: readonly string[]): MessagePart {
  const body = texts.map((item) => item.replaceAll('</maestrly-hook>', '<\\/maestrly-hook>')).join('\n\n')
  return {
    type: 'file',
    id: crypto.randomUUID(),
    name: 'maestrly-hook-context',
    mediaType: 'text/markdown',
    kind: 'text',
    data: `<maestrly-hook event="${event}">\n${body}\n</maestrly-hook>`,
    hidden: true,
  }
}

/** The conversation's latest compaction boundary ('' before any): a new one starts a new hook session. */
export function hookSessionBoundary(messages: readonly ChatMessage[]): string {
  let boundary = ''
  for (const message of messages)
    for (const part of message.parts)
      if (part.type === 'compaction' && isPortableCompactionMarker(part)) boundary = part.id
  return boundary
}

/**
 * Which session-start source a turn has, from where SessionStart hooks last ran: never (a new session), before a
 * clear, or before the latest compaction. `null` when the session already started.
 */
export function sessionStartSource(
  state: ConvUiPrefs['hookSession'],
  boundary: string
): 'startup' | 'clear' | 'compact' | null {
  if (!state) return 'startup'
  if ('cleared' in state) return 'clear'
  return state.boundary === boundary ? null : 'compact'
}

/** Stop hooks keep an agent going at most this many turns in a row. */
export const MAX_STOP_HOOK_CONTINUATIONS = 8
export const shouldContinueAfterStop = (count: number): boolean => count < MAX_STOP_HOOK_CONTINUATIONS

function appendText(output: unknown, extra: string): ToolOutput {
  const normalized = modelOutputToChatToolOutput(output)
  if (typeof normalized === 'string') return `${normalized}\n\n${extra}`
  return { ...normalized, text: `${normalized.text}\n\n${extra}` }
}

/** Marks a tool whose execute already runs the hooks, so a ToolSet handed on to a subagent is not wrapped twice. */
const HOOKED = Symbol('maestrly.pluginHooks')

/**
 * Runs PreToolUse and PostToolUse(Failure) hooks around every tool of a ToolSet, for any runtime that executes it. A
 * denied call fails with the reason (every bridge turns that into a tool error the model reads); text from PostToolUse
 * is appended to the result. Without active hooks the ToolSet is returned unchanged.
 */
export function wrapToolSetWithHooks(tools: ToolSet, ctx: HookTurnContext): ToolSet {
  if (!hooksActive(ctx)) return tools
  const wrapped: ToolSet = {}
  for (const [name, entry] of Object.entries(tools)) {
    const execute = entry.execute
    if (!execute || (entry as { [HOOKED]?: true })[HOOKED]) {
      wrapped[name] = entry
      continue
    }
    const next = {
      ...entry,
      execute: async (input: unknown, options: Parameters<typeof execute>[1]) => {
        const pre = await runPreToolUse(ctx, name, input)
        if (pre.block) throw new Error(`Blocked by plugin hook: ${pre.block}`)
        let output: unknown
        try {
          output = await (execute as (input: unknown, options: unknown) => Promise<unknown>)(pre.input, options)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const post = await runPostToolUse(ctx, name, pre.input, message, true)
          if (post.append.length) throw new Error(`${message}\n\n${post.append.join('\n\n')}`)
          throw error
        }
        const result = modelOutputToChatToolOutput(output)
        const post = await runPostToolUse(
          ctx,
          name,
          pre.input,
          typeof result === 'string' ? result : result.text,
          false
        )
        const extra = [...pre.context, ...post.append]
        return extra.length ? appendText(output, extra.join('\n\n')) : output
      },
    } as typeof entry
    Object.defineProperty(next, HOOKED, { value: true })
    wrapped[name] = next
  }
  return wrapped
}

const transcriptDir = () => path.join(os.tmpdir(), 'maestrly-hook-transcripts')
const safeId = (conversationId: string) => conversationId.replace(/[^A-Za-z0-9_-]/g, '_')

/**
 * Writes the conversation's text as a Claude Code-style JSONL transcript for hooks that read `transcript_path`
 * (owner-only file, rewritten on each use, removed when the turn ends).
 */
export function writeHookTranscript(conversationId: string): string {
  mkdirSync(transcriptDir(), { recursive: true, mode: 0o700 })
  const file = path.join(transcriptDir(), `${safeId(conversationId)}.jsonl`)
  const lines = listConversationContextMessages(conversationId).flatMap((message) => {
    const text = message.parts
      .filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
    if (!text || (message.role !== 'user' && message.role !== 'assistant')) return []
    return [JSON.stringify({ type: message.role, message: { role: message.role, content: [{ type: 'text', text }] } })]
  })
  writeFileSync(file, lines.length ? `${lines.join('\n')}\n` : '', { mode: 0o600 })
  return file
}

export function removeHookTranscript(conversationId: string): void {
  rmSync(path.join(transcriptDir(), `${safeId(conversationId)}.jsonl`), { force: true })
}

/** The hook context of a runner's turn: its mode, its conversation's permission mode, and notices sent to its window. */
export function runnerHookContext(args: {
  conversationId: string
  cwd: string
  mode: ChatBehavior
  signal: AbortSignal
  emit?: (event: ChatStreamEvent) => void
}): HookTurnContext {
  return {
    conversationId: args.conversationId,
    cwd: args.cwd,
    mode: args.mode,
    // Read when a hook runs: the person may change it mid-turn, and a turn without hooks never reads it.
    get permMode() {
      return getConvUiPrefs(args.conversationId).chat?.permMode ?? 'ask'
    },
    signal: args.signal,
    transcriptPath: async () => writeHookTranscript(args.conversationId),
    notify: (notice) => {
      chatDiag({
        kind: 'plugin-hook-notice',
        conv: args.conversationId,
        plugin: notice.plugin,
        event: notice.event,
        level: notice.level,
      })
      args.emit?.({ kind: 'hook-notice', ...notice })
    },
  }
}
