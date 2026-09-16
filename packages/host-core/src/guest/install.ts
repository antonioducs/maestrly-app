import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import type { JsonChannel } from '../qmp.js'
import type { Asset } from '../assets/catalog.js'
import { verifyAsset } from '../assets/verify.js'
import { HostError } from '../errors.js'

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
/** The running installation; its siblings are `.previous`, `.previous-before-*` and `.staging-*`. */
export const GUEST_INSTALL_BASE = '/opt/maestrly-bot'
const CHUNK = 48 * 1024
/** Free space kept on top of the bundle copy and its extraction. */
export const GUEST_SPACE_MARGIN = 512 * 1024 ** 2
/**
 * Moves an earlier `/opt/maestrly-bot.previous` aside as `...previous-before-<version>` ($1).
 * Explicit `if` tests: under `set -e` a failing non-final `&&` operand would not stop `mv`.
 */
export const RETAIN_PREVIOUS = `set -eu
p=/opt/maestrly-bot.previous
r="$p-before-$1"
if [ -e "$p" ] || [ -L "$p" ]; then
  if [ -L "$p" ] || [ ! -d "$p" ] || [ -e "$r" ] || [ -L "$r" ]; then echo PREVIOUS_UNSAFE >&2; exit 1; fi
  mv -- "$p" "$r"
fi`
/**
 * Bounded retention before an update ($1 = installation base). Partial staging trees of failed
 * attempts are removed, and besides the running installation at most one earlier one is kept:
 * `.previous` when it exists, otherwise the most recently retained `.previous-before-*`. The
 * running installation, bot state and workspaces are never touched; links and non-directories
 * are refused. Prints `<filesystem> <available KiB>` for the installation and staging volumes.
 */
export const PRUNE_RETAINED = `set -eu
base=$1
for s in "$base".staging-*; do
  [ -e "$s" ] || [ -L "$s" ] || continue
  if [ -L "$s" ] || [ ! -d "$s" ]; then echo STAGING_UNSAFE >&2; exit 1; fi
  rm -rf -- "$s"
done
keep=
if [ ! -e "$base.previous" ] && [ ! -L "$base.previous" ]; then
  keep=$(ls -dtc -- "$base".previous-before-* 2>/dev/null | head -n 1) || keep=
fi
for r in "$base".previous-before-*; do
  [ -e "$r" ] || [ -L "$r" ] || continue
  [ "$r" = "$keep" ] && continue
  if [ -L "$r" ] || [ ! -d "$r" ]; then echo PREVIOUS_UNSAFE >&2; exit 1; fi
  rm -rf -- "$r"
done
df -Pk "\${base%/*}" /var/lib | awk 'NR > 1 { print $1, $4 }'`
/** A failed installer leaves the running installation in place; its partial copy is removed ($1 base, $2 version). */
export const CLEAN_FAILED = `set -eu
staging="$1.staging-$2"
if [ -L "$staging" ]; then echo STAGING_UNSAFE >&2; exit 1; fi
rm -rf -- "$staging"
rm -f -- ${GUEST_BUNDLE_PATH}`
/** After a verified installation: the bundle copy and anything older than `.previous` go ($1 base). */
export const FINISH_INSTALL = `set -eu
base=$1
rm -f -- ${GUEST_BUNDLE_PATH}
if [ -d "$base.previous" ] && [ ! -L "$base.previous" ]; then
  for r in "$base".previous-before-*; do
    [ -e "$r" ] || [ -L "$r" ] || continue
    if [ -L "$r" ] || [ ! -d "$r" ]; then echo PREVIOUS_UNSAFE >&2; exit 1; fi
    rm -rf -- "$r"
  done
fi`
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
const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(1).replace('.', ',')
/**
 * The bundle is copied to the staging volume and then extracted next to the running
 * installation: both need room, plus a margin. Unreadable output fails closed.
 */
