import { probeHvf } from './probe.js'
import { randomUUID } from 'node:crypto'
import {
  bootSession,
  processStart,
  saveLaunch,
  readLaunch,
  launchGone,
  cleanLaunch,
  type Launch,
} from '../../persistence/launch.js'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, rm, statfs } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Vm, VerifyResult } from '@maestrly/host-protocol'
import { verifyAsset, type Asset } from '../../assets.js'
import { buildQemuArgs, type VmPaths } from './arguments.js'
import { JsonChannel } from './qmp.js'
import { writeNoCloudSeed } from '../../seed.js'
import { verifyGuest } from './guest-agent.js'
const execute = promisify(execFile)
export interface Runtime {
  id: string
  arch: 'arm64' | 'x64'
  qemu: Asset
  qemuImg: Asset
  firmware?: Asset
  firmwareVars?: Asset
}
export interface Image {
  id: string
  name: string
  arch: 'arm64' | 'x64'
  asset: Asset
  format: 'qcow2' | 'raw'
  virtualSizeGiB: number /** Must contain cloud-init and qemu-guest-agent already installed. */
  guestAgent: true
}
export interface Provider {
  logs?(vm: Vm): Promise<string[]>
  inspectRuntime(runtime: Runtime): Promise<{ available: boolean; reason?: string }>
  provision(vm: Vm, runtime: Runtime, image: Image, signal: AbortSignal): Promise<void>
  inspect(vm: Vm): Promise<'running' | 'stopped' | 'unknown'>
  start(vm: Vm, runtime: Runtime, signal: AbortSignal): Promise<void>
  shutdown(vm: Vm, signal: AbortSignal): Promise<void>
  restart(vm: Vm, signal: AbortSignal): Promise<void>
  remove(vm: Vm, signal: AbortSignal): Promise<void>
  waitReady(vm: Vm, signal: AbortSignal): Promise<VerifyResult>
  verify(vm: Vm, mode: 'write-marker' | 'read-marker', signal: AbortSignal): Promise<VerifyResult>
}
function pause(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(done, ms)
    function done() {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    function abort() {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}
export class QemuProvider implements Provider {
  constructor(
    private readonly stateDirectory: string,
    private readonly timeoutMs = 60_000
  ) {
    if (process.getuid?.() === 0) throw new Error('QEMU provider must run as a nonroot user')
  }
  paths(vm: Vm): VmPaths {
    if (!/^[a-f0-9-]{36}$/i.test(vm.id)) throw new Error('Invalid VM identity')
    const directory = join(this.stateDirectory, 'vms', vm.id)
    const paths = {
      directory,
      disk: join(directory, 'disk.qcow2'),
      seed: join(directory, 'seed.img'),
      qmp: join(directory, 'qmp.sock'),
      qga: join(directory, 'qga.sock'),
      firmwareVars: join(directory, 'firmware-vars.fd'),
      log: join(directory, 'qemu.log'),
    }
    // Darwin sockaddr_un is 104 bytes; fail before provisioning if too long.
    if (Buffer.byteLength(paths.qmp) > 100 || /[,\n\r]/.test(directory))
      throw new Error('State directory is too long or unsafe for a private Unix socket')
    return paths
  }
  async inspectRuntime(runtime: Runtime) {
    try {
      if (process.platform !== 'darwin' || process.arch !== runtime.arch)
        throw new Error('Runtime requires macOS with matching native architecture')
      const qemu = await verifyAsset(runtime.qemu, true)
      await verifyAsset(runtime.qemuImg, true)
      if (runtime.arch === 'arm64' && !runtime.firmware) throw new Error('ARM runtime requires verified firmware')
      if (runtime.firmware) await verifyAsset(runtime.firmware)
      if (runtime.firmwareVars) await verifyAsset(runtime.firmwareVars)
      for (const asset of [runtime.qemu, runtime.qemuImg, runtime.firmware, runtime.firmwareVars])
        if (asset && /[,\n\r]/.test(asset.path)) throw new Error('Unsafe runtime asset path')
      const { stdout } = await execute(qemu, ['-accel', 'help'], {
        timeout: 5000,
        maxBuffer: 65536,
      })
      if (!/^hvf\s*$/m.test(stdout)) throw new Error('QEMU does not advertise HVF')
      const probe = await execute('/usr/sbin/sysctl', ['-n', 'kern.hv_support'], {
        timeout: 5000,
        maxBuffer: 1024,
      })
      if (probe.stdout.trim() !== '1') throw new Error('Hypervisor framework unavailable')
      await probeHvf(qemu, runtime.arch)
      return { available: true }
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : 'Runtime unavailable',
      }
    }
  }
  private async requireRuntime(runtime: Runtime) {
    const result = await this.inspectRuntime(runtime)
    if (!result.available) throw new Error(result.reason)
  }
  private async owned(vm: Vm) {
    const p = this.paths(vm)
    const stat = await lstat(p.directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
      throw new Error('VM directory ownership mismatch')
    if ((await realpath(p.directory)) !== resolve(p.directory)) throw new Error('VM directory ownership mismatch')
    const identityStat = await lstat(join(p.directory, 'identity')).catch(() => {
      throw new Error('VM identity mismatch')
    })
    if (
      !identityStat.isFile() ||
      identityStat.isSymbolicLink() ||
      identityStat.size > 128 ||
      identityStat.uid !== process.getuid?.()
    )
      throw new Error('VM identity mismatch')
    if ((await readFile(join(p.directory, 'identity'), 'utf8')) !== vm.identity) throw new Error('VM identity mismatch')
    return p
  }
  async provision(vm: Vm, runtime: Runtime, image: Image, signal: AbortSignal) {
    await this.requireRuntime(runtime)
    signal.throwIfAborted()
    const source = await verifyAsset(image.asset)
    if (image.arch !== runtime.arch || vm.diskGiB < image.virtualSizeGiB)
      throw new Error('Image is incompatible with requested VM')
    const p = this.paths(vm)
    const parent = join(this.stateDirectory, 'vms')
    await mkdir(parent, { recursive: true, mode: 0o700 })
    const parentStat = await lstat(parent)
    if (
      !parentStat.isDirectory() ||
      parentStat.isSymbolicLink() ||
      parentStat.uid !== process.getuid?.() ||
      (await realpath(parent)) !== resolve(parent)
    )
      throw new Error('VM parent ownership mismatch')
    try {
      await lstat(p.directory)
      throw new Error('VM directory already exists')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const space = await statfs(parent)
    if (space.bavail * space.bsize < (vm.diskGiB + 2) * 1024 ** 3) throw new Error('Insufficient disk capacity')
    const stage = p.directory + '.staging'
    await mkdir(stage, { mode: 0o700 })
    try {
      const identity = await open(join(stage, 'identity'), 'wx', 0o600)
      try {
        await identity.writeFile(vm.identity)
        await identity.sync()
      } finally {
        await identity.close()
      }
      // Flatten images, never retain a mutable backing-file dependency. Reject images
      // referring to external files before conversion to prevent unintended host reads.
      const info = await execute(runtime.qemuImg.path, ['info', '--output=json', '-f', image.format, source], {
        timeout: 10000,
        maxBuffer: 65536,
        signal,
      })
      const metadata = JSON.parse(info.stdout)
      if (
        metadata['backing-filename'] ||
        metadata['full-backing-filename'] ||
        metadata['format-specific']?.data?.['data-file']
      )
        throw new Error('External image backing files are forbidden')
      if (metadata['virtual-size'] > vm.diskGiB * 1024 ** 3) throw new Error('Requested disk is smaller than image')
      await execute(
        runtime.qemuImg.path,
        ['convert', '-f', image.format, '-O', 'qcow2', source, join(stage, 'disk.qcow2')],
        { timeout: 300000, maxBuffer: 65536, signal }
      )
      await execute(runtime.qemuImg.path, ['resize', '-f', 'qcow2', join(stage, 'disk.qcow2'), `${vm.diskGiB}G`], {
        timeout: 30000,
        maxBuffer: 65536,
        signal,
      })
      await writeNoCloudSeed(join(stage, 'seed.img'), vm.identity)
      if (runtime.firmwareVars)
        await copyFile(runtime.firmwareVars.path, join(stage, 'firmware-vars.fd'), constants.COPYFILE_EXCL)
      for (const file of ['disk.qcow2', 'seed.img', ...(runtime.firmwareVars ? ['firmware-vars.fd'] : [])]) {
        const handle = await open(join(stage, file), 'r+')
        try {
          await handle.chmod(0o600)
          await handle.sync()
        } finally {
          await handle.close()
        }
      }
      const stageHandle = await open(stage, 'r')
      try {
        await stageHandle.sync()
      } finally {
        await stageHandle.close()
      }
      signal.throwIfAborted()
      await rename(stage, p.directory)
      const parentHandle = await open(parent, 'r')
      try {
        await parentHandle.sync()
      } finally {
        await parentHandle.close()
      }
    } finally {
      await rm(stage, { recursive: true, force: true })
    }
  }
  private async monitor(vm: Vm) {
    const p = await this.owned(vm)
    const socket = await lstat(p.qmp)
    if (!socket.isSocket() || socket.uid !== process.getuid?.()) throw new Error('Monitor socket ownership mismatch')
    const channel = await JsonChannel.open(p.qmp)
    try {
      const uuid = await channel.command('query-uuid')
      if (uuid?.UUID !== vm.identity) throw new Error('Monitor identity mismatch')
      return channel
    } catch (error) {
      channel.close()
      throw error
    }
  }
  async inspect(vm: Vm): Promise<'running' | 'stopped' | 'unknown'> {
    try {
      const monitor = await this.monitor(vm)
      try {
        const status = await monitor.command('query-status')
        return status.running === true ? 'running' : 'unknown'
      } finally {
        monitor.close()
      }
    } catch (error) {
      if (error instanceof Error && /identity mismatch|ownership mismatch/.test(error.message)) return 'unknown'
      const p = this.paths(vm)
      try {
        await this.owned(vm)
        const launch = await readLaunch(p.directory, vm.identity)
        if (!(await launchGone(launch))) return 'unknown'
        await cleanLaunch(p.directory, launch)
        return 'stopped'
      } catch (markerError) {
        if ((markerError as NodeJS.ErrnoException).code !== 'ENOENT') return 'unknown'
      }
      // A known staging directory is an interrupted provision, never replayed.
      try {
        const stage = p.directory + '.staging'
        const stat = await lstat(stage)
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          stat.uid !== process.getuid?.() ||
          (stat.mode & 0o077) !== 0 ||
          (await realpath(stage)) !== resolve(stage)
        )
          return 'unknown'
        try {
          const identityStat = await lstat(join(stage, 'identity'))
          if (
            !identityStat.isFile() ||
            identityStat.isSymbolicLink() ||
            identityStat.size > 128 ||
            (await readFile(join(stage, 'identity'), 'utf8')) !== vm.identity
          )
            return 'unknown'
        } catch {
          return 'unknown'
        }
        await rm(stage, { recursive: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'unknown'
      }
      try {
        await lstat(p.qmp)
        return 'unknown'
      } catch (socketError) {
        return (socketError as NodeJS.ErrnoException).code === 'ENOENT' ? 'stopped' : 'unknown'
      }
    }
  }
  async start(vm: Vm, runtime: Runtime, signal: AbortSignal) {
    await this.requireRuntime(runtime)
    const state = await this.inspect(vm)
    if (state === 'running') return
    if (state !== 'stopped') throw new Error('VM identity is uncertain; refusing duplicate launch')
    const p = await this.owned(vm)
    signal.throwIfAborted()
    for (const path of [p.disk, p.seed, ...(runtime.firmwareVars ? [p.firmwareVars] : [])]) {
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink() || (await realpath(path)) !== resolve(path))
        throw new Error('VM asset is not a regular owned file')
    }
    const launch: Launch = {
      generation: randomUUID(),
      identity: vm.identity,
      bootSession: await bootSession(),
    }
    await saveLaunch(p.directory, launch, true)
    const log = await open(p.log, 'a', 0o600)
    let child: ReturnType<typeof spawn>
    let exited = false
    let spawnError: Error | undefined
    const cleanup = () => cleanLaunch(p.directory, launch).catch(() => {})
    try {
      child = spawn(runtime.qemu.path, buildQemuArgs(vm, runtime, p), {
        stdio: ['ignore', log.fd, log.fd],
        detached: true,
        env: { PATH: '/usr/bin:/bin', HOME: p.directory },
      })
      child.on('error', (error) => {
        spawnError = error
        exited = true
        void cleanup()
      })
      child.on('exit', () => {
        exited = true
        void cleanup()
      })
    } finally {
      await log.close()
    }
    if (child.pid) {
      launch.pid = child.pid
      launch.processStart = await processStart(child.pid)
      if (!exited) await saveLaunch(p.directory, launch)
      if (exited) await cleanup()
    }
    child.unref()
    const deadline = Date.now() + this.timeoutMs
    while (Date.now() < deadline) {
      signal.throwIfAborted()
      if (exited) {
        await cleanup()
        throw spawnError ?? new Error('QEMU exited during startup')
      }
      if ((await this.inspect(vm)) === 'running') return
      await pause(100, signal)
    }
    throw new Error('QEMU startup timed out; identity requires recovery')
  }
  async shutdown(vm: Vm, signal: AbortSignal) {
    const state = await this.inspect(vm)
    if (state === 'stopped') return
    if (state !== 'running') throw new Error('VM identity is uncertain')
    const p = await this.owned(vm)
    const monitor = await this.monitor(vm)
    try {
      signal.throwIfAborted()
      // Prefer guest-agent shutdown, with the QMP ACPI power button as fallback.
      let guest: JsonChannel | undefined
      try {
        guest = await this.guest(p)
        await guest.command('guest-ping')
        await guest.notify('guest-shutdown', { mode: 'powerdown' })
      } catch {
        await monitor.command('system_powerdown')
      } finally {
        guest?.close()
      }
      const deadline = Date.now() + this.timeoutMs
      while (Date.now() < deadline) {
        signal.throwIfAborted()
        try {
          const status = await monitor.command('query-status')
          if (status.status === 'shutdown') {
            await monitor.command('quit').catch(() => {})
          }
        } catch {
          break
        }
        await pause(200, signal)
      }
      while (Date.now() < deadline) {
        signal.throwIfAborted()
        if ((await this.inspect(vm)) === 'stopped') return
        await pause(100, signal)
      }
      throw new Error('Graceful shutdown timed out; no process was killed')
    } finally {
      monitor.close()
    }
  }
  async restart(vm: Vm, signal: AbortSignal) {
    const monitor = await this.monitor(vm)
    try {
      signal.throwIfAborted()
      const p = await this.owned(vm)
      const guest = await this.guest(p)
      try {
        await guest.command('guest-ping')
        const reset = monitor.waitEvent('RESET', this.timeoutMs)
        reset.catch(() => {})
        await guest.notify('guest-shutdown', { mode: 'reboot' })
        await reset
      } finally {
        guest.close()
      }
      const deadline = Date.now() + this.timeoutMs
      while (Date.now() < deadline) {
        signal.throwIfAborted()
        let ready: JsonChannel | undefined
        try {
          ready = await this.guest(p)
          await ready.command('guest-ping')
          return
        } catch {
          await pause(200, signal)
        } finally {
          ready?.close()
        }
      }
      throw new Error('Guest did not become ready after reboot')
    } finally {
      monitor.close()
    }
  }
  private async guest(paths: VmPaths) {
    const stat = await lstat(paths.qga)
    if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error('Guest-agent socket ownership mismatch')
    return JsonChannel.open(paths.qga, false, 3000)
  }
  async logs(vm: Vm): Promise<string[]> {
    const monitor = await this.monitor(vm)
    try {
      const text: unknown = await monitor.command('ringbuf-read', { device: 'console0', size: 65536, format: 'utf8' })
      if (typeof text !== 'string' || Buffer.byteLength(text) > 262144)
        throw new Error('Invalid guest console response')
      return text
        .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
        .split('\n')
        .slice(-200)
        .map((line) => line.slice(0, 2048))
    } finally {
      monitor.close()
    }
  }
  async verify(vm: Vm, mode: 'write-marker' | 'read-marker', signal: AbortSignal) {
    if ((await this.inspect(vm)) !== 'running') throw new Error('VM is not running')
    const guest = await this.guest(await this.owned(vm))
    try {
      return await verifyGuest(guest, vm, mode, signal)
    } finally {
      guest.close()
    }
  }
  async waitReady(vm: Vm, signal: AbortSignal) {
    const deadline = Date.now() + this.timeoutMs
    while (Date.now() < deadline) {
      signal.throwIfAborted()
      let guest: JsonChannel | undefined
      try {
        if ((await this.inspect(vm)) !== 'running') throw new Error('VM is not running')
        guest = await this.guest(await this.owned(vm))
        const result = await verifyGuest(guest, vm, 'ready', signal)
        if (result.ready) return result
      } catch {
      } finally {
        guest?.close()
      }
      await pause(200, signal)
    }
    throw new Error('Guest provisioning readiness timed out')
  }
  async remove(vm: Vm, signal: AbortSignal) {
    if ((await this.inspect(vm)) !== 'stopped') throw new Error('Only a proven stopped VM can be removed')
    signal.throwIfAborted()
    const p = this.paths(vm)
    try {
      await this.owned(vm)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const path of [p.disk, p.seed, p.firmwareVars]) {
      try {
        const stat = await lstat(path)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.())
          throw new Error('Refusing to delete shared or external VM storage')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    await rm(p.directory, { recursive: true })
  }
}
