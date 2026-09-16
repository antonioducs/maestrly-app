import { afterEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import type { JsonChannel } from '../src/qmp.js'
import { assertGuestSpace, CLEAN_FAILED, FINISH_INSTALL, GUEST_SPACE_MARGIN, installGuestRuntime, PRUNE_RETAINED } from '../src/guest/install.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function temporary() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'bot-install-')))
  directories.push(directory)
  return directory
}
async function bundle(size: number, fill = 7) {
  const directory = await temporary()
  const path = join(directory, 'runtime.tar')
  const payload = Buffer.alloc(size, fill)
  await writeFile(path, payload)
  return { path, payload, sha256: createHash('sha256').update(payload).digest('hex') }
}
/** Plenty of room on one volume: `<device> <available KiB>` twice, as the prune script prints. */
const roomy = 'dev-root 10485760\ndev-root 10485760\n'
type Call = { path: string; arg: string[] }
function guest(sha256: string, version: string, options: { df?: string; installerExit?: number } = {}) {
  const executed: Call[] = []
  const chunks: Buffer[] = []
  let output = ''
  let exitcode = 0
  const channel = {
    async command(method: string, args: Record<string, any>) {
      if (method === 'guest-exec') {
        executed.push({ path: args.path, arg: args.arg })
        const label = args.path === '/bin/sh' && args.arg[0] === '-c' ? args.arg[2] : undefined
        output = args.path === '/usr/bin/sha256sum' ? `${sha256}  bundle.tar` : args.path === '/usr/bin/cat' ? JSON.stringify({ version, sha256 }) : label === 'prune' ? (options.df ?? roomy) : ''
        exitcode = args.path === '/bin/sh' && args.arg[0] === '/var/lib/maestrly/bot-runtime/install.sh' ? (options.installerExit ?? 0) : 0
        return { pid: 1 }
      }
      if (method === 'guest-exec-status') return { exited: true, exitcode, 'out-data': Buffer.from(output).toString('base64') }
      if (method === 'guest-file-open') {
        // QGA's find_open_flag has an explicit list, unlike libc fopen.
        if (!['r', 'rb', 'w', 'wb', 'a', 'ab', 'r+', 'rb+', 'r+b', 'w+', 'wb+', 'w+b', 'a+', 'ab+', 'a+b'].includes(args.mode))
          throw Error(`invalid file open mode '${args.mode}'`)
        return 9
      }
      if (method === 'guest-file-write') {
        expect(args.handle).toBe(9)
        const bytes = Buffer.from(args['buf-b64'], 'base64')
        chunks.push(bytes)
        return { count: bytes.length }
      }
      if (method === 'guest-file-close' || method === 'guest-file-flush') return {}
      throw Error(`Unexpected command ${method}`)
    },
  } as unknown as JsonChannel
  const shell = (label: string) => executed.filter((call) => call.path === '/bin/sh' && call.arg[0] === '-c' && call.arg[2] === label)
  return { channel, executed, chunks, shell }
}
it('transfers a bundle using a QGA-supported mode and verifies its guest digest and installation marker', async () => {
  const { path, payload, sha256 } = await bundle(100_000)
  const g = guest(sha256, 'test')
  await expect(installGuestRuntime(g.channel, { path, sha256, version: 'test' }, new AbortController().signal)).resolves.toEqual({ version: 'test', digest: sha256 })
  expect(Buffer.concat(g.chunks)).toEqual(payload)
  expect(g.executed.some((call) => call.path === '/bin/sh' && call.arg[0] === '/var/lib/maestrly/bot-runtime/install.sh')).toBe(true)
})
it('prunes and measures first, retains the earlier installation, installs, then reclaims the bundle and older copies', async () => {
  const { path, sha256 } = await bundle(1000, 3)
  const g = guest(sha256, '0.1.0-desktop')
  await installGuestRuntime(g.channel, { path, sha256, version: '0.1.0-desktop' }, new AbortController().signal)
  const order = g.executed.filter((call) => call.path === '/bin/sh').map((call) => (call.arg[0] === '-c' ? call.arg[2] : 'installer'))
  expect(order).toEqual(['prune', 'retain', 'installer', 'finish'])
  expect(g.shell('prune')[0].arg.slice(3)).toEqual(['/opt/maestrly-bot'])
  const retain = g.shell('retain')[0]
  expect(retain.arg.slice(3)).toEqual(['0.1.0-desktop'])
  expect(retain.arg[1]).toMatch(/mv -- "\$p" "\$r"/)
  expect(retain.arg[1]).toMatch(/PREVIOUS_UNSAFE/)
  expect(retain.arg[1]).not.toMatch(/\brm\b|0\.1\.0-desktop/)
  // The space check runs before a single byte is written to the guest.
  const firstWrite = g.executed.findIndex((call) => call.arg[2] === 'retain')
  expect(g.executed.findIndex((call) => call.arg[2] === 'prune')).toBeLessThan(firstWrite)
  await expect(installGuestRuntime(g.channel, { path, sha256, version: '../escape' }, new AbortController().signal)).rejects.toThrow(/Invalid runtime version/)
})
it('refuses before copying anything when the guest disk cannot hold the bundle and its extraction', async () => {
  const { path, sha256 } = await bundle(1000)
  const g = guest(sha256, 'test', { df: 'dev-root 400000\ndev-root 400000\n' })
  await expect(installGuestRuntime(g.channel, { path, sha256, version: 'test' }, new AbortController().signal)).rejects.toMatchObject({ code: 'GUEST_DISK_SPACE' })
  expect(g.chunks).toEqual([])
  expect(g.shell('retain')).toEqual([])
  // Unreadable measurements fail closed.
  const unknown = guest(sha256, 'test', { df: 'garbage' })
  await expect(installGuestRuntime(unknown.channel, { path, sha256, version: 'test' }, new AbortController().signal)).rejects.toMatchObject({ code: 'GUEST_DISK_UNKNOWN' })
})
it('computes the space an update needs on one or two volumes', () => {
  const size = 1024 ** 3
  expect(assertGuestSpace(`a ${(3 * size) / 1024}\na ${(3 * size) / 1024}`, size)).toEqual({ available: 3 * size, needed: 2 * size + GUEST_SPACE_MARGIN })
  expect(() => assertGuestSpace(`a ${(2 * size) / 1024}\na ${(2 * size) / 1024}`, size)).toThrow(/2,0 GiB livres/)
  expect(assertGuestSpace(`a ${(2 * size) / 1024}\nb ${(2 * size) / 1024}`, size).needed).toBe(size + GUEST_SPACE_MARGIN)
})
it('a failed installer leaves the running installation, removes its partial copy and reports a stable code', async () => {
  const { path, sha256 } = await bundle(1000)
  const g = guest(sha256, 'test', { installerExit: 1 })
  await expect(installGuestRuntime(g.channel, { path, sha256, version: 'test' }, new AbortController().signal)).rejects.toMatchObject({ code: 'GUEST_INSTALL_FAILED' })
  expect(g.shell('clean')).toHaveLength(1)
  expect(g.shell('clean')[0].arg.slice(3)).toEqual(['/opt/maestrly-bot', 'test'])
  expect(g.shell('finish')).toEqual([])
})
const sh = (script: string, ...args: string[]) => spawnSync('/bin/sh', ['-c', script, 'test', ...args], { encoding: 'utf8' })
async function tree(base: string, name: string, ageSeconds = 0) {
  const path = `${base}${name}`
  await mkdir(join(path, 'app'), { recursive: true })
  await writeFile(join(path, 'app/main.js'), name)
  if (ageSeconds) {
    const when = new Date(Date.now() - ageSeconds * 1000)
    await utimes(path, when, when)
  }
  return path
}
const siblings = async (directory: string) => (await readdir(directory)).sort()
it('pruning keeps the running installation and exactly one earlier copy, and removes failed staging', async () => {
  const directory = await temporary()
  const base = join(directory, 'maestrly-bot')
  await tree(base, '')
  await tree(base, '.previous')
  await tree(base, '.previous-before-a')
  await tree(base, '.previous-before-b')
  await tree(base, '.staging-c')
  const pruned = sh(PRUNE_RETAINED, base)
  expect(pruned.status, pruned.stderr).toBe(0)
  expect(await siblings(directory)).toEqual(['maestrly-bot', 'maestrly-bot.previous'])
  // Measurements for the installation and staging volumes follow.
  expect(pruned.stdout.trim().split('\n')).toHaveLength(2)
  expect(pruned.stdout).toMatch(/^\S+ \d+\n\S+ \d+\n$/)
})
it('after a failed attempt (no .previous), pruning keeps the most recently retained copy', async () => {
  const directory = await temporary()
  const base = join(directory, 'maestrly-bot')
  await tree(base, '')
  await tree(base, '.previous-before-old')
  await new Promise((resolve) => setTimeout(resolve, 1100))
  await tree(base, '.previous-before-new')
  await tree(base, '.staging-new')
  expect(sh(PRUNE_RETAINED, base).status).toBe(0)
  expect(await siblings(directory)).toEqual(['maestrly-bot', 'maestrly-bot.previous-before-new'])
})
it('pruning and cleanup refuse links instead of following them', async () => {
  const directory = await temporary()
  const base = join(directory, 'maestrly-bot')
  await tree(base, '')
  await tree(base, '.previous')
  const outside = await tree(join(directory, 'outside'), '')
  spawnSync('/bin/ln', ['-s', outside, `${base}.previous-before-link`])
  const pruned = sh(PRUNE_RETAINED, base)
  expect(pruned.status).toBe(1)
  expect(pruned.stderr).toMatch(/PREVIOUS_UNSAFE/)
  expect(await siblings(outside)).toEqual(['app'])
  spawnSync('/bin/ln', ['-s', outside, `${base}.staging-v2`])
  expect(sh(CLEAN_FAILED, base, 'v2').stderr).toMatch(/STAGING_UNSAFE/)
  expect(await siblings(outside)).toEqual(['app'])
})
it('a clean and a finish reclaim only the partial copy and copies older than .previous', async () => {
  const directory = await temporary()
  const base = join(directory, 'maestrly-bot')
  await tree(base, '')
  await tree(base, '.staging-v2')
  await tree(base, '.previous-before-v2')
  expect(sh(CLEAN_FAILED, base, 'v2').status).toBe(0)
  expect(await siblings(directory)).toEqual(['maestrly-bot', 'maestrly-bot.previous-before-v2'])
  // The finish step only prunes once the replaced installation exists as .previous.
  expect(sh(FINISH_INSTALL, base).status).toBe(0)
  expect(await siblings(directory)).toEqual(['maestrly-bot', 'maestrly-bot.previous-before-v2'])
  await tree(base, '.previous')
  expect(sh(FINISH_INSTALL, base).status).toBe(0)
  expect(await siblings(directory)).toEqual(['maestrly-bot', 'maestrly-bot.previous'])
})
