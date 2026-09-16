// Separate bot prerequisite image builder; phase1 artifacts are never replaced.
// Native macOS image builder. Network is enabled ONLY in this explicitly invoked,
// disposable build VM. The installed Host always launches guests without a NIC.
import { spawn } from 'node:child_process'
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  open,
  chmod,
  rename,
  stat,
  lstat,
} from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { validateBuildConfig, verifyInput, sha256, run } from './host-build-utils.mjs'

export function imageBuildUserData(config, instanceId, desktopFiles = {}) {
  validateBotPackages(config.packages)
  if (config.packages['qemu-guest-agent'] !== config.guestAgentVersion)
    throw new Error('BOT_PACKAGES: guest agent pin mismatch')
  if (!/^[0-9][A-Za-z0-9.+:~_-]*$/.test(config.guestAgentVersion ?? ''))
    throw new Error('IMAGE_PACKAGES: an exact qemu-guest-agent version is required')
  if (!/^[a-f0-9-]{36}$/.test(instanceId)) throw new Error('IMAGE_ID: invalid build instance identity')
  const cleanup = [
    'set -eu',
    'apt-get update',
    'DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ' +
      Object.entries(config.packages)
        .map(([name, version]) => `'${name}=${version}'`)
        .join(' '),
    'install -d -m 0755 /opt/maestrly-desktop',
    ...Object.entries(desktopFiles).map(
      ([name, contents]) =>
        `printf '%s' '${Buffer.from(contents).toString('base64')}' | base64 -d > /opt/maestrly-desktop/${name}`
    ),
    'id maestrlybot >/dev/null 2>&1 || useradd --system --user-group --create-home --home-dir /home/maestrlybot --shell /usr/sbin/nologin maestrlybot',
    'install -d -o maestrlybot -g maestrlybot /home/maestrlybot/workspace',
    'runuser -u maestrlybot -- env HOME=/home/maestrlybot MAESTRLY_DESKTOP_CONFIG=/opt/maestrly-desktop dbus-run-session -- sh /opt/maestrly-desktop/desktop-session.sh &',
    'desktop_pid=$!',
    'sleep 15',
    'DISPLAY=:10 xdpyinfo >/dev/null',
    'pgrep -u maestrlybot -x openbox >/dev/null',
    'pgrep -u maestrlybot -x pcmanfm >/dev/null',
    'pgrep -u maestrlybot -x xterm >/dev/null',
    "printf '\\nMAESTRLY_DESKTOP_MEASURE_BEGIN\\n' > /dev/ttyAMA0",
    'cat /proc/meminfo > /dev/ttyAMA0',
    "ps -eo comm,rss | grep -E '(Xvfb|openbox|pcmanfm|xterm|dbus-daemon)' > /dev/ttyAMA0",
    "printf '\\nMAESTRLY_DESKTOP_MEASURE_END\\n' > /dev/ttyAMA0",
    'kill $desktop_pid || true',
    'pkill -u maestrlybot || true',
    'set -eu',
    'test "$(uname -m)" = aarch64',
    'systemctl enable --now qemu-guest-agent.service',
    'systemctl mask systemd-networkd-wait-online.service',
    'install -d -m 0755 /var/lib/maestrly-image',
    'dpkg-query -W > /var/lib/maestrly-image/packages.txt',
    `printf '%s\\n' '${instanceId}' > /var/lib/maestrly-image/build-id`,
    "printf 'users: []\\ndisable_root: true\\nssh_pwauth: false\\ndatasource_list: [ NoCloud ]\\n' > /etc/cloud/cloud.cfg.d/90-maestrly.cfg",
    "printf 'network: {config: disabled}\\n' > /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg",
    'passwd -l root',
    'rm -rf /root/.ssh /home/ubuntu/.ssh',
    'rm -f /etc/ssh/ssh_host_* /etc/netplan/*.yaml /root/.bash_history /home/ubuntu/.bash_history',
    'apt-get clean',
    'cloud-init clean --logs --machine-id --seed',
    'rm -f /var/lib/dbus/machine-id',
    'ln -s /etc/machine-id /var/lib/dbus/machine-id',
    "printf '\nMAESTRLY_PACKAGES_BEGIN\n' > /dev/ttyAMA0",
    'cat /var/lib/maestrly-image/packages.txt > /dev/ttyAMA0',
    "printf '\nMAESTRLY_PACKAGES_END\n' > /dev/ttyAMA0",
    'sync',
    `printf '\\nMAESTRLY_IMAGE_BUILT:${instanceId}\\n' > /dev/ttyAMA0`,
    '/sbin/shutdown -h now',
  ].join('\n')
  return `#cloud-config\nusers: []\ndisable_root: true\nssh_pwauth: false\nruncmd:\n  - [sh, -c, ${JSON.stringify(cleanup)}]\n`
}

