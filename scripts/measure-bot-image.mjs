// Offline qualification of a disposable overlay. No managed VMs or settings touched.
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { run, validateBuildConfig, verifyInput, sha256 } from './host-build-utils.mjs'

async function main() {
  const [configPath, imagePath] = process.argv.slice(2)
  if (!configPath || !imagePath)
    throw new Error('Usage: node scripts/measure-bot-image.mjs runtime-build-config.json image.qcow2')
  const runtime = validateBuildConfig(JSON.parse(await readFile(configPath, 'utf8')))
  const manifest = JSON.parse(await readFile(`${imagePath}.manifest.json`, 'utf8'))
  if ((await sha256(imagePath)) !== manifest.sha256) throw new Error('IMAGE_HASH_MISMATCH')
  for (const entry of runtime.files) await verifyInput(runtime.inputDirectory, entry)
  const input = (name) => path.join(runtime.inputDirectory, name)
  const temp = await mkdtemp(path.join(tmpdir(), 'mbq-'))
  let child
  let closed
  const began = Date.now()
  try {
    const disk = path.join(temp, 'disk.qcow2')
    run(input('bin/qemu-img'), ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', path.resolve(imagePath), disk])
    await cp(input(runtime.firmwareVars), path.join(temp, 'vars.fd'))
    const socketPath = path.join(temp, 'qga')
    child = spawn(
      input('bin/qemu-system-aarch64'),
      [
        '-name',
        'maestrly-bot-offline-qualification',
        '-machine',
        'virt,accel=hvf',
        '-cpu',
        'host',
        '-smp',
        '2',
        '-m',
        '1024',
        '-nodefaults',
        '-no-user-config',
        '-display',
        'none',
        '-monitor',
        'none',
        '-serial',
        `file:${path.join(temp, 'console.log')}`,
        '-nic',
        'none',
        '-drive',
        `if=pflash,format=raw,readonly=on,file=${input(runtime.firmware)}`,
        '-drive',
        `if=pflash,format=raw,file=${path.join(temp, 'vars.fd')}`,
        '-blockdev',
        JSON.stringify({
          driver: 'file',
          filename: disk,
          'node-name': 'disk-file',
        }),
        '-blockdev',
        JSON.stringify({
          driver: 'qcow2',
          file: 'disk-file',
          'node-name': 'disk',
        }),
        '-device',
        'virtio-blk-pci,drive=disk',
        '-chardev',
        `socket,path=${socketPath},server=on,wait=off,id=qga`,
        '-device',
        'virtio-serial-pci',
        '-device',
        'virtserialport,chardev=qga,name=org.qemu.guest_agent.0',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    )
    let failure
    child.stderr.on('data', () => {})
    closed = new Promise((resolve) => {
      child.once('close', resolve)
      child.once('error', (error) => {
        failure = error
        resolve()
      })
    })
    const rpc = (execute, args) =>
      new Promise((resolve, reject) => {
        const socket = connect(socketPath)
        let buffer = ''
        const timer = setTimeout(() => {
          socket.destroy()
          reject(new Error('QGA_TIMEOUT'))
        }, 3000)
        socket.on('connect', () => socket.write(JSON.stringify({ execute, arguments: args }) + '\n'))
        socket.on('data', (chunk) => {
          buffer += chunk
          const end = buffer.indexOf('\n')
          if (end < 0) return
          clearTimeout(timer)
          socket.destroy()
          try {
            const result = JSON.parse(buffer.slice(0, end))
            result.error ? reject(new Error(JSON.stringify(result.error))) : resolve(result.return)
          } catch (error) {
            reject(error)
          }
        })
        socket.on('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
      })
    const delay = () => new Promise((resolve) => setTimeout(resolve, 500))
    while (true) {
      if (failure) throw failure
      if (Date.now() - began > 120000) throw new Error('OFFLINE_BOOT_TIMEOUT')
      try {
        await rpc('guest-ping')
        break
      } catch {
        await delay()
      }
    }
    const bootToQgaMs = Date.now() - began
    const command = [
      'set -eu',
      'runuser -u maestrlybot -- env HOME=/home/maestrlybot MAESTRLY_DESKTOP_CONFIG=/opt/maestrly-desktop sh /opt/maestrly-desktop/desktop-session.sh >/tmp/desktop-qualification.log 2>&1 &',
      'sleep 15',
      'DISPLAY=:10 xdpyinfo >/dev/null',
      'pgrep -u maestrlybot -x openbox >/dev/null',
      'pgrep -u maestrlybot -x pcmanfm >/dev/null',
      'pgrep -u maestrlybot -x xterm >/dev/null',
      'cat /proc/meminfo',
      "ps -eo comm,rss | grep -E '(Xvfb|openbox|pcmanfm|xterm)'",
    ].join('\n')
    const { pid } = await rpc('guest-exec', {
      path: '/bin/sh',
      arg: ['-c', command],
      'capture-output': true,
    })
    let result
    do {
      if (Date.now() - began > 180000) throw new Error('DESKTOP_MEASURE_TIMEOUT')
      await delay()
      result = await rpc('guest-exec-status', { pid })
    } while (!result.exited)
    if (result.exitcode !== 0)
      throw new Error(`DESKTOP_FAILED: ${Buffer.from(result['err-data'] ?? '', 'base64')}`)
    console.log(
      JSON.stringify(
        {
          imageSha256: manifest.sha256,
          network: 'none',
          assignedMemoryMiB: 1024,
          vcpus: 2,
          bootToQgaMs,
          measurement: Buffer.from(result['out-data'] ?? '', 'base64').toString(),
          scope: 'desktop prerequisites only, no browser; not a measured minimum',
        },
        null,
        2
      )
    )
    // The measured overlay is disposable; the finally block stops only this child.
    // guest-shutdown deliberately has no success response, so do not await an RPC reply.
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
      await closed
      clearTimeout(timer)
    }
    await rm(temp, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