export function assertGuestSpace(output: string, bundleBytes: number) {
  const volumes = output.trim().split('\n').map((line) => line.trim().split(/\s+/)).filter((fields) => fields.length === 2 && /^\d+$/.test(fields[1]))
  if (volumes.length !== 2) throw new HostError('GUEST_DISK_UNKNOWN', 'Não foi possível medir o espaço livre do ambiente; nada foi instalado.')
  const [install, staging] = volumes.map(([device, kib]) => ({ device, bytes: Number(kib) * 1024 }))
  const same = install.device === staging.device
  const needed = same ? 2 * bundleBytes + GUEST_SPACE_MARGIN : bundleBytes + GUEST_SPACE_MARGIN
  const available = same ? install.bytes : Math.min(install.bytes, staging.bytes)
  if (available < needed)
    throw new HostError('GUEST_DISK_SPACE', `O disco do ambiente tem ${gib(available)} GiB livres e a atualização precisa de ${gib(needed)} GiB. Nada foi instalado; o runtime atual e os dados dos bots continuam como estavam.`)
  return { available, needed }
}
export async function installGuestRuntime(
  channel: JsonChannel,
  bundle: Asset & { version: string },
  signal: AbortSignal,
  onProgress: (written: number, total: number) => void = () => {}
): Promise<{ version: string; digest: string }> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(bundle.version)) throw new Error('Invalid runtime version')
  const source = await verifyAsset(bundle)
  // Refuse symlinked or pre-existing staging; the guest directory is created fresh.
  await exec(channel, '/usr/bin/rm', ['-rf', '--', GUEST_BUNDLE_DIR], signal, 60_000)
  await exec(channel, '/usr/bin/install', ['-d', '-m', '0700', GUEST_BUNDLE_DIR], signal, 60_000)
  const handle = await open(source, 'r')
  let total = 0
  try {
    total = (await handle.stat()).size
    // Leftovers and old copies go first; the space check happens before anything is copied.
    assertGuestSpace(await exec(channel, '/bin/sh', ['-c', PRUNE_RETAINED, 'prune', GUEST_INSTALL_BASE], signal, 300_000), total)
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
  // The installer keeps exactly one previous tree and refuses to replace it; an earlier one is
  // retained under a name tied to this update until this update is verified.
  // Callers take a consistent disk backup before reaching this point.
  await exec(channel, '/bin/sh', ['-c', RETAIN_PREVIOUS, 'retain', bundle.version], signal, 120_000)
  try {
    await exec(channel, '/usr/bin/tar', ['-xf', GUEST_BUNDLE_PATH, '-C', GUEST_BUNDLE_DIR, './install.sh'], signal, 120_000)
    // The installer is part of the verified bundle; it receives the expected digest only.
    await exec(channel, '/bin/sh', [GUEST_INSTALLER_PATH, '--bundle', GUEST_BUNDLE_PATH, '--sha256', digest, '--version', bundle.version], signal)
  } catch (error) {
    // The installer publishes atomically: the running installation is still in place. Its partial
    // copy and the bundle are removed so a later attempt starts clean and the disk is not left full.
    await exec(channel, '/bin/sh', ['-c', CLEAN_FAILED, 'clean', GUEST_INSTALL_BASE, bundle.version], new AbortController().signal, 300_000).catch(() => {})
    if (signal.aborted) throw error
    throw new HostError('GUEST_INSTALL_FAILED', 'A instalação no ambiente não foi concluída; o runtime anterior continua instalado e a tentativa foi limpa.')
  }
  const marker = await exec(channel, '/usr/bin/cat', [GUEST_MARKER_PATH], signal, 60_000)
  let parsed: { version?: unknown; sha256?: unknown }
  try {
    parsed = JSON.parse(marker)
  } catch {
    throw new Error('Guest installer did not record a marker')
  }
  if (parsed.version !== bundle.version || parsed.sha256 !== digest) throw new Error('Guest installer marker mismatch')
  // Verified: keep the new installation and the one it replaced; reclaim the rest.
  await exec(channel, '/bin/sh', ['-c', FINISH_INSTALL, 'finish', GUEST_INSTALL_BASE], signal, 300_000).catch(() => {})
  return { version: bundle.version, digest }
}
