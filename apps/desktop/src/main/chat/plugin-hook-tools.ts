/**
 * Plugin hooks are written for Claude Code: they match its tool names (`Bash`, `Edit|Write`) and read its inputs
 * (`file_path`, `old_string`). Maestrly's tools are the same tools under other names, so hooks see them translated, and
 * an input a hook rewrites is translated back.
 */

const TOOL_NAMES: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  grep: 'Grep',
  glob: 'Glob',
  webfetch: 'WebFetch',
  task: 'Task',
  todo_write: 'TodoWrite',
  local_shell: 'Bash',
  apply_patch: 'Edit',
}

/** Maestrly input field → Claude Code input field, per tool. */
const FIELDS: Record<string, Record<string, string>> = {
  read: { path: 'file_path' },
  write: { path: 'file_path' },
  edit: { path: 'file_path', oldString: 'old_string', newString: 'new_string', replaceAll: 'replace_all' },
  grep: { include: 'glob' },
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** The Claude Code name of a Maestrly tool: external MCP tools (`<server>__<tool>`) become `mcp__<server>__<tool>`. */
export function claudeToolName(maestrlyName: string, input?: unknown): string {
  if (
    maestrlyName === 'mcp_call' &&
    isRecord(input) &&
    typeof input.server === 'string' &&
    typeof input.tool === 'string'
  )
    return `mcp__${input.server}__${input.tool}`
  if (TOOL_NAMES[maestrlyName]) return TOOL_NAMES[maestrlyName]
  return maestrlyName.includes('__') ? `mcp__${maestrlyName}` : maestrlyName
}

function rename(input: unknown, fields: Record<string, string> | undefined): unknown {
  if (!fields || !isRecord(input)) return input
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [fields[key] ?? key, value]))
}

/** The input a hook sees, in Claude Code's shape. */
export function toClaudeInput(maestrlyName: string, input: unknown): unknown {
  if (maestrlyName === 'local_shell' && isRecord(input) && isRecord(input.action)) {
    const command = input.action.command
    return { command: Array.isArray(command) ? command.join(' ') : String(command ?? '') }
  }
  if (maestrlyName === 'mcp_call' && isRecord(input)) return input.arguments ?? {}
  return rename(input, FIELDS[maestrlyName])
}

/** A hook's rewritten input, back in the Maestrly tool's shape. */
export function fromClaudeInput(maestrlyName: string, input: unknown, original?: unknown): unknown {
  if (maestrlyName === 'local_shell' && isRecord(original) && isRecord(original.action) && isRecord(input))
    return {
      ...original,
      action: {
        ...original.action,
        command: typeof input.command === 'string' ? ['/bin/sh', '-c', input.command] : original.action.command,
      },
    }
  if (maestrlyName === 'mcp_call' && isRecord(original)) return { ...original, arguments: input }
  const fields = FIELDS[maestrlyName]
  if (!fields) return input
  const back = Object.fromEntries(Object.entries(fields).map(([maestrly, claude]) => [claude, maestrly]))
  return rename(input, back)
}
