import { it, expect } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { SerialPort } from '../src/control/serial-port.js'

it.skipIf(process.platform === 'win32')('reopens idle POSIX ports without trapping filesystem workers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'serial-port-test-'))
  try {
    for (let i = 0; i < 12; i++) {
      const path = join(dir, String(i))
      execFileSync('mkfifo', [path])
      const port = await SerialPort.open(path)
      port.resume()
      await new Promise(resolve => setTimeout(resolve, 20))
      const closed = once(port, 'close')
      port.destroy()
      await closed
      expect(await readFile(new URL('../package.json', import.meta.url), 'utf8')).toContain('bot-runtime')
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
}, 5000)
