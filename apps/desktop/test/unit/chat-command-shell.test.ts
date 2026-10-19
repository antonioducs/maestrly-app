import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  fake: false,
  spawns: [] as { file: string; args: string[]; options: any; stdin: string }[],
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const spawn = ((file: string, args: string[], options: any) => {
    if (!h.fake) return actual.spawn(file, args, options)
    const child = new EventEmitter() as any
    const record = { file, args, options, stdin: '' }
    h.spawns.push(record)
    // No pid: nothing is tracked or signalled for a process that does not exist.
    child.pid = undefined
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()
    child.stdin.on('data', (chunk: Buffer) => (record.stdin += chunk.toString('utf8')))
    child.stdin.on('finish', () => {
      child.stdout.end('done')
      child.stderr.end()
      setImmediate(() => child.emit('close', 0))
    })
    if (options.stdio?.[0] !== 'pipe') child.stdin.end()
    return child
  }) as typeof actual.spawn
  return { ...actual, spawn, default: { ...actual, spawn } }
})

import { bashTool, commandSegments } from '../../src/main/chat/tools/bash'
import {
  agentCommandShell,
  bashToolDescription,
  commandShellEnvironment,
  POWERSHELL_ARGS,
  systemCommandShell,
} from '../../src/main/chat/tools/command-shell'
import type { ToolContext } from '../../src/main/chat/tools/util'

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const pretend = (value: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value, configurable: true })

function context(cwd: string, ask = vi.fn(async () => {})): ToolContext {
  return {
    conversationId: 'shell-test',
    projectId: 'p1',
    messageId: 'm1',
    toolCallId: 't1',
    cwd,
    signal: new AbortController().signal,
    ask,
    askQuestion: async () => [],
  }
}

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'chat-command-shell-'))
})
afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform)
  vi.unstubAllEnvs()
  h.fake = false
  h.spawns = []
  rmSync(dir, { recursive: true, force: true })
})

describe('the shell the bash tool runs in', () => {
  it('is Windows PowerShell 5.1 on Windows and /bin/sh elsewhere', () => {
    vi.stubEnv('SystemRoot', 'D:\\Win')
    expect(agentCommandShell('win32')).toEqual({
      kind: 'powershell',
      file: 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      dialect: 'powershell',
    })
    expect(agentCommandShell('linux')).toEqual({ kind: 'sh', file: '/bin/sh', dialect: 'sh' })
    expect(agentCommandShell('darwin')).toEqual({ kind: 'sh', file: '/bin/sh', dialect: 'sh' })
  })

  it('keeps cmd.exe for plugin hooks and local_shell on Windows', () => {
    vi.stubEnv('COMSPEC', 'C:\\Windows\\system32\\cmd.exe')
    expect(systemCommandShell('win32')).toMatchObject({ kind: 'cmd', file: 'C:\\Windows\\system32\\cmd.exe' })
    expect(systemCommandShell('linux')).toMatchObject({ kind: 'sh', file: '/bin/sh' })
  })

  it('tells the model about PowerShell on Windows, and how to reach cmd.exe', () => {
    pretend('win32')
    for (const text of [bashToolDescription(), commandShellEnvironment()]) {
      expect(text).toContain('Windows PowerShell 5.1')
      expect(text).toContain('not bash or cmd.exe')
      expect(text).toContain('cmd /c')
    }
    expect(bashToolDescription()).toContain('`&&` and `||` do not exist')
    expect(bashToolDescription()).toContain('$env:NAME')
  })

  it.each(['linux', 'darwin'] as const)('tells the model about /bin/sh on %s', (platform) => {
    pretend(platform)
    for (const text of [bashToolDescription(), commandShellEnvironment()]) {
      expect(text).toContain('/bin/sh')
      expect(text).not.toContain('PowerShell')
    }
  })

  it('starts PowerShell without a profile or prompts, and reads the command from stdin as UTF-8', () => {
    expect(POWERSHELL_ARGS.slice(0, -1)).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-OutputFormat',
      'Text',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
    ])
    const bootstrap = Buffer.from(POWERSHELL_ARGS.at(-1)!, 'base64').toString('utf16le')
    expect(bootstrap).toContain('[Console]::OpenStandardInput()')
    expect(bootstrap).toContain('[Console]::OutputEncoding = $__maestrlyUtf8')
    expect(bootstrap).toContain('if ($LASTEXITCODE) { exit $LASTEXITCODE }')
    expect(bootstrap).toContain('Language.Parser]::ParseInput($__maestrlyCommand')
  })
})

