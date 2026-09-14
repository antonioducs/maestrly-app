import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import type { JsonChannel } from '../qmp.js'
import type { Asset } from '../assets/catalog.js'
import { verifyAsset } from '../assets/verify.js'

/**
 * Administrative runtime preparation over the private QGA channel. Only fixed guest
 * paths and fixed executables are used; nothing here is reachable by the model.
 * The bundle is written in 48 KiB chunks, its digest is recomputed inside the guest,
 * and only then the bundled installer at a fixed path runs.
 */
export const GUEST_BUNDLE_DIR = '/var/lib/maestrly/bot-runtime'
export const GUEST_BUNDLE_PATH = `${GUEST_BUNDLE_DIR}/bundle.tar`
export const GUEST_INSTALLER_PATH = `${GUEST_BUNDLE_DIR}/install.sh`
export const GUEST_MARKER_PATH = `${GUEST_BUNDLE_DIR}/installed.json`
const CHUNK = 48 * 1024
async function exec(channel: JsonChannel, path: string, args: string[], signal: AbortSignal, timeoutMs = 600_000) {
  const started = await channel.command('guest-exec', { path, arg: args, 'capture-output': true })
  if (!Number.isSafeInteger(started.pid) || started.pid < 1) throw new Error('Invalid guest process')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    const status = await channel.command('guest-exec-status', { pid: started.pid })
    if (status.exited) {
      const out = typeof status['out-data'] === 'string' ? Buffer.from(status['out-data'], 'base64').toString('utf8') : ''
      if (status.exitcode !== 0) throw new Error(`Guest step ${path} failed (${status.exitcode})`)
      return out.slice(0, 65_536)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Guest step ${path} timed out`)
}
export async function guestSha256(channel: JsonChannel, path: string, signal: AbortSignal) {
  const out = await exec(channel, '/usr/bin/sha256sum', [path], signal, 120_000)
  const digest = out.trim().split(/\s+/)[0]
  if (!/^[a-f0-9]{64}$/.test(digest ?? '')) throw new Error('Guest digest unavailable')
  return digest
}
export async function installGuestRuntime(
  channel: JsonChannel,
  bundle: Asset & { version: string },
  signal: AbortSignal,
  onProgress: (written: number, total: number) => void = () => {}
): Promise<{ version: string; digest: string }> {
  const source = await verifyAsset(bundle)
  // Refuse symlinked or pre-existing staging; the guest directory is created fresh.
  await exec(channel, '/usr/bin/rm', ['-rf', '--', GUEST_BUNDLE_DIR], signal, 60_000)
  await exec(channel, '/usr/bin/install', ['-d', '-m', '0700', GUEST_BUNDLE_DIR], signal, 60_000)
  const handle = await open(source, 'r')
  let total = 0
  try {
    total = (await handle.stat()).size
    // QGA accepts only its documented fopen modes (not libc's exclusive `x`).
    // The fresh root-only staging directory prevents guest users replacing this file.
    const guestHandle = await channel.command('guest-file-open', { path: GUEST_BUNDLE_PATH, mode: 'wb' })
    try {
      const chunk = Buffer.alloc(CHUNK)
      let written = 0
      const hash = createHash('sha256')
      while (written < total) {
        signal.throwIfAborted()
        const { bytesRead } = await handle.read(chunk, 0, CHUNK, written)
        if (!bytesRead) break
        const slice = chunk.subarray(0, bytesRead)
        hash.update(slice)
        const result = await channel.command('guest-file-write', { handle: guestHandle, 'buf-b64': slice.toString('base64') })
        if (result.count !== bytesRead) throw new Error('Incomplete guest bundle write')
        written += bytesRead
        onProgress(written, total)
      }
      await channel.command('guest-file-flush', { handle: guestHandle })
      if (hash.digest('hex') !== bundle.sha256.toLowerCase()) throw new Error('Bundle changed during transfer')
    } finally {
      await channel.command('guest-file-close', { handle: guestHandle })
    }
  } finally {
    await handle.close()
  }
  const digest = await guestSha256(channel, GUEST_BUNDLE_PATH, signal)
  if (digest !== bundle.sha256.toLowerCase()) throw new Error('Guest bundle digest mismatch; installation refused')
  await exec(channel, '/usr/bin/tar', ['-xf', GUEST_BUNDLE_PATH, '-C', GUEST_BUNDLE_DIR, './install.sh'], signal, 120_000)
  // The installer is part of the verified bundle; it receives the expected digest only.
  await exec(channel, '/bin/sh', [GUEST_INSTALLER_PATH, '--bundle', GUEST_BUNDLE_PATH, '--sha256', digest, '--version', bundle.version], signal)
  const marker = await exec(channel, '/usr/bin/cat', [GUEST_MARKER_PATH], signal, 60_000)
  let parsed: { version?: unknown; sha256?: unknown }
  try {
    parsed = JSON.parse(marker)
  } catch {
    throw new Error('Guest installer did not record a marker')
  }
  if (parsed.version !== bundle.version || parsed.sha256 !== digest) throw new Error('Guest installer marker mismatch')
  return { version: bundle.version, digest }
}
