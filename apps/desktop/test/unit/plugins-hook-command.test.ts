import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runHookCommand } from '../../src/main/plugins/hook-command'

const dir = mkdtempSync(path.join(os.tmpdir(), 'plg-hook-cmd-'))
const script = (name: string, body: string) => {
  const file = path.join(dir, name)
  writeFileSync(file, body)
  return `node ${JSON.stringify(file)}`
}

describe('hook command runner', () => {
  it('passes stdin and the hook environment, and returns stdout with the exit code', async () => {
    const command = script(
      'echo.mjs',
      "let input = ''\nprocess.stdin.on('data', (c) => (input += c))\nprocess.stdin.on('end', () => { process.stdout.write(JSON.stringify({ input: JSON.parse(input), root: process.env.PLUGIN_ROOT })) })\n"
    )
    const result = await runHookCommand({
      command,
      cwd: dir,
      env: { PLUGIN_ROOT: '/synthetic/root' },
      stdin: JSON.stringify({ hook_event_name: 'Stop' }),
      timeoutMs: 10_000,
    })
    expect(result.code).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(JSON.parse(result.stdout)).toEqual({ input: { hook_event_name: 'Stop' }, root: '/synthetic/root' })
  })

  it('reports exit 2 with its stderr', async () => {
    const command = script('block.mjs', "process.stderr.write('not allowed')\nprocess.exit(2)\n")
    const result = await runHookCommand({ command, cwd: dir, env: {}, stdin: '{}', timeoutMs: 10_000 })
    expect(result).toMatchObject({ code: 2, stderr: 'not allowed', timedOut: false })
  })

  it('stops a command that runs past its timeout', async () => {
    const command = script('slow.mjs', 'setTimeout(() => {}, 60_000)\n')
    const started = Date.now()
    const result = await runHookCommand({ command, cwd: dir, env: {}, stdin: '{}', timeoutMs: 200 })
    expect(result.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})
