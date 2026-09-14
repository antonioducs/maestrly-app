import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileService } from '../files/service.js'
import type { TurnHooks } from '../providers/provider.js'
import type { DesktopSession } from './session.js'
import { x11Command } from './input.js'
import { runtimeError } from '../turns/service.js'

export async function captureDesktop(desktop: DesktopSession, files: FileService, observationId: string, hooks: TurnHooks, signal?: AbortSignal) {
  await desktop.ensure()
  const generation = await desktop.generation()
  const directory = await files.safePath('.maestrly/screens', true)
  await mkdir(directory, { recursive: true })
  const temp = await mkdtemp(join(directory, '.capture-'))
  try {
    const output = join(temp, 'screen.png')
    await x11Command('capture', ['--pointer', output], desktop.environment(), signal)
    const bytes = await readFile(output)
    if (bytes.length < 24 || bytes.length > 4 * 1024 * 1024 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(16) !== desktop.width || bytes.readUInt32BE(20) !== desktop.height)
      throw runtimeError('INVALID_SCREENSHOT', 'Unexpected desktop capture dimensions or size')
    if (await desktop.generation() !== generation) throw runtimeError('STALE_OBSERVATION', 'The desktop restarted during capture')
    const path = `.maestrly/screens/${observationId}.png`
    await writeFile(await files.safePath(path, true), bytes, { flag: 'wx', mode: 0o600 })
    const info = await files.stat({ path })
    hooks.emit({ kind: 'file.produced', summary: 'Captura da área de trabalho disponível', detail: { path, name: `${observationId}.png`, size: info.size, digest: info.digest } })
    return { bytes, path, generation, width: desktop.width, height: desktop.height }
  } finally { await rm(temp, { recursive: true, force: true }) }
}