export async function buildBotImage(config, root) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || config.architecture !== 'arm64')
    throw new Error('IMAGE_BUILD_PLATFORM: native Arm64 macOS required for QEMU image preparation')
  if (
    !/^\d{8}$/.test(config.releaseDate ?? '') ||
    !/^https:\/\/cloud-images(?:-archive)?\.ubuntu\.com\/releases\/noble\/release-\d{8}\//.test(
      config.sourceUrl ?? ''
    ) ||
    !config.sourceUrl.includes(`release-${config.releaseDate}/`)
  )
    throw new Error('IMAGE_SOURCE: dated official Ubuntu Noble base required')
  const runtime = validateBuildConfig(JSON.parse(await readFile(config.runtimeBuildConfig, 'utf8')))
  if (runtime.architecture !== config.architecture || !runtime.firmware || !runtime.firmwareVars)
    throw new Error('IMAGE_RUNTIME: matching pinned runtime and UEFI code/vars required')
  const executable = async (name) => {
    const entry = runtime.files.find((file) => file.path === name)
    if (!entry) throw new Error(`IMAGE_RUNTIME: missing ${name}`)
    return verifyInput(runtime.inputDirectory, entry)
  }
  const qemu = await executable('bin/qemu-system-aarch64')
  const qemuImg = await executable('bin/qemu-img')
  const firmware = await executable(runtime.firmware)
  const vars = await executable(runtime.firmwareVars)
  // Verify every transitive input as well, before executing any supplied binary.
  for (const entry of runtime.files) await verifyInput(runtime.inputDirectory, entry)
  const base = await verifyInput(config.inputDirectory, config.base)
  const metadata = JSON.parse(run(qemuImg, ['info', '--output=json', base]))
  if (
    metadata.format !== 'qcow2' ||
    metadata['backing-filename'] ||
    metadata['format-specific']?.data?.['data-file'] ||
    metadata['virtual-size'] > 12 * 1024 ** 3
  )
    throw new Error('IMAGE_BASE: self-contained qcow2 up to 12 GiB required')
  const instanceId = randomUUID()
  const desktopFiles = Object.fromEntries(
    await Promise.all(
      ['desktop-session.sh', 'openbox-rc.xml', 'openbox-menu.xml'].map(async (name) => [
        name,
        await readFile(path.join(root, 'deploy/bot-runtime/linux', name), 'utf8'),
      ])
    )
  )
  const userData = imageBuildUserData(config, instanceId, desktopFiles)
  const output = path.join(root, 'dist', `ubuntu-24.04-${config.releaseDate}-bot-desktop-arm64.qcow2`)
  try {
    await lstat(output)
    throw new Error('OUTPUT_EXISTS: preserve previous image')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await mkdir(path.dirname(output), { recursive: true })
  const temporary = await mkdtemp('/private/tmp/mbi-')
  const staging = `${output}.staging-${instanceId}`
  const logFile = path.join(temporary, 'console.log')
  try {
    run(qemuImg, ['convert', '-f', 'qcow2', '-O', 'qcow2', base, staging])
    run(qemuImg, ['resize', '-f', 'qcow2', staging, '12G'])
    await cp(vars, path.join(temporary, 'vars.fd'))
    await mkdir(path.join(temporary, 'seed'))
    await writeFile(path.join(temporary, 'seed/user-data'), userData)
    await writeFile(
      path.join(temporary, 'seed/meta-data'),
      `instance-id: ${instanceId}\nlocal-hostname: maestrly-bot-image-build\n`
    )
    await writeFile(
      path.join(temporary, 'seed/network-config'),
      'version: 2\nethernets:\n  build:\n    match: {name: "e*"}\n    dhcp4: true\n'
    )
    run('/usr/bin/hdiutil', [
      'makehybrid',
      '-iso',
      '-joliet',
      '-default-volume-name',
      'CIDATA',
      '-o',
      path.join(temporary, 'seed.iso'),
      path.join(temporary, 'seed'),
    ])
    const args = [
      '-name',
      'maestrly-bot-image-build',
      '-uuid',
      instanceId,
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
      `file:${logFile}`,
      '-drive',
      `if=pflash,format=raw,readonly=on,file=${firmware}`,
      '-drive',
      `if=pflash,format=raw,file=${path.join(temporary, 'vars.fd')}`,
      '-blockdev',
      JSON.stringify({
        driver: 'file',
        filename: staging,
        'node-name': 'image-file',
      }),
      '-blockdev',
      JSON.stringify({
        driver: 'qcow2',
        file: 'image-file',
        'node-name': 'image',
      }),
      '-device',
      'virtio-blk-pci,drive=image',
      '-blockdev',
      JSON.stringify({
        driver: 'file',
        filename: path.join(temporary, 'seed.iso'),
        'node-name': 'seed-file',
        'read-only': true,
      }),
      '-blockdev',
      JSON.stringify({
        driver: 'raw',
        file: 'seed-file',
        'node-name': 'seed',
        'read-only': true,
      }),
      '-device',
      'virtio-blk-pci,drive=seed',
      '-netdev',
      'user,id=buildnet',
      '-device',
      'virtio-net-pci,netdev=buildnet,romfile=',
      '-chardev',
      `socket,path=${path.join(temporary, 'qga')},server=on,wait=off,id=qga0`,
      '-device',
      'virtio-serial-pci',
      '-device',
      'virtserialport,chardev=qga0,name=org.qemu.guest_agent.0',
    ]
    let lastProgress = Date.now()
    await new Promise((resolve, reject) => {
      const child = spawn(qemu, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { PATH: '/usr/bin:/bin', HOME: temporary },
        shell: false,
      })
      let errors = ''
      let failure
      let killTimer
      const terminate = (error) => {
        if (failure) return
        failure = error
        child.kill('SIGTERM')
        killTimer = setTimeout(() => child.kill('SIGKILL'), 5000)
      }
      const interrupt = () => terminate(new Error('IMAGE_CANCELLED: disposable build interrupted'))
      process.once('SIGINT', interrupt)
      process.once('SIGTERM', interrupt)
      const timer = setTimeout(
        () => terminate(new Error('IMAGE_TIMEOUT: build VM did not shut down within 20 minutes')),
        20 * 60_000
      )
      const interval = setInterval(async () => {
        if (Date.now() - lastProgress < 25_000) return
        lastProgress = Date.now()
        const size = await stat(logFile)
          .then((info) => info.size)
          .catch(() => 0)
        if (size > 16 * 1024 * 1024) {
          terminate(new Error('IMAGE_LOG_LIMIT'))
          return
        }
        console.log(`Image preparation running; bounded serial log ${size} bytes`)
      }, 5000)
      child.stderr.on('data', (chunk) => {
        errors = (errors + chunk).slice(-2048)
      })
      const cleanup = () => {
        clearTimeout(timer)
        clearTimeout(killTimer)
        clearInterval(interval)
        process.removeListener('SIGINT', interrupt)
        process.removeListener('SIGTERM', interrupt)
      }
      child.once('error', (error) => {
        cleanup()
        reject(error)
      })
      child.once('close', (code) => {
        cleanup()
        failure
          ? reject(failure)
          : code === 0
            ? resolve()
            : reject(new Error(`IMAGE_QEMU: build process exited ${code}: ${errors}`))
      })
    })
    const consoleText = await readFile(logFile, 'utf8')
    if (!consoleText.includes(`MAESTRLY_IMAGE_BUILT:${instanceId}`))
      throw new Error('IMAGE_NOT_PREPARED: guest did not confirm package installation and cleanup')
    const packageInventory = consoleText
      .replaceAll('\r', '')
      .split('MAESTRLY_PACKAGES_BEGIN\n')[1]
      ?.split('\nMAESTRLY_PACKAGES_END')[0]
    if (!packageInventory?.includes('qemu-guest-agent\t' + config.guestAgentVersion))
      throw new Error('IMAGE_PACKAGE_MISMATCH: expected installed package inventory')
    for (const [name, version] of Object.entries(config.packages)) {
      if (
        !packageInventory.split('\n').includes(`${name}\t${version}`) &&
        !packageInventory.split('\n').includes(`${name}:arm64\t${version}`)
      )
        throw new Error(`IMAGE_PACKAGE_MISMATCH: ${name}`)
    }
    run(qemuImg, ['check', '-f', 'qcow2', staging])
    const file = await open(staging, 'r+')
    try {
      await file.sync()
    } finally {
      await file.close()
    }
    await chmod(staging, 0o444)
    const digest = await sha256(staging)
    const manifest = {
      version: 1,
      purpose: 'bot-desktop-prerequisites; install separately verified bot runtime bundle before use',
      requestedPackages: config.packages,
      desktopMeasurement:
        consoleText
          .replaceAll('\r', '')
          .split('MAESTRLY_DESKTOP_MEASURE_BEGIN\n')[1]
          ?.split('\nMAESTRLY_DESKTOP_MEASURE_END')[0] ?? null,
      measurementConditions:
        '2 vCPU, 2048 MiB build VM, 15 seconds after desktop launch; browser absent; not minimum RAM or cold boot qualification',
      id: `ubuntu-24.04-${config.releaseDate}-bot-desktop-arm64`,
      architecture: 'arm64',
      releaseDate: config.releaseDate,
      sourceUrl: config.sourceUrl,
      sourceSha256: config.base.sha256,
      sha256: digest,
      virtualSizeGiB: 12,
      guestAgentVersion: config.guestAgentVersion,
      packageInventory,
      runtime: {
        qemuVersion: runtime.qemuVersion,
        qemuSha256: runtime.files.find((file) => file.path === 'bin/qemu-system-aarch64').sha256,
      },
      qualification: 'prepared-on-controller-not-qualified-on-target',
      buildNetwork: 'user-mode egress in disposable builder only, no port forwards',
      guestNetwork: 'production provider must supply no NIC',
      reproducibility: 'Pinned base and requested QGA version, output hash recorded; no byte-for-byte claim',
    }
    await writeFile(`${staging}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`)
    await rename(staging, output)
    await rename(`${staging}.manifest.json`, `${output}.manifest.json`)
    console.log(`Prepared image: ${output}\nSHA256: ${digest}\nMac mini qualification remains required.`)
    return manifest
  } finally {
    // Only uniquely created build files; never a managed Host VM or shared base.
    await rm(staging, { force: true })
    await rm(`${staging}.manifest.json`, { force: true })
    await rm(temporary, { recursive: true, force: true })
  }
}

