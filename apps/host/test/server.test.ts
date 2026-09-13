// Socket ownership and permission contracts require POSIX Unix-domain sockets.
const skipWindows = process.platform === 'win32'
import { it, expect } from 'vitest'
import { mkdtemp, realpath, lstat, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { startSocket } from '../src/server.js'
import { RotatingLog } from '../src/log.js'
it.skipIf(skipWindows)('round trips strict requests over a private socket and refuses an existing socket', async () => {
  const dir = await realpath(await mkdtemp('/tmp/mh-'))
  const path = join(dir, 'rpc')
  let close: undefined | (() => Promise<void>)
  try {
    close = await startSocket(path, async (request) => ({ version: 1, id: request.id, result: { ok: true } }))
    expect((await lstat(path)).mode & 0o777).toBe(0o660)
    await expect(
      startSocket(path, async () => {
        throw Error()
      })
    ).rejects.toThrow('already exists')
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(path, () => socket.write('{"version":1,"id":"x","method":"host.inspect","params":{}}\n'))
      socket.on('error', reject)
      socket.on('data', (data) => {
        resolve(data.toString())
        socket.destroy()
      })
    })
    expect(JSON.parse(reply)).toEqual({ version: 1, id: 'x', result: { ok: true } })
  } finally {
    await close?.()
    await rm(dir, { recursive: true, force: true })
  }
})
it('rotates bounded event logs without storing request payloads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mh-log-'))
  const path = join(dir, 'host.jsonl')
  try {
    const log = new RotatingLog(path, 1, 2)
    log.write('started')
    log.write('request_completed')
    log.write('stopped')
    expect(JSON.parse((await readFile(path, 'utf8')).trim()).event).toBe('stopped')
    expect(JSON.parse((await readFile(`${path}.2`, 'utf8')).trim()).event).toBe('started')
    if (!skipWindows) expect((await lstat(path)).mode & 0o777).toBe(0o600)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
it.skipIf(skipWindows)('never replaces an existing file at the socket path', async () => {
  const dir = await realpath(await mkdtemp('/tmp/mh-'))
  const path = join(dir, 'rpc')
  try {
    await writeFile(path, 'keep')
    await expect(
      startSocket(path, async () => {
        throw Error()
      })
    ).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('keep')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
it.skipIf(skipWindows)('recovers a real crashed socket only in a private owned directory', async () => {
  const { spawn } = await import('node:child_process')
  const dir = await realpath(await mkdtemp('/tmp/mh-stale-'))
  const path = join(dir, 'rpc')
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import {createServer} from 'node:net'; createServer().listen(process.argv[1],()=>process.stdout.write('ready'))",
      path,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  )
  let close: undefined | (() => Promise<void>)
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve())
      child.once('error', reject)
      child.once('exit', () => reject(Error('exited before bind')))
    })
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill('SIGKILL')
    await exited
    expect((await lstat(path)).isSocket()).toBe(true)
    close = await startSocket(path, async (request) => ({ version: 1, id: request.id, result: {} }))
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(path, () =>
        socket.write('{"version":1,"id":"recovered","method":"host.inspect","params":{}}\n')
      )
      socket.on('error', reject)
      socket.once('data', (data) => {
        resolve(data.toString())
        socket.destroy()
      })
    })
    expect(JSON.parse(reply).id).toBe('recovered')
  } finally {
    child.kill('SIGKILL')
    await close?.()
    await rm(dir, { recursive: true, force: true })
  }
})
it.skipIf(skipWindows)('retains socket symlinks without following or unlinking them', async () => {
  const { symlink } = await import('node:fs/promises')
  const dir = await realpath(await mkdtemp('/tmp/mh-link-'))
  const target = join(dir, 'target')
  const path = join(dir, 'rpc')
  let close: undefined | (() => Promise<void>)
  try {
    close = await startSocket(target, async (request) => ({ version: 1, id: request.id, result: {} }))
    await symlink(target, path)
    await expect(startSocket(path, async (request) => ({ version: 1, id: request.id, result: {} }))).rejects.toThrow(
      'untrusted'
    )
    expect((await lstat(path)).isSymbolicLink()).toBe(true)
  } finally {
    await close?.()
    await rm(dir, { recursive: true, force: true })
  }
})
