import { describe, expect, it } from 'vitest'
import { execCli, spawnCli, winSpawnArgs } from '../../src/main/platform'

const values = ['a & b', '"; exit 7; #', '$(exit 7)', '`exit 7`', '%PATH%', '!PATH!', 'line\nbreak', '<in>|out']
const args = ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...values]

describe('native executable CLI invocation', () => {
  it('passes metacharacters literally through execFile without shell expansion', async () => {
    const { stdout } = await execCli(process.execPath, args)
    expect(JSON.parse(stdout)).toEqual(values)
  })

  it('passes metacharacters literally through spawn without shell expansion', async () => {
    const child = spawnCli(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout!.on('data', (chunk) => {
      stdout += chunk
    })
    const code = await new Promise<number | null>((resolve, reject) =>
      child.once('error', reject).once('close', resolve)
    )
    expect(code).toBe(0)
    expect(JSON.parse(stdout)).toEqual(values)
  })

  it('does not route a Windows runtime executable with metacharacters through a shell shim', () => {
    const executable = 'C:\\Users\\name & other\\Maestrly App.exe'
    expect(winSpawnArgs(executable, args, 'win32')).toEqual({ file: executable, args })
  })
})