export const requiredBotPackages = [
  'qemu-guest-agent',
  'xvfb',
  'openbox',
  'pcmanfm',
  'xterm',
  'dbus-x11',
  'x11-utils',
  'xauth',
  'xdotool',
  'scrot',
  // Read-only live screen: X0tigervnc scrapes the session display into a private Unix socket.
  'tigervnc-scraping-server',
  'fonts-liberation',
  'libnss3',
  'libnspr4',
  'libatk1.0-0t64',
  'libatk-bridge2.0-0t64',
  'libcups2t64',
  'libdrm2',
  'libdbus-1-3',
  'libxcb1',
  'libxkbcommon0',
  'libatspi2.0-0t64',
  'libx11-6',
  'libxcomposite1',
  'libxdamage1',
  'libxext6',
  'libxfixes3',
  'libxrandr2',
  'libgbm1',
  'libcairo2',
  'libpango-1.0-0',
  'libasound2t64',
]
export function validateBotPackages(packages) {
  if (!packages || requiredBotPackages.some((name) => !packages[name]))
    throw new Error('BOT_PACKAGES: all desktop and browser prerequisites must be pinned')
  for (const [name, version] of Object.entries(packages)) {
    if (
      !requiredBotPackages.includes(name) ||
      typeof version !== 'string' ||
      !/^[0-9][A-Za-z0-9.+:~_-]*$/.test(version)
    )
      throw new Error('BOT_PACKAGES: exact allowed package versions required')
  }
}
