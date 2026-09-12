#!/usr/bin/env node
/**
 * Fetch the pinned OpenAI tunnel client (Apache-2.0, https://github.com/openai/tunnel-client).
 * Used by the optional ChatGPT Web provider to connect its local MCP bridge.
 * Usage: node scripts/fetch-tunnel-client.mjs [--target mac-arm64 | --all] [--force]
 * Artifacts and upstream license are stored under resources/tunnel-client/.
 */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const TUNNEL_CLIENT_VERSION = '0.0.10'

export const TUNNEL_CLIENT_TARGETS = [
  {
    os: 'mac',
    arch: 'arm64',
    asset: 'darwin-arm64',
    sha256: '288accc7fd20cfee1d495adb933773af9e19ebc0cdef3173f7fb544afa5065b2',
  },
  {
    os: 'mac',
    arch: 'x64',
    asset: 'darwin-amd64',
    sha256: '1a48616e584484f8bef4c1128d515ac96cf44d0d9609c1462abccc1793f4b847',
  },
  {
    os: 'linux',
    arch: 'arm64',
    asset: 'linux-arm64',
    sha256: 'b842a9b2352eebd80514cf01a1fbb1c0d400a7d24a4015e85a7ea5f1aeaa5b30',
  },
  {
    os: 'linux',
    arch: 'x64',
    asset: 'linux-amd64',
    sha256: 'b9e0388a343f2d7adeff3992f411a0bd3d916a64bc56534aac5fd15ac1b20cd5',
  },
  {
    os: 'win',
    arch: 'arm64',
    asset: 'windows-arm64',
    sha256: '08954ccda078abfeac9382f9b19d178ce0656cfe1e84f5941f0f8a5c4e91ea78',
  },
  {
    os: 'win',
    arch: 'x64',
    asset: 'windows-amd64',
    sha256: '5e64a056f1d96786da0a6f8db1da5f5f4a03fd19a90d951a25cf2ca8d9093d00',
  },
]

const assetURL = (asset) =>
  `https://persistent.oaistatic.com/tunnel-client/v${TUNNEL_CLIENT_VERSION}/tunnel-client-v${TUNNEL_CLIENT_VERSION}-${asset}.zip`

const LICENSE_URL = `https://raw.githubusercontent.com/openai/tunnel-client/v${TUNNEL_CLIENT_VERSION}/LICENSE`

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'desktop')
const outRoot = path.join(root, 'resources', 'tunnel-client')

const hostOs = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'
const hostId = `${hostOs}-${process.arch}`

function note(msg) {
  console.log(`[fetch-tunnel-client] ${msg}`)
}

function unzipEntries(buf) {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('zip invalid: End of Central Directory not found')
  const total = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const entries = []
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('invalid zip: central directory entry')
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8')
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('invalid zip: local file header')
    const localNameLen = buf.readUInt16LE(localOff + 26)
    const localExtraLen = buf.readUInt16LE(localOff + 28)
    const dataStart = localOff + 30 + localNameLen + localExtraLen
    const raw = buf.subarray(dataStart, dataStart + compSize)
    entries.push({ name, data: () => (method === 0 ? Buffer.from(raw) : inflateRawSync(raw)) })
    off += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

async function fetchLicense() {
  const dest = path.join(outRoot, 'LICENSE-tunnel-client')
  if (existsSync(dest)) return
  const res = await fetch(LICENSE_URL)
  if (!res.ok) throw new Error(`LICENSE download failed (${res.status})`)
  mkdirSync(outRoot, { recursive: true })
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
}

async function fetchTarget(target, force) {
  const dir = path.join(outRoot, `${target.os}-${target.arch}`)
  const binName = target.os === 'win' ? 'tunnel-client.exe' : 'tunnel-client'
  const binPath = path.join(dir, binName)
  const versionFile = path.join(dir, '.version')
  const hashFile = path.join(dir, '.sha256')

  if (!force && existsSync(binPath) && existsSync(versionFile) && existsSync(hashFile)) {
    if (
      readFileSync(versionFile, 'utf8').trim() === TUNNEL_CLIENT_VERSION &&
      readFileSync(hashFile, 'utf8').trim() === target.sha256
    ) {
      note(`${target.os}-${target.arch}: already at v${TUNNEL_CLIENT_VERSION} — skipping`)
      return
    }
  }

  const url = assetURL(target.asset)
  note(`${target.os}-${target.arch}: downloading ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`)
  const zip = Buffer.from(await res.arrayBuffer())

  const digest = createHash('sha256').update(zip).digest('hex')
  if (digest !== target.sha256) {
    throw new Error(`sha256 mismatch for ${target.asset} (expected ${target.sha256}, received ${digest})`)
  }

  const entry = unzipEntries(zip).find((e) => e.name === binName || e.name.endsWith(`/${binName}`))
  if (!entry) throw new Error(`zip for ${target.asset} is missing ${binName}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(binPath, entry.data())
  if (target.os !== 'win') chmodSync(binPath, 0o755)
  writeFileSync(versionFile, `${TUNNEL_CLIENT_VERSION}\n`)
  writeFileSync(hashFile, `${target.sha256}\n`)
  note(`${target.os}-${target.arch}: ok (${binPath})`)
}

function parseArgs(argv) {
  const ids = []
  let all = false
  let force = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--all') all = true
    else if (arg === '--force') force = true
    else if (arg === '--target') {
      const value = argv[++i]
      if (!value) throw new Error('--target requires <os>-<arch>')
      ids.push(value)
    } else if (arg.startsWith('--target=')) ids.push(arg.slice('--target='.length))
    else throw new Error(`unknown flag: ${arg}`)
  }
  if (all && ids.length > 0) throw new Error('use --all OR --target, not both')
  const selectedIds = all
    ? TUNNEL_CLIENT_TARGETS.map((target) => `${target.os}-${target.arch}`)
    : ids.length
      ? ids
      : [hostId]
  const targets = [...new Set(selectedIds)].map((id) => {
    const target = TUNNEL_CLIENT_TARGETS.find((candidate) => `${candidate.os}-${candidate.arch}` === id)
    if (!target) {
      throw new Error(
        `unsupported target: ${id}. Use: ${TUNNEL_CLIENT_TARGETS.map((candidate) => `${candidate.os}-${candidate.arch}`).join(', ')}`
      )
    }
    return target
  })
  return { targets, force }
}

async function main() {
  const { targets, force } = parseArgs(process.argv.slice(2))
  for (const target of targets) await fetchTarget(target, force)
  await fetchLicense()
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => {
    console.error(`[fetch-tunnel-client] ERROR: ${err.message}`)
    process.exit(1)
  })
}
