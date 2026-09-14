// Build against the existing phase1 inventory; never write to the source image.
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, writeFile, open } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { run, sha256, verifyInput, validateBuildConfig } from './host-build-utils.mjs'

export function inventory(text) {
  return new Map(
    text
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
  )
}
export function verifyDownloadedInventory(text, expected) {
  const metadata = text.trim().split('\n')
  if (!text.trim() || metadata.length % 3 !== 0) throw Error('Invalid package metadata')
  const seen = new Set()
  for (let i = 0; i < metadata.length; i += 3) {
    const name = metadata[i].replace(/^Package: /, '')
    const version = metadata[i + 1].replace(/^Version: /, '')
    const architecture = metadata[i + 2].replace(/^Architecture: /, '')
    if (
      seen.has(name) ||
      !['all', 'arm64'].includes(architecture) ||
      (expected.get(name) ?? expected.get(name + ':arm64')) !== version
    )
      throw Error('Downloaded package differs from image inventory: ' + name)
    seen.add(name)
  }
  return seen.size
}
export async function disposable(root, config, image, seedFiles, network, extra = []) {
  const dir = await mkdtemp(path.join(root, '.host-lab/dependencies-'))
  await mkdir(path.join(dir, 'seed'))
  for (const [name, content] of Object.entries(seedFiles))
    await writeFile(path.join(dir, 'seed', name), content)
  await writeFile(
    path.join(dir, 'seed/meta-data'),
    `instance-id: ${randomUUID()}\nlocal-hostname: dependencies-probe\n`
  )
  run('/usr/bin/hdiutil', [
    'makehybrid',
    '-iso',
    '-joliet',
    '-default-volume-name',
    'CIDATA',
    '-o',
    path.join(dir, 'seed.iso'),
    path.join(dir, 'seed'),
  ])
  const bin = (name) => path.join(config.inputDirectory, name)
  run(bin('bin/qemu-img'), [
    'create',
    '-f',
    'qcow2',
    '-F',
    'qcow2',
    '-b',
    image,
    path.join(dir, 'guest.qcow2'),
    '12G',
  ])
  await cp(bin(config.firmwareVars), path.join(dir, 'vars.fd'))
  const args = [
    '-name',
    'maestrly-dependency-build',
    '-machine',
    'virt,accel=hvf',
    '-cpu',
    'host',
    '-smp',
    '2',
    '-m',
    '2048',
    '-nodefaults',
    '-no-user-config',
    '-display',
    'none',
    '-monitor',
    'none',
    '-serial',
    `file:${dir}/console.log`,
    '-drive',
    `if=pflash,format=raw,readonly=on,file=${bin(config.firmware)}`,
    '-drive',
    `if=pflash,format=raw,file=${dir}/vars.fd`,
  ]
  for (const [i, [file, format, ro]] of [
    [path.join(dir, 'guest.qcow2'), 'qcow2', false],
    [path.join(dir, 'seed.iso'), 'raw', true],
    ...extra,
  ].entries())
    args.push(
      '-blockdev',
      JSON.stringify({
        driver: 'file',
        filename: file,
        'node-name': `f${i}`,
        'read-only': ro,
      }),
      '-blockdev',
      JSON.stringify({
        driver: format,
        file: `f${i}`,
        'node-name': `d${i}`,
        'read-only': ro,
      }),
      '-device',
      `virtio-blk-pci,drive=d${i}`
    )
  args.push(
    ...(network
      ? ['-netdev', 'user,id=build', '-device', 'virtio-net-pci,netdev=build,romfile=']
      : ['-nic', 'none'])
  )
  await writeFile(
    path.join(dir, 'inputs.json'),
    JSON.stringify({ image, imageSha256: await sha256(image), network, args }, null, 2)
  )
  console.log('Evidence: ' + dir)
  await new Promise((resolve, reject) => {
    const child = spawn(bin('bin/qemu-system-aarch64'), args, {
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    const stop = () => child.kill('SIGTERM')
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    const timer = setTimeout(() => child.kill('SIGKILL'), 20 * 60_000)
    const progress = setInterval(() => console.log('Dependency VM running: ' + dir), 30000)
    child.once('error', reject)
    child.once('close', (code) => {
      clearTimeout(timer)
      clearInterval(progress)
      process.removeListener('SIGINT', stop)
      process.removeListener('SIGTERM', stop)
      code === 0 ? resolve() : reject(Error('VM exit ' + code))
    })
  })
  const log = await readFile(path.join(dir, 'console.log'), 'utf8')
  if (!/\nDEPENDENCIES_OK\r?\n/.test(log)) throw Error('Dependency VM failed: ' + dir)
  return dir
}
export function cloud(script) {
  return (
    '#cloud-config\nusers: []\ndisable_root: true\nruncmd:\n  - [bash, -c, ' +
    JSON.stringify(
      "set -euxo pipefail\ntrap '' HUP\nsystemctl mask --now serial-getty@ttyAMA0.service\nexec > /dev/ttyAMA0 2>&1\ntrap 'echo DEPENDENCIES_FAILED; shutdown -h now' ERR\n" +
        script +
        '\necho DEPENDENCIES_OK\nsync\nshutdown -h now'
    ) +
    ']\n'
  )
}
export async function build(root = process.cwd()) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw Error('Native ARM64 macOS required')
  const config = validateBuildConfig(
    JSON.parse(
      await readFile(path.join(root, '.host-lab/runtime-build/host-build-with-image.json'), 'utf8')
    )
  )
  for (const entry of config.files) await verifyInput(config.inputDirectory, entry)
  const image = path.join(root, 'dist/ubuntu-24.04-20260826-arm64.qcow2')
  const base = JSON.parse(await readFile(image + '.manifest.json', 'utf8'))
  const target = JSON.parse(
    await readFile(
      path.join(root, 'dist/ubuntu-24.04-20260826-bot-desktop-arm64.qcow2.manifest.json'),
      'utf8'
    )
  )
  if (
    (await sha256(path.join(root, 'dist/ubuntu-24.04-20260826-bot-desktop-arm64.qcow2'))) !==
    target.sha256
  )
    throw Error('Desktop image digest mismatch')
  if ((await sha256(image)) !== base.sha256) throw Error('Phase1 digest mismatch')
  const before = inventory(base.packageInventory),
    after = inventory(target.packageInventory)
  const pins = [...after].filter(([name, version]) => before.get(name) !== version)
  for (const [name, version] of pins)
    if (!/^[a-z0-9][a-z0-9.+:-]*$/.test(name) || !/^[0-9][A-Za-z0-9.+:~_-]*$/.test(version))
      throw Error('Invalid inventory')
  const out = await mkdtemp(path.join(root, 'dist/offline-dependencies-'))
  const raw = path.join(out, 'transfer.raw')
  const fd = await open(raw, 'wx')
  await fd.truncate(512 * 1024 * 1024)
  await fd.close()
  const script = `mkdir -p /mnt/seed /tmp/addon/debs
mount -o ro /dev/disk/by-label/CIDATA /mnt/seed
cp /mnt/seed/install.sh /tmp/addon/install.sh
cp /mnt/seed/expected.tsv /tmp/addon/expected.tsv
printf 'network:\\n  version: 2\\n  ethernets:\\n    build:\\n      match: {name: "e*"}\\n      dhcp4: true\\n' > /etc/netplan/80-build.yaml
chmod 600 /etc/netplan/80-build.yaml
netplan apply
sleep 10
apt-get update
apt-get -y --download-only --no-install-recommends install ${pins.map(([n, v]) => `'${n}=${v}'`).join(' ')}
cp /var/cache/apt/archives/*.deb /tmp/addon/debs/
cd /tmp/addon
sha256sum debs/*.deb > SHA256SUMS
for deb in debs/*.deb; do dpkg-deb -f "$deb" Package Version Architecture; done > packages.txt
tar -cf /dev/vdc .
`
  const evidence = await disposable(
    root,
    config,
    image,
    {
      'user-data': cloud(script),
      'install.sh': await readFile(
        path.join(root, 'deploy/bot-runtime/linux/offline-dependencies/install.sh')
      ),
      'expected.tsv': pins.map(([n, v]) => n + '\t' + v).join('\n') + '\n',
    },
    true,
    [[raw, 'raw', false]]
  )
  const addon = path.join(out, 'addon')
  await mkdir(addon)
  run('tar', ['-xf', raw, '-C', addon])
  const packageCount = verifyDownloadedInventory(
    await readFile(path.join(addon, 'packages.txt'), 'utf8'),
    after
  )
  if ((await sha256(image)) !== base.sha256) throw Error('Source image changed')
  const archive = path.join(out, 'maestrly-offline-dependencies-arm64.tar')
  run('tar', ['-cf', archive, '-C', addon, '.'])
  const manifest = {
    packageCount,
    sha256: await sha256(archive),
    phase1Sha256: base.sha256,
    targetImageSha256: target.sha256,
    pins: Object.fromEntries(pins),
    buildEvidence: evidence,
  }
  await writeFile(archive + '.manifest.json', JSON.stringify(manifest, null, 2) + '\n')
  console.log(archive)
  return { archive, config, image, out }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  build().catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