describe('bash tool command assembly', () => {
  it('passes the command to powershell.exe on stdin on Windows, never on its command line', async () => {
    pretend('win32')
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    h.fake = true
    const command = `"$env:COMPUTERNAME ok" | Set-Content qa-check.txt\nGet-Content qa-check.txt\nGet-Location`
    const ask = vi.fn(async () => {})

    const result = await bashTool.execute({ command }, context(dir, ask))

    expect(h.spawns).toHaveLength(1)
    const [run] = h.spawns
    expect(run.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(run.args).toEqual([...POWERSHELL_ARGS])
    expect(run.args.join(' ')).not.toContain('COMPUTERNAME')
    expect(run.options).toMatchObject({ cwd: dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    expect(run.options.shell).toBeUndefined()
    expect(run.stdin).toBe(command)
    expect(result).toMatchObject({ exitCode: 0, output: 'done' })
    expect(ask).toHaveBeenCalledWith(
      'bash',
      ['"$env:COMPUTERNAME ok"', 'Set-Content qa-check.txt', 'Get-Content qa-check.txt', 'Get-Location'],
      expect.any(Array),
      command
    )
  })

  it('keeps the command line for /bin/sh elsewhere', async () => {
    pretend('linux')
    h.fake = true

    await bashTool.execute({ command: 'echo hi' }, context(dir))

    expect(h.spawns[0]).toMatchObject({ file: 'echo hi', args: [] })
    expect(h.spawns[0].options).toMatchObject({ shell: '/bin/sh', detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  })
})

describe('PowerShell permission segments', () => {
  const ps = (command: string) => commandSegments(command, 'powershell')

  it('splits statements and pipelines', () => {
    expect(ps('Get-ChildItem | Select-Object -First 5; Remove-Item x')).toEqual([
      'Get-ChildItem',
      'Select-Object -First 5',
      'Remove-Item x',
    ])
    expect(ps('npm test\r\nRemove-Item x')).toEqual(['npm test', 'Remove-Item x'])
    expect(ps('& git status')).toEqual(['git status'])
    expect(ps('npm test 2>&1 | Select-String fail')).toEqual(['npm test 2>&1', 'Select-String fail'])
    expect(ps('git fetch *>&1; & git status')).toEqual(['git fetch *>&1', 'git status'])
  })

  it('reads a backslash as a plain character and the backtick as the escape', () => {
    expect(ps('echo "C:\\dir\\"; Remove-Item -Recurse x')).toEqual(['echo "C:\\dir\\"', 'Remove-Item -Recurse x'])
    expect(ps('echo `; Remove-Item x')).toEqual(['echo `; Remove-Item x'])
    expect(ps('echo "a`"; b"')).toEqual(['echo "a`"; b"'])
  })

  it('closes strings on the typographic quotes PowerShell accepts', () => {
    expect(ps('echo "abc”; Remove-Item x; “"')).toEqual(['echo "abc”', 'Remove-Item x', '“"'])
    expect(ps("echo 'abc’; Remove-Item x")).toEqual(["echo 'abc’", 'Remove-Item x'])
  })

  it('treats here-strings as one string and still gates their subexpressions', () => {
    const literal = "Set-Content f @'\n\" ; Remove-Item x\n'@; Get-Item f"
    expect(ps(literal)).toEqual(["Set-Content f @'\n\" ; Remove-Item x\n'@", 'Get-Item f'])
    const expanding = 'Set-Content f @"\n"\n$(Remove-Item x)\n"@'
    expect(ps(expanding)).toEqual(['Remove-Item x', expanding])
  })

  it('finds the end of a subexpression past parentheses inside its strings', () => {
    expect(ps("echo $(echo ')'); Remove-Item x")).toEqual(["echo ')'", "echo $(echo ')')", 'Remove-Item x'])
    expect(ps('echo "$(whoami)"')).toEqual(['whoami', 'echo "$(whoami)"'])
  })
})

// Runs on the Windows CI runners: proves the agent's commands really reach PowerShell, with the exit code it reports.
describe.runIf(process.platform === 'win32')('bash tool on a real Windows PowerShell', () => {
  const run = async (command: string) => {
    const result = await bashTool.execute({ command }, context(dir))
    return { ...result, text: bashTool.toModelText({ command }, result) }
  }

  it('runs a PowerShell pipeline sent as one command', async () => {
    const result = await run(
      `"$env:COMPUTERNAME ok" | Set-Content qa-check.txt\nGet-Content qa-check.txt\nGet-Location`
    )
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain(`${process.env.COMPUTERNAME} ok`)
    // Get-Location may print the long form of a short (8.3) temp path, so only the folder name is compared.
    expect(result.output.toLowerCase()).toContain(path.basename(dir).toLowerCase())
    expect(result.output).not.toMatch(/not recognized/i)
  }, 60_000)

  it('keeps non-ASCII text intact both ways', async () => {
    const result = await run("Write-Output 'ação ✓'")
    expect(result.output).toContain('ação ✓')
    // A table waits in PowerShell's formatter; it must still be printed before the command ends.
    expect((await run('Get-Item . | Select-Object Name')).output).toContain(path.basename(dir))
  }, 60_000)

  it('reports the exit code of exit, of the last native command and of a failed cmdlet', async () => {
    expect((await run('exit 3')).exitCode).toBe(3)
    expect((await run('cmd /c exit 5')).exitCode).toBe(5)
    expect((await run('Get-Item does-not-exist-here')).exitCode).toBe(1)
    expect((await run("throw 'boom'")).exitCode).toBe(1)
    expect((await run('cmd /c exit 4; Write-Output fine')).exitCode).toBe(0)
  }, 120_000)

  it('does not fail a native command that only writes to stderr', async () => {
    const result = await run('cmd /c "echo progress 1>&2"')
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('progress')
  }, 60_000)

  // Each command hides a `Set-Content hit`: if PowerShell runs it, the permission gate must have shown it as a segment
  // of its own or refused to read the command.
  it.each([
    "Write-Output $(Write-Output ')'); Set-Content hit 1",
    "Write-Output a # '\nSet-Content hit 1 #'",
    "Write-Output a <# ' #> ; Set-Content hit 1 ; <# ' #>",
    'Write-Output (Set-Content hit 1)',
    'Write-Output @(Set-Content hit 1)',
    'Write-Output "$(Set-Content hit 1)"',
    'Write-Output a; & { Set-Content hit 1 }',
    'Write-Output @{ a = $(Set-Content hit 1) }',
    "Write-Output --% '\nSet-Content hit 1 # '",
    "Write-Output a#'\nSet-Content hit 1 #'",
    'Write-Output a`; Set-Content hit 1',
    "Write-Output 'a''; Set-Content hit 1'",
    'Write-Output @"\n"@ ; Set-Content hit 1 ; @"\n"@',
  ])(
    'shows every command PowerShell runs in %j',
    async (command) => {
      const segments = commandSegments(command, 'powershell')
      await run(command)
      if (existsSync(path.join(dir, 'hit')) && segments)
        expect(segments.some((segment) => segment.startsWith('Set-Content hit'))).toBe(true)
    },
    60_000
  )

  it('reports a parse error instead of running part of the command', async () => {
    const result = await run("Write-Output 'never'\nif (")
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('At line:2')
    expect(result.output).not.toContain('never')
  }, 60_000)
})
