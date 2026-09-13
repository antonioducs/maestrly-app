import { spawn } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { JsonChannel } from '../../qmp.js'
/** Actually creates an HVF machine; advertising an accelerator is insufficient. */
export async function probeHvf(executable: string, arch: 'arm64' | 'x64', timeoutMs = 5000) {
  const directory = await realpath(await mkdtemp('/tmp/mh-probe-'))
  const socket = join(directory, 'qmp')
  let channel: JsonChannel | undefined
  let failure: Error | undefined
  let exited = false
  const child = spawn(
    executable,
    [
      '-S',
      '-nodefaults',
      '-nic',
      'none',
      '-display',
      'none',
      '-machine',
      arch === 'arm64' ? 'virt,accel=hvf' : 'q35,accel=hvf',
      '-cpu',
      'host',
      '-m',
      '256',
      '-qmp',
      `unix:${socket},server=on,wait=off`,
    ],
    { stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } }
  )
  child.on('error', (error) => {
    failure = error
    exited = true
  })
  child.on('exit', () => {
    exited = true
  })
  let probeError: unknown
  let cleanupError: Error | undefined
  try {
    const deadline = Date.now() + timeoutMs
    while (!channel && Date.now() < deadline && !exited) {
      try {
        channel = await JsonChannel.open(socket, true, 500)
      } catch {}
      if (!channel) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    if (!channel) throw failure ?? new Error('HVF smoke failed to expose QMP')
    const status = await channel.command('query-status')
    if (status.running !== false || !['prelaunch', 'paused'].includes(status.status))
      throw new Error('HVF smoke did not create a paused machine')
    await channel.command('quit').catch(() => {})
    while (!exited && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
    if (!exited) throw new Error('HVF smoke did not exit after QMP quit')
  } catch (error) {
    probeError = error
  } finally {
    if (!exited) await channel?.command('quit').catch(() => {})
    channel?.close()
    // Explicit probe-only cleanup policy: this freshly spawned child owns no guest
    // disk. Never leave failed capability probes consuming Host memory indefinitely.
    if (!exited) child.kill('SIGTERM')
    let stopDeadline = Date.now() + 1000
    while (!exited && Date.now() < stopDeadline) await new Promise((resolve) => setTimeout(resolve, 25))
    if (!exited) child.kill('SIGKILL')
    stopDeadline = Date.now() + 1000
    while (!exited && Date.now() < stopDeadline) await new Promise((resolve) => setTimeout(resolve, 25))
    if (exited) await rm(directory, { recursive: true, force: true })
    else cleanupError = new Error('HVF probe process exit unproven; diagnostic directory retained')
  }
  if (cleanupError) throw cleanupError
  if (probeError) throw probeError
}
