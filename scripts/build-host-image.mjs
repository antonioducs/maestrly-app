#!/usr/bin/env node
// Run in a trusted Linux build environment of the guest architecture.
import { readFile, mkdir, cp, chmod, rename, rm, lstat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { verifyInput, sha256, run } from './host-build-utils.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
async function main() {
  if (!process.env.MAESTRLY_HOST_IMAGE_CONFIG)
    throw new Error('IMAGE_CONFIG_REQUIRED: set MAESTRLY_HOST_IMAGE_CONFIG to an explicit private image build manifest')
  const config = JSON.parse(await readFile(process.env.MAESTRLY_HOST_IMAGE_CONFIG, 'utf8'))
  if (config.builder === 'qemu-hvf') {
    const { buildQemuImage } = await import('./build-host-image-qemu.mjs')
    await buildQemuImage(config, root)
    return
  }
  if (
    !['arm64', 'x64'].includes(config.architecture) ||
    process.platform !== 'linux' ||
    process.arch !== config.architecture
  )
    throw new Error('IMAGE_BUILD_PLATFORM: native Linux build machine matching image architecture required')
  if (
    !/^\d{8}$/.test(config.releaseDate ?? '') ||
    !/^https:\/\/cloud-images(?:-archive)?\.ubuntu\.com\/releases\/noble\/release-\d{8}\//.test(
      config.sourceUrl ?? ''
    ) ||
    !config.sourceUrl.includes(`release-${config.releaseDate}/`)
  )
    throw new Error('IMAGE_SOURCE: dated Ubuntu 24.04 Noble source required')
  if (
    !config.packages ||
    !['cloud-init', 'qemu-guest-agent'].every((key) => /^[0-9][A-Za-z0-9.+:~_-]*$/.test(config.packages[key] ?? ''))
  )
    throw new Error('IMAGE_PACKAGES: exact cloud-init and qemu-guest-agent package versions required')
  const base = await verifyInput(config.inputDirectory, config.base)
  const customize = await verifyInput(config.inputDirectory, config.virtCustomize)
  const cat = await verifyInput(config.inputDirectory, config.virtCat)
  const inspector = await verifyInput(config.inputDirectory, config.virtInspector)
  const inspection = run(inspector, ['-a', base])
  const guestArch = config.architecture === 'arm64' ? 'aarch64' : 'x86_64'
  if (
    !inspection.includes(`<arch>${guestArch}</arch>`) ||
    !inspection.includes('<distro>ubuntu</distro>') ||
    !inspection.includes('<major_version>24</major_version>') ||
    !inspection.includes('<minor_version>4</minor_version>')
  )
    throw new Error('IMAGE_OS_MISMATCH: Ubuntu 24.04 and declared architecture required')
  const out = path.join(root, 'dist', `ubuntu-24.04-${config.releaseDate}-${config.architecture}.qcow2`)
  await mkdir(path.dirname(out), { recursive: true })
  try {
    await lstat(out)
    throw new Error('OUTPUT_EXISTS: preserve previous image')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const staged = `${out}.staging-${randomUUID()}`
  try {
    await cp(base, staged)
    const prepare = [
      'set -eu',
      'systemctl enable qemu-guest-agent',
      'systemctl mask systemd-networkd-wait-online.service',
      'passwd -l root',
      "printf 'users: []\\nssh_pwauth: false\\ndisable_root: true\\ndatasource_list: [ NoCloud ]\\n' > /etc/cloud/cloud.cfg.d/90-maestrly.cfg",
      "printf 'network: {config: disabled}\\n' > /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg",
      'rm -f /etc/ssh/ssh_host_* /etc/netplan/*.yaml',
      'cloud-init clean --logs --machine-id --seed',
      'rm -f /var/lib/dbus/machine-id',
      'ln -s /etc/machine-id /var/lib/dbus/machine-id',
      'rm -rf /root/.ssh /home/ubuntu/.ssh /var/lib/maestrly',
      'rm -f /root/.bash_history /home/ubuntu/.bash_history',
      'dpkg-query -W > /var/lib/maestrly-image-packages.txt',
      'apt-get clean',
      'find /var/log -type f -exec truncate -s 0 {} +',
    ].join('\n')
    run(
      customize,
      [
        '-a',
        staged,
        '--install',
        `cloud-init=${config.packages['cloud-init']},qemu-guest-agent=${config.packages['qemu-guest-agent']}`,
        '--run-command',
        prepare,
      ],
      { timeout: 1_800_000 }
    )
    const installed = run(cat, ['-a', staged, '/var/lib/maestrly-image-packages.txt'])
    for (const [name, version] of Object.entries(config.packages))
      if (
        !installed
          .split('\n')
          .some(
            (line) => line === `${name}\t${version}` || (line.startsWith(`${name}:`) && line.endsWith(`\t${version}`))
          )
      )
        throw new Error(`IMAGE_PACKAGE_MISMATCH: ${name}`)
    await chmod(staged, 0o444)
    const digest = await sha256(staged)
    await writeFile(
      `${staged}.manifest.json`,
      JSON.stringify(
        {
          version: 1,
          id: `ubuntu-24.04-${config.releaseDate}-${config.architecture}`,
          architecture: config.architecture,
          releaseDate: config.releaseDate,
          sourceUrl: config.sourceUrl,
          sourceSha256: config.base.sha256,
          sha256: digest,
          bytes: (await lstat(staged)).size,
          packages: installed,
          toolVersions: { virtCustomize: run(customize, ['--version']) },
          qualification: 'unqualified',
          buildNetwork: 'enabled only during image preparation',
          guestNetwork: 'absent',
          reproducibility:
            'Pinned base and requested packages; full installed package inventory recorded. Output is not claimed byte reproducible.',
        },
        null,
        2
      )
    )
    await rename(staged, out)
    await rename(`${staged}.manifest.json`, `${out}.manifest.json`)
    console.log(
      `Prepared image: ${out}\nSHA256: ${digest}\nBoot/QGA qualification on target hardware is still required.`
    )
  } finally {
    await rm(staged, { force: true })
    await rm(`${staged}.manifest.json`, { force: true })
  }
}
main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
