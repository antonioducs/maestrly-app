/** Which shell the `bash` tool runs commands in, and how the model is told about it. Kept free of heavy imports. */
import path from 'node:path'

export type CommandDialect = 'sh' | 'powershell'

export interface CommandShell {
  kind: 'sh' | 'cmd' | 'powershell'
  /** Executable that receives the command. */
  file: string
  /** Rules used to split the command into permission resources. */
  dialect: CommandDialect
}

/** Windows PowerShell 5.1 ships with every supported Windows; the absolute path avoids a PATH lookup. */
function windowsPowerShellPath(): string {
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/**
 * The shell the `bash` tool runs the agent's commands in: Windows PowerShell 5.1 on Windows (the shell models expect
 * there, and the one the Codex runtime uses for its own commands), `/bin/sh` elsewhere.
 */
export function agentCommandShell(platform: NodeJS.Platform = process.platform): CommandShell {
  if (platform === 'win32') return { kind: 'powershell', file: windowsPowerShellPath(), dialect: 'powershell' }
  return { kind: 'sh', file: '/bin/sh', dialect: 'sh' }
}

/**
 * `/bin/sh`, or `COMSPEC` (cmd.exe) on Windows. Plugin hooks keep it because an approved hook command always ran
 * there and PowerShell would read it differently (`&&`, `%VAR%`); OpenAI `local_shell` keeps it because its argv
 * quoting targets cmd.exe.
 */
export function systemCommandShell(platform: NodeJS.Platform = process.platform): CommandShell {
  if (platform === 'win32') return { kind: 'cmd', file: process.env.COMSPEC ?? 'cmd.exe', dialect: 'sh' }
  return { kind: 'sh', file: '/bin/sh', dialect: 'sh' }
}

/**
 * Runs the command it reads from stdin, so it reaches PowerShell byte for byte (no command-line quoting or length
 * limit). Output is UTF-8. The exit code is the one `exit N` gives, else 0 when the last statement succeeded, else
 * the last native exit code, else 1. Windows PowerShell can turn a native program's stderr lines into errors when its
 * own stderr is redirected; when that is the only failure, the native exit code (0) stands.
 */
const POWERSHELL_BOOTSTRAP = [
  "$ProgressPreference = 'SilentlyContinue'",
  '$__maestrlyUtf8 = New-Object System.Text.UTF8Encoding $false',
  'try { [Console]::OutputEncoding = $__maestrlyUtf8 } catch {}',
  '$OutputEncoding = $__maestrlyUtf8',
  '$__maestrlyReader = New-Object System.IO.StreamReader ([Console]::OpenStandardInput(), $__maestrlyUtf8)',
  '$__maestrlyCommand = $__maestrlyReader.ReadToEnd()',
  '$__maestrlyReader.Dispose()',
  // A command that does not parse runs no part of itself, and its errors point at its own lines.
  '$__maestrlyErrors = $null',
  '[void][System.Management.Automation.Language.Parser]::ParseInput($__maestrlyCommand, [ref]$null, [ref]$__maestrlyErrors)',
  'if ($__maestrlyErrors) {',
  "  foreach ($__maestrlyError in $__maestrlyErrors) { [Console]::Error.WriteLine(('At line:{0} char:{1}: {2}' -f $__maestrlyError.Extent.StartLineNumber, $__maestrlyError.Extent.StartColumnNumber, $__maestrlyError.Message)) }",
  '  exit 1',
  '}',
  '$global:LASTEXITCODE = 0',
  '$global:__maestrlyOk = $true',
  'try {',
  '  $__maestrlyBlock = [ScriptBlock]::Create($__maestrlyCommand + "`n" + \'$global:__maestrlyOk = $?\')',
  // Formatted output (tables, lists) waits in the host's formatter; the bootstrap's own `exit` would drop it.
  '  & $__maestrlyBlock | Out-Default',
  '} catch {',
  '  [Console]::Error.WriteLine(($_ | Out-String).TrimEnd())',
  '  exit 1',
  '}',
  'if ($global:__maestrlyOk) { exit 0 }',
  'if ($LASTEXITCODE) { exit $LASTEXITCODE }',
  "if ($Error.Count -gt 0 -and $Error[0].FullyQualifiedErrorId -like 'NativeCommandError*') { exit 0 }",
  'exit 1',
].join('\n')

/** Arguments for powershell.exe; the command itself goes to stdin. */
export const POWERSHELL_ARGS: readonly string[] = [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  // With stdin redirected, PowerShell would otherwise write its errors to stderr as CLIXML.
  '-OutputFormat',
  'Text',
  // Process scope only: lets `npm`, `npx` and project scripts that resolve to .ps1 files run.
  '-ExecutionPolicy',
  'Bypass',
  '-EncodedCommand',
  Buffer.from(POWERSHELL_BOOTSTRAP, 'utf16le').toString('base64'),
]

/** Tells the model which shell runs `bash` commands, for the environment line of every runtime's prompt. */
export function commandShellEnvironment(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32')
    return 'Shell: the `bash` tool runs commands in Windows PowerShell 5.1, not bash or cmd.exe; use PowerShell syntax, and `cmd /c "..."` for cmd.exe commands.'
  return 'Shell: the `bash` tool runs commands with /bin/sh (POSIX sh).'
}

export function bashToolDescription(platform: NodeJS.Platform = process.platform): string {
  const use = 'Use it for builds, tests, git and inspecting the project.'
  if (platform === 'win32')
    return [
      'Runs a command in Windows PowerShell 5.1 (powershell.exe -NoProfile -NonInteractive), not bash or cmd.exe, in the conversation directory and returns stdout/stderr.',
      'Write PowerShell: chain with `;` (`&&` and `||` do not exist in 5.1), read variables with `$env:NAME`, and use cmdlets such as Get-Content, Select-Object -First, Get-ChildItem and Select-String instead of cat, head, ls and grep.',
      'For a cmd.exe command use `cmd /c "..."`; use `bash -lc` only when Git Bash or WSL is installed; `pwsh` runs PowerShell 7 when installed.',
      'Output is UTF-8. The exit code is the one `exit N` gives, else 0 when the last statement succeeded, else the last native exit code, else 1, so ending with `exit $LASTEXITCODE` is not needed (an `exit` can drop the table output just before it).',
      'A program started with Start-Process keeps running after the command and is not stopped with the conversation.',
      use,
    ].join(' ')
  return `Runs a command with /bin/sh (POSIX sh) in the conversation directory and returns stdout/stderr. For bash-only syntax use \`bash -c '...'\`. ${use}`
}
