import fs from 'node:fs/promises'
import path from 'node:path'
import { openai } from '@ai-sdk/openai'
import type { ToolSet } from 'ai'
import type { ChatHarnessCapabilities } from '../harness'
import { bashTool } from '../tools/bash'
import {
  boundText,
  detectEnding,
  hasUtf8Bom,
  resolveInside,
  stripBom,
  toEnding,
  withFileLock,
  type ToolContext,
} from '../tools/util'
import { applyV4ADiff } from './v4a-diff'

export const OPENAI_LOCAL_SHELL_TOOL_NAME = 'local_shell'
export const OPENAI_APPLY_PATCH_TOOL_NAME = 'apply_patch'
export const OPENAI_NATIVE_PERMISSION_DENIED_PREFIX = 'Maestrly permission denied: '
export const OPENAI_NATIVE_TOOL_FAILED_PREFIX = 'Maestrly tool failed: '

export type OpenAINativeOutcome = 'denied' | 'failed'
const openAINativeOutcomes = new WeakMap<object, OpenAINativeOutcome>()

const MAX_SHELL_TIMEOUT_MS = 600_000
const MAX_DIFF_BYTES = 10 * 1024 * 1024

type MakeToolContext = (toolCallId: string, signal: AbortSignal) => ToolContext

interface LocalShellInput {
  action: {
    type: 'exec'
    command: string[]
    timeoutMs?: number
    user?: string
    workingDirectory?: string
    env?: Record<string, string>
  }
}

export type OpenAIApplyPatchOperation =
  | { type: 'create_file'; path: string; diff: string }
  | { type: 'update_file'; path: string; diff: string }
  | { type: 'delete_file'; path: string }

interface ApplyPatchInput {
  callId: string
  operation: OpenAIApplyPatchOperation
}

export interface BuildOpenAINativeToolsOptions {
  cwd: string
  capabilities: Pick<ChatHarnessCapabilities, 'nativeShell' | 'nativeApplyPatch'>
  makeCtx: MakeToolContext
}

const abortSignalFor = (signal?: AbortSignal): AbortSignal => signal ?? new AbortController().signal

export function isOpenAINativeToolName(toolName: string): boolean {
  return toolName === OPENAI_LOCAL_SHELL_TOOL_NAME || toolName === OPENAI_APPLY_PATCH_TOOL_NAME
}

export function isOpenAIPermissionDenial(error: unknown): boolean {
  const name = error instanceof Error ? error.name : ''
  return ['PermissionDeniedError', 'PermissionRejectedError', 'PermissionCorrectedError'].includes(name)
}

export function isOpenAIAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/** Restores the process-local outcome tag after a durable JSON output is loaded. */
export function markOpenAINativeToolOutput<T extends object>(output: T, outcome: OpenAINativeOutcome): T {
  openAINativeOutcomes.set(output, outcome)
  return output
}

export function openAINativeFailureOutput(
  toolName: string,
  error: unknown,
  denied = isOpenAIPermissionDenial(error)
): { output: string } | { status: 'failed'; output: string } | null {
  if (!isOpenAINativeToolName(toolName)) return null
  const message = error instanceof Error ? error.message : String(error)
  const output = (denied ? OPENAI_NATIVE_PERMISSION_DENIED_PREFIX : OPENAI_NATIVE_TOOL_FAILED_PREFIX) + message
  const result = toolName === OPENAI_APPLY_PATCH_TOOL_NAME ? { status: 'failed' as const, output } : { output }
  // Provider-defined output schemas are closed. Keep the outcome outside the live result object:
  // execution/UI code can classify it, while persistence and the Responses wire receive only
  // the schema-valid status/output fields.
  return markOpenAINativeToolOutput(result, denied ? 'denied' : 'failed')
}

export function isOpenAINativePermissionDeniedOutput(toolName: string, output: unknown): boolean {
  if (!isOpenAINativeToolName(toolName) || output == null || typeof output !== 'object') return false
  return openAINativeOutcomes.get(output) === 'denied'
}

export function isOpenAINativeFailedOutput(toolName: string, output: unknown): boolean {
  if (!isOpenAINativeToolName(toolName) || output == null || typeof output !== 'object') return false
  return openAINativeOutcomes.get(output) === 'failed'
}

export function openAINativeOutputText(output: unknown): string | null {
  if (output == null || typeof output !== 'object') return null
  const text = (output as { output?: unknown }).output
  return typeof text === 'string' ? text : null
}

