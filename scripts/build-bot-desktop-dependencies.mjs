#!/usr/bin/env node
// Phase 3 offline addon: the digest-pinned phase 2 session addon plus the read-only screen
// server. Downloads happen only inside a disposable clone of the phase 2 guest (user-mode
// egress, no port forwards). The source image, the base addon and every managed VM stay
// untouched; the result is installed later by the verified runtime bundle, without network.
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, open, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { cloud, disposable } from './build-bot-offline-dependencies.mjs'
import { run, sha256, validateBuildConfig, verifyInput } from './host-build-utils.mjs'

/** Exact closure missing from the phase 2 guest inventory (everything else is already installed). */
export const DESKTOP_PACKAGES = Object.freeze({
  'tigervnc-scraping-server': '1.13.1+dfsg-2build2',
  'tigervnc-common': '1.13.1+dfsg-2build2',
  'libfile-readbackwards-perl': '1.06-2',
})

/** Every downloaded deb must be exactly one pinned package, and every pin must be present. */
export function verifyDesktopPackages(text, pins = DESKTOP_PACKAGES) {
  const lines = text.trim().split('\n')
  if (!text.trim() || lines.length % 3 !== 0) throw Error('Invalid package metadata')
  const seen = new Map()
  for (let i = 0; i < lines.length; i += 3) {
    const name = lines[i].replace(/^Package: /, '')
    const version = lines[i + 1].replace(/^Version: /, '')
    const architecture = lines[i + 2].replace(/^Architecture: /, '')
    if (seen.has(name) || pins[name] !== version || !['arm64', 'all'].includes(architecture))
      throw Error(`Unexpected downloaded package: ${name}`)
    seen.set(name, version)
  }
  if (seen.size !== Object.keys(pins).length) throw Error('Pinned package missing from download')
  return seen
}

const readExpected = async (directory) =>
  new Map(
    (await readFile(path.join(directory, 'expected.tsv'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t'))
  )

/** Copies the base addon, adds the pinned debs, and regenerates expected versions and checksums. */
export async function mergeAddon(baseDirectory, debsDirectory, packagesText, output, pins = DESKTOP_PACKAGES) {
  const expected = await readExpected(baseDirectory)
  for (const [name, version] of Object.entries(pins))
    if (expected.has(name) && expected.get(name) !== version) throw Error(`Conflicting pin: ${name}`)
  await cp(baseDirectory, output, { recursive: true, errorOnExist: true, force: false })
  for (const file of await readdir(debsDirectory)) {
    if (!/^[A-Za-z0-9%._+-]+\.deb$/.test(file)) throw Error('Unexpected dependency file')
    await cp(path.join(debsDirectory, file), path.join(output, 'debs', file), { errorOnExist: true, force: false })
  }
  for (const [name, version] of Object.entries(pins)) expected.set(name, version)
  await writeFile(
    path.join(output, 'expected.tsv'),
    `${[...expected].sort(([a], [b]) => a.localeCompare(b)).map(([name, version]) => `${name}\t${version}`).join('\n')}\n`
  )
  const previous = await readFile(path.join(output, 'packages.txt'), 'utf8').catch(() => '')
  await writeFile(path.join(output, 'packages.txt'), `${previous.trimEnd()}${previous.trim() ? '\n' : ''}${packagesText.trim()}\n`)
  const sums = []
  for (const file of (await readdir(path.join(output, 'debs'))).sort())
    sums.push(`${await sha256(path.join(output, 'debs', file))}  debs/${file}`)
  await writeFile(path.join(output, 'SHA256SUMS'), `${sums.join('\n')}\n`)
  return expected
}

export async function build(root = process.cwd()) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('Native ARM64 macOS required')
  const config = validateBuildConfig(JSON.parse(await readFile(path.join(root, '.host-lab/runtime-build/host-build-with-image.json'), 'utf8')))
  for (const entry of config.files) await verifyInput(config.inputDirectory, entry)
  // The base addon is the one pinned by the qualified phase 2 runtime build.
  const runtime = JSON.parse(await readFile(path.join(root, '.host-lab/sessions/runtime-build.json'), 'utf8'))
  const baseArchive = path.join(runtime.inputDirectory, runtime.offlineDependencies.path)
  if ((await sha256(baseArchive)) !== runtime.offlineDependencies.sha256) throw Error('Base addon digest mismatch')
  const image = JSON.parse(await readFile(path.join(root, '.host-lab/sessions/fixture.json'), 'utf8')).image
  const imageSha256 = await sha256(image)
  const out = await mkdtemp(path.join(root, 'dist/offline-dependencies-desktop-'))
  const raw = path.join(out, 'transfer.raw')
  const fd = await open(raw, 'wx')
  await fd.truncate(64 * 1024 * 1024)
  await fd.close()
  const pins = Object.entries(DESKTOP_PACKAGES).map(([name, version]) => `'${name}=${version}'`).join(' ')
  const script = `printf 'network:\\n  version: 2\\n  ethernets:\\n    build:\\n      match: {name: "e*"}\\n      dhcp4: true\\n' > /etc/netplan/80-build.yaml
chmod 600 /etc/netplan/80-build.yaml
netplan apply
sleep 10
apt-get update
rm -f /var/cache/apt/archives/*.deb
apt-get -y --download-only --no-install-recommends install ${pins}
mkdir -p /tmp/addon/debs
cp /var/cache/apt/archives/*.deb /tmp/addon/debs/
cd /tmp/addon
for deb in debs/*.deb; do dpkg-deb -f "$deb" Package Version Architecture; done > packages.txt
tar -cf /dev/vdc .
`
  const evidence = await disposable(root, config, image, { 'user-data': cloud(script) }, true, [[raw, 'raw', false]])
  const download = path.join(out, 'download')
  await mkdir(download)
  run('tar', ['-xf', raw, '-C', download])
  const packagesText = await readFile(path.join(download, 'packages.txt'), 'utf8')
  verifyDesktopPackages(packagesText)
  if ((await sha256(image)) !== imageSha256) throw Error('Source image changed')
  const base = path.join(out, 'base')
  await mkdir(base)
  run('tar', ['-xf', baseArchive, '-C', base])
  const addon = path.join(out, 'addon')
  const expected = await mergeAddon(base, path.join(download, 'debs'), packagesText, addon)
  await cp(path.join(root, 'deploy/bot-runtime/linux/offline-dependencies/install.sh'), path.join(addon, 'install.sh'))
  const archive = path.join(out, 'maestrly-offline-dependencies-arm64.tar')
  execFileSync('/usr/bin/tar', ['--no-mac-metadata', '--no-xattrs', '-cf', archive, '-C', addon, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  const manifest = {
    sha256: await sha256(archive),
    packages: expected.size,
    added: DESKTOP_PACKAGES,
    baseAddonSha256: runtime.offlineDependencies.sha256,
    sourceImageSha256: imageSha256,
    buildEvidence: evidence,
  }
  await writeFile(`${archive}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`${archive}\nSHA256: ${manifest.sha256}`)
  return { archive, manifest }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  build().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
