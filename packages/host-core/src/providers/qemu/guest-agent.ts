import type { VerifyResult, Vm } from '@maestrly/host-protocol'
import type { JsonChannel } from '../../qmp.js'

const paths = {
  provisioned: '/var/lib/maestrly/provisioned',
  marker: '/var/lib/maestrly/lab-marker',
  boot: '/proc/sys/kernel/random/boot_id',
} as const

async function file(channel: JsonChannel, path: (typeof paths)[keyof typeof paths], content?: string) {
  const handle = await channel.command('guest-file-open', {
    path,
    mode: content === undefined ? 'r' : 'w',
  })
  if (!Number.isSafeInteger(handle) || handle < 0) throw new Error('Invalid guest file handle')
  try {
    if (content !== undefined) {
      const bytes = Buffer.from(content)
      const result = await channel.command('guest-file-write', {
        handle,
        'buf-b64': bytes.toString('base64'),
      })
      if (result.count !== bytes.length) throw new Error('Incomplete guest marker write')
      await channel.command('guest-file-flush', { handle })
      return content
    }
    const result = await channel.command('guest-file-read', {
      handle,
      count: 129,
    })
    if (
      typeof result['buf-b64'] !== 'string' ||
      result['buf-b64'].length > 172 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result['buf-b64'])
    )
      throw new Error('Invalid guest file data')
    const data = Buffer.from(result['buf-b64'], 'base64')
    if (data.length > 128 || result.count !== data.length) throw new Error('Guest file exceeds limit')
    return data.toString('utf8').trim()
  } finally {
    await channel.command('guest-file-close', { handle })
  }
}

/** The only guest execution is this internal fixed executable, without arguments. */
async function sync(channel: JsonChannel, signal: AbortSignal) {
  const result = await channel.command('guest-exec', {
    path: '/usr/bin/sync',
    'capture-output': false,
  })
  if (!Number.isSafeInteger(result.pid) || result.pid < 1) throw new Error('Invalid guest sync process')
  for (let i = 0; i < 100; i++) {
    signal.throwIfAborted()
    const status = await channel.command('guest-exec-status', {
      pid: result.pid,
    })
    if (status.exited) {
      if (status.exitcode !== 0) throw new Error('Guest sync failed')
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Guest sync timed out')
}

export async function verifyGuest(
  channel: JsonChannel,
  vm: Vm,
  mode: 'write-marker' | 'read-marker' | 'ready',
  signal: AbortSignal
): Promise<VerifyResult> {
  signal.throwIfAborted()
  await channel.command('guest-ping')
  const provisioned = await file(channel, paths.provisioned)
  const bootId = await file(channel, paths.boot)
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(bootId))
    throw new Error('Invalid guest boot identity')
  const interfaces = await channel.command('guest-network-get-interfaces')
  const networkIsolated =
    Array.isArray(interfaces) &&
    interfaces.length === 1 &&
    interfaces.every(
      (x) =>
        x?.name === 'lo' &&
        (!x['ip-addresses'] ||
          (Array.isArray(x['ip-addresses']) &&
            x['ip-addresses'].every(
              (ip: any) => ip['ip-address'] === '::1' || /^127\./.test(ip['ip-address'])
            )))
    )
  const ready = provisioned === vm.identity && networkIsolated
  if (mode === 'write-marker') {
    if (!ready) throw new Error('Guest is not safely ready')
    await file(channel, paths.marker, vm.identity)
    await sync(channel, signal)
  }
  let markerMatches = false
  if (mode !== 'ready') {
    try {
      markerMatches = (await file(channel, paths.marker)) === vm.identity
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('Monitor rejected command')) throw error
    }
  }
  return { ready, markerMatches, networkIsolated, bootId }
}