function shellQuotePosix(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

/** Windows quoting follows CommandLineToArgvW rules; cmd expansion tokens are rejected separately. */
function shellQuoteWindows(value: string): string {
  if (/[%!"\0\r\n]/.test(value)) {
    throw new Error('local_shell arguments containing %, !, quotes, NUL or newlines are not supported on Windows')
  }
  if (value !== '' && !/[\s&|<>^()]/.test(value)) return value

  let output = '"'
  let backslashes = 0
  for (const character of value) {
    if (character === '\\') {
      backslashes += 1
      continue
    }
    output += '\\'.repeat(backslashes) + character
    backslashes = 0
  }
  return output + '\\'.repeat(backslashes * 2) + '"'
}

/** Converts local_shell argv to one injection-safe command string for the existing bash executor. */
export function quoteOpenAILocalShellCommand(
  command: readonly string[],
  platform: NodeJS.Platform = process.platform
): string {
  if (command.length === 0) throw new Error('local_shell command cannot be empty')
  if (command.some((argument) => argument.includes('\0'))) {
    throw new Error('local_shell command arguments cannot contain NUL bytes')
  }
  const quote = platform === 'win32' ? shellQuoteWindows : shellQuotePosix
  return command.map(quote).join(' ')
}

async function executeLocalShell(
  input: LocalShellInput,
  toolCallId: string,
  signal: AbortSignal,
  makeCtx: MakeToolContext
): Promise<{ output: string }> {
  signal.throwIfAborted()
  if (input.action.type !== 'exec') throw new Error('Unsupported local_shell action')
  if (input.action.user != null) {
    throw new Error('local_shell user switching is not supported by the Maestrly permission boundary')
  }
  if (input.action.env != null) {
    throw new Error('local_shell environment overrides are not supported by the Maestrly permission boundary')
  }
  const timeout = input.action.timeoutMs
  if (timeout != null && (!Number.isInteger(timeout) || timeout <= 0 || timeout > MAX_SHELL_TIMEOUT_MS)) {
    throw new Error(`local_shell timeoutMs must be an integer from 1 to ${MAX_SHELL_TIMEOUT_MS}`)
  }

  const args = {
    command: quoteOpenAILocalShellCommand(input.action.command),
    ...(input.action.workingDirectory != null ? { workdir: input.action.workingDirectory } : {}),
    ...(timeout != null ? { timeout } : {}),
    description: 'OpenAI local_shell command',
  }
  const result = await bashTool.execute(args, makeCtx(toolCallId, signal))
  signal.throwIfAborted()
  return { output: boundText(bashTool.toModelText(args, result), toolCallId) }
}

async function resolveThroughExistingAncestor(target: string): Promise<string> {
  const missingSegments: string[] = []
  let candidate = target
  for (;;) {
    try {
      return path.resolve(await fs.realpath(candidate), ...missingSegments)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return target
      const parent = path.dirname(candidate)
      if (parent === candidate) return target
      missingSegments.unshift(path.basename(candidate))
      candidate = parent
    }
  }
}

async function authorizePatchPath(
  requestedPath: string,
  root: string,
  ctx: ToolContext
): Promise<{ absolute: string; lockKey: string }> {
  if (requestedPath.trim() === '' || requestedPath.includes('\0')) {
    throw new Error('apply_patch path must be a non-empty filesystem path')
  }

  const lexical = resolveInside(root, requestedPath)
  if (path.resolve(lexical.abs) === path.resolve(root)) {
    throw new Error('apply_patch cannot target the workspace root')
  }

  const canonical = await resolveThroughExistingAncestor(lexical.abs)
  const canonicalRoot = await fs.realpath(root).catch(() => root)
  const external = new Set<string>()
  if (lexical.external) external.add(lexical.abs)
  if (resolveInside(canonicalRoot, canonical).external) external.add(canonical)
  if (external.size > 0) {
    const resources = [...external]
    await ctx.ask('external_directory', resources, resources)
  }
  await ctx.ask('edit', [lexical.abs], ['*'])
  return { absolute: lexical.abs, lockKey: canonical }
}

function assertDiffSize(diff: string): void {
  if (Buffer.byteLength(diff, 'utf8') > MAX_DIFF_BYTES) {
    throw new Error(`apply_patch diff exceeds the ${MAX_DIFF_BYTES} byte safety limit`)
  }
}

async function createFile(
  operation: Extract<OpenAIApplyPatchOperation, { type: 'create_file' }>,
  root: string,
  ctx: ToolContext
): Promise<string> {
  assertDiffSize(operation.diff)
  const target = await authorizePatchPath(operation.path, root, ctx)
  const content = applyV4ADiff('', operation.diff, 'create')

  return withFileLock(target.lockKey, async () => {
    await fs.mkdir(path.dirname(target.absolute), { recursive: true })
    await fs.writeFile(target.absolute, content, { encoding: 'utf8', flag: 'wx' }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`Cannot create existing file: ${operation.path}`)
      }
      throw error
    })
    return `Created ${operation.path}`
  })
}

