import { spawnSync } from 'node:child_process'
import { open } from 'node:fs/promises'

const MACH_O_MAGICS = new Set([
  'feedface',
  'cefaedfe',
  'feedfacf',
  'cffaedfe',
  'cafebabe',
  'bebafeca',
  'cafebabf',
  'bfbafeca',
])

async function isMachO(file) {
  const handle = await open(file, 'r')
  try {
    const magic = Buffer.alloc(4)
    const { bytesRead } = await handle.read(magic, 0, magic.length, 0)
    return bytesRead === magic.length && MACH_O_MAGICS.has(magic.toString('hex'))
  } finally {
    await handle.close()
  }
}

function runCodesign(command, args) {
  const result = spawnSync(command, args, { shell: false, stdio: 'inherit' })
  if (result.error) throw new Error(`Could not invoke codesign: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`codesign exited with status ${result.status ?? 1}`)
}

function developerIdIdentity(rawName) {
  const name = rawName?.trim() ?? ''
  if (!name) return null
  if (name !== rawName || /[\r\n]/.test(name)) throw new Error('CSC_NAME must be a single trimmed line')
  if (name.startsWith('Developer ID Application:')) {
    throw new Error('CSC_NAME must omit the Developer ID Application prefix')
  }
  return `Developer ID Application: ${name}`
}

/** Sign native code before it is compressed into the bundled Local ML runtime. */
export async function signMacRuntimeEntries(entries, options = {}) {
  const identity = developerIdIdentity(options.cscName ?? process.env.CSC_NAME)
  if (!identity) return []
  const run = options.run ?? runCodesign
  const signed = []
  for (const entry of entries) {
    if (!(await isMachO(entry.source))) continue
    await run('/usr/bin/codesign', ['--force', '--sign', identity, '--timestamp', '--options', 'runtime', entry.source])
    await run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', entry.source])
    signed.push(entry.archive)
  }
  return signed
}