async function updateFile(
  operation: Extract<OpenAIApplyPatchOperation, { type: 'update_file' }>,
  root: string,
  ctx: ToolContext
): Promise<string> {
  assertDiffSize(operation.diff)
  const target = await authorizePatchPath(operation.path, root, ctx)

  return withFileLock(target.lockKey, async () => {
    const original = await fs.readFile(target.absolute).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Cannot update missing file: ${operation.path}`)
      }
      throw error
    })
    const hadBom = hasUtf8Bom(original)
    const text = stripBom(original.toString('utf8'))
    const ending = detectEnding(text)
    const patchedLf = applyV4ADiff(toEnding(text, '\n'), operation.diff)
    const patched = (hadBom ? '\ufeff' : '') + toEnding(patchedLf, ending)

    const current = await fs.readFile(target.absolute)
    if (!current.equals(original)) {
      throw new Error('The file changed while applying the patch. Read it again before editing.')
    }
    await fs.writeFile(target.absolute, patched, 'utf8')
    return `Updated ${operation.path}`
  })
}

async function deleteFile(
  operation: Extract<OpenAIApplyPatchOperation, { type: 'delete_file' }>,
  root: string,
  ctx: ToolContext
): Promise<string> {
  const target = await authorizePatchPath(operation.path, root, ctx)
  return withFileLock(target.lockKey, async () => {
    const stat = await fs.lstat(target.absolute).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Cannot delete missing file: ${operation.path}`)
      }
      throw error
    })
    if (stat.isDirectory()) throw new Error(`apply_patch refuses to delete directories: ${operation.path}`)
    await fs.unlink(target.absolute)
    return `Deleted ${operation.path}`
  })
}

export async function applyOpenAIPatchOperation(
  operation: OpenAIApplyPatchOperation,
  root: string,
  ctx: ToolContext
): Promise<string> {
  ctx.signal.throwIfAborted()
  if (operation.type === 'create_file') return createFile(operation, root, ctx)
  if (operation.type === 'update_file') return updateFile(operation, root, ctx)
  if (operation.type === 'delete_file') return deleteFile(operation, root, ctx)
  throw new Error('Unsupported apply_patch operation')
}

/** Builds provider-defined tools only for capabilities enabled by the selected OpenAI model. */
export function buildOpenAINativeTools(options: BuildOpenAINativeToolsOptions): ToolSet {
  const root = path.resolve(options.cwd)
  const tools: ToolSet = {}
  const makeRootedCtx: MakeToolContext = (toolCallId, signal) => ({
    ...options.makeCtx(toolCallId, signal),
    cwd: root,
  })

  if (options.capabilities.nativeShell) {
    tools[OPENAI_LOCAL_SHELL_TOOL_NAME] = openai.tools.localShell({
      execute: async (input, execution) => {
        try {
          return await executeLocalShell(
            input,
            execution.toolCallId,
            abortSignalFor(execution.abortSignal),
            makeRootedCtx
          )
        } catch (error) {
          if (isOpenAIAbortError(error)) throw error
          return openAINativeFailureOutput(OPENAI_LOCAL_SHELL_TOOL_NAME, error) as { output: string }
        }
      },
    })
  }

  if (options.capabilities.nativeApplyPatch) {
    tools[OPENAI_APPLY_PATCH_TOOL_NAME] = openai.tools.applyPatch({
      execute: async (input: ApplyPatchInput, execution) => {
        try {
          if (input.callId !== execution.toolCallId) {
            throw new Error(
              `apply_patch callId mismatch: payload ${input.callId} does not match execution ${execution.toolCallId}`
            )
          }
          const signal = abortSignalFor(execution.abortSignal)
          const ctx = makeRootedCtx(execution.toolCallId, signal)
          const output = await applyOpenAIPatchOperation(input.operation, root, ctx)
          return { status: 'completed' as const, output }
        } catch (error) {
          if (isOpenAIAbortError(error)) throw error
          return openAINativeFailureOutput(OPENAI_APPLY_PATCH_TOOL_NAME, error) as {
            status: 'failed'
            output: string
          }
        }
      },
    })
  }

  return tools
}
