// Offline, disposable native ARM64 guest integration. No controller credentials enter the ISO.
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { run, sha256, validateBuildConfig, verifyInput } from './host-build-utils.mjs'

export const browserProbe = String.raw`
import { chromium } from '/opt/maestrly-bot/node_modules/playwright-core/index.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
if (process.getuid() === 0) throw Error('non-root required');
const memory = async () => ({ meminfo: await readFile('/proc/meminfo','utf8'), at: new Date().toISOString(), processes:execFileSync('/bin/ps',['-eo','pid,uid,comm,rss'],{encoding:'utf8'}) });
const idle = await memory();
const browser = await chromium.launch({executablePath:'/opt/maestrly-bot/chromium/chrome', headless:false, chromiumSandbox:true, args:['--disable-background-networking']});
try {
 const page = await browser.newPage({viewport:{width:1000,height:700}});
 await page.goto('file:///mnt/maestrly-probe/page.html');
 await page.getByRole('button',{name:'Verify click'}).click();
 if (await page.locator('#result').textContent() !== 'Clicked successfully') throw Error('click failed');
 await new Promise(r=>setTimeout(r,3000));
 const browserMemory = await memory();
 const png = await page.screenshot({path:'/home/maestrlybot/workspace/probe.png'});
 const sandbox = await browser.newPage(); await sandbox.goto('chrome://sandbox');
 const status = await sandbox.locator('body').innerText();
 if (!/Seccomp-BPF sandbox\s+Yes/.test(status) || !/Layer 1 Sandbox\s+Namespace/.test(status) || !/PID namespaces\s+Yes/.test(status) || !/Network namespaces\s+Yes/.test(status)) throw Error('sandbox not confirmed: '+status);
 console.log('PROBE_RESULT:'+JSON.stringify({uid:process.getuid(),idle,browser:browserMemory,sandbox:status,screenshot:{bytes:png.length,sha256:createHash('sha256').update(png).digest('hex')}}));
 console.log('PROBE_PNG:'+png.toString('base64'));
} finally { await browser.close(); }
`
export function guestScript(digest, version = '0.1.0-20260913') {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw Error('Invalid bundle digest')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(version)) throw Error('Invalid bundle version')
  return `#!/bin/bash
set -euxo pipefail
trap '' HUP
systemctl mask --now serial-getty@ttyAMA0.service
exec > /dev/ttyAMA0 2>&1
trap 'echo PROBE_FAILED; journalctl -u maestrly-bot-runtime -u maestrly-bot-desktop --no-pager -n 100' ERR
mkdir -p /mnt/maestrly-probe
mount -o ro /dev/disk/by-label/CIDATA /mnt/maestrly-probe
# Establish persistent user data and identity before the in-place addon.
printf 'retain-this-user-data\\n' > /home/phase1-preservation-sentinel
sha256sum /home/phase1-preservation-sentinel > /tmp/preserved.sha256
cp /etc/machine-id /tmp/preserved.machine-id
findmnt -no UUID / > /tmp/preserved.root-uuid
stat -c '%i:%u:%g:%a' /home > /tmp/preserved.home-stat
bash /mnt/maestrly-probe/install.sh --bundle /mnt/maestrly-probe/runtime.tar --sha256 ${digest} --version ${version}
sha256sum -c /tmp/preserved.sha256
cmp /etc/machine-id /tmp/preserved.machine-id
[ "$(findmnt -no UUID /)" = "$(cat /tmp/preserved.root-uuid)" ]
[ "$(stat -c '%i:%u:%g:%a' /home)" = "$(cat /tmp/preserved.home-stat)" ]
[ "$(ls /sys/class/net)" = lo ]
echo PHASE1_IDENTITY_PRESERVED
/opt/maestrly-bot/runtime/bin/node --version
/opt/maestrly-bot/codex/bin/codex --version
runuser -u maestrlybot -- /opt/maestrly-bot/codex/bin/codex app-server generate-json-schema --out /home/maestrlybot/workspace/schema
find /home/maestrlybot/workspace/schema -type f | wc -l
# The package installer must supply the profile; no probe-only sandbox workaround.
test -f /etc/apparmor.d/maestrly-chromium
systemctl start maestrly-bot-runtime
sleep 20
systemctl is-active maestrly-bot-runtime maestrly-bot-desktop
ps -eo pid,uid,comm,rss
# Probe in the runtime's namespace: it must share the desktop X socket itself.
runtime_pid=$(systemctl show -p MainPID --value maestrly-bot-runtime)
nsenter -t "$runtime_pid" -m -- runuser -u maestrlybot -- env HOME=/home/maestrlybot DISPLAY=:10 /opt/maestrly-bot/runtime/bin/node /mnt/maestrly-probe/browser.mjs
ps -eo pid,uid,comm,rss
echo PROBE_DONE
`
}
export async function verify(root = process.cwd()) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw Error('Native ARM64 macOS required')
  const config = validateBuildConfig(
    JSON.parse(
      await readFile(path.join(root, '.host-lab/runtime-build/host-build-with-image.json'), 'utf8')
    )
  )
  for (const entry of config.files) await verifyInput(config.inputDirectory, entry)
  const bin = (name) => path.join(config.inputDirectory, name)
  const image =
    process.env.MAESTRLY_BOT_VERIFY_IMAGE ??
    path.join(root, 'dist/ubuntu-24.04-20260826-bot-desktop-arm64.qcow2')
  const manifest = JSON.parse(await readFile(image + '.manifest.json', 'utf8'))
  if ((await sha256(image)) !== manifest.sha256) throw Error('Image hash mismatch')
  const bundle = process.env.MAESTRLY_BOT_VERIFY_BUNDLE
  if (!bundle) throw Error('Set MAESTRLY_BOT_VERIFY_BUNDLE to the versioned bundle to verify')
  const digest = await sha256(bundle)
  const bundleManifest = JSON.parse(await readFile(bundle + '.manifest.json', 'utf8'))
  if (bundleManifest.sha256 !== digest || typeof bundleManifest.runtimeVersion !== 'string')
    throw Error('Bundle manifest mismatch')
  await mkdir(path.join(root, '.host-lab'), { recursive: true })
  const evidence = await mkdtemp(path.join(root, '.host-lab/environment-'))
  const sockets = await mkdtemp('/private/tmp/mbe-')
  console.log('Evidence: ' + evidence)
  const seed = path.join(evidence, 'seed')
  await mkdir(seed)
  await cp(bundle, path.join(seed, 'runtime.tar'))
  await writeFile(path.join(seed, 'install.sh'), run('tar', ['-xOf', bundle, './install.sh']))
  await writeFile(path.join(seed, 'browser.mjs'), browserProbe)
  await writeFile(
    path.join(seed, 'page.html'),
    '<html><body><h1>Offline browser verification</h1><button onclick="document.querySelector(\'#result\').textContent=\'Clicked successfully\'">Verify click</button><p id="result">Waiting</p></body></html>'
  )
  await writeFile(
    path.join(seed, 'user-data'),
    '#cloud-config\nusers: []\ndisable_root: true\nssh_pwauth: false\nruncmd:\n  - [bash, -c, ' +
      JSON.stringify(guestScript(digest, bundleManifest.runtimeVersion)) +
      ']\n'
  )
  await writeFile(
    path.join(seed, 'meta-data'),
    `instance-id: ${randomUUID()}\nlocal-hostname: maestrly-offline-probe\n`
  )
  run('/usr/bin/hdiutil', [
    'makehybrid',
    '-iso',
    '-joliet',
    '-default-volume-name',
    'CIDATA',
    '-o',
    path.join(evidence, 'seed.iso'),
    seed,
  ])
  const disk = path.join(evidence, 'guest.qcow2')
  run(bin('bin/qemu-img'), ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', image, disk, '12G'])
  await cp(bin(config.firmwareVars), path.join(evidence, 'vars.fd'))
  const args = [
    '-name',
    'maestrly-offline-probe',
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
    '-nic',
    'none',
    '-serial',
    `file:${evidence}/console.log`,
    '-drive',
    `if=pflash,format=raw,readonly=on,file=${bin(config.firmware)}`,
    '-drive',
    `if=pflash,format=raw,file=${evidence}/vars.fd`,
  ]
  for (const [name, file, format, ro] of [
    ['disk', disk, 'qcow2', false],
    ['seed', path.join(evidence, 'seed.iso'), 'raw', true],
  ])
    args.push(
      '-blockdev',
      JSON.stringify({
        driver: 'file',
        filename: file,
        'node-name': name + 'file',
        'read-only': ro,
      }),
      '-blockdev',
      JSON.stringify({
        driver: format,
        file: name + 'file',
        'node-name': name,
        'read-only': ro,
      }),
      '-device',
      `virtio-blk-pci,drive=${name}`
    )
  args.push('-device', 'virtio-serial-pci')
  for (const [id, name] of [
    ['control', 'org.maestrly.bot.control.0'],
    ['egress', 'org.maestrly.bot.egress.0'],
  ])
    args.push(
      '-chardev',
      `socket,path=${sockets}/${id},server=on,wait=off,id=${id}`,
      '-device',
      `virtserialport,chardev=${id},name=${name}`
    )
  await writeFile(
    path.join(evidence, 'inputs.json'),
    JSON.stringify(
      {
        image,
        imageSha256: manifest.sha256,
        bundle,
        bundleSha256: digest,
        args,
        conditions:
          '2 CPU, 2048MiB, 12GiB; offline local page only; observed usage, not universal minimum',
      },
      null,
      2
    )
  )
  const child = spawn(bin('bin/qemu-system-aarch64'), args, {
    env: { PATH: '/usr/bin:/bin', HOME: evidence },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  const interrupt = () => {
    child.kill('SIGTERM')
  }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  let failure
  child.on('error', (e) => {
    failure = e
  })
  child.stderr.on('data', (b) => process.stderr.write(b))
  let session
  try {
    const { SocketGuestSession } = await import(
      pathToFileURL(path.join(root, 'packages/host-core/dist/guest/session.js'))
    )
    const deadline = Date.now() + 360000
    let inspected = false
    while (Date.now() < deadline) {
      if (failure) throw failure
      const log = await readFile(path.join(evidence, 'console.log'), 'utf8').catch(() => '')
      if (/\nPROBE_FAILED\r?\n/.test(log))
        throw Error('Guest verification failed; inspect console.log')
      if (!inspected && log.includes('+ systemctl start maestrly-bot-runtime')) {
        try {
          session = await SocketGuestSession.open(
            randomUUID(),
            path.join(sockets, 'control'),
            1,
            5000
          )
          const result = await session.request('runtime.inspect', {})
          const account = await session.request('auth.status', {})
          await writeFile(
            path.join(evidence, 'runtime.json'),
            JSON.stringify({ result, account }, null, 2)
          )
          inspected = true
        } catch (e) {
          session?.close()
          session = undefined
          console.log('Control pending: ' + e.message)
        }
      }
      if (/\nPROBE_DONE\r?\n/.test(log)) {
        if (!inspected) {
          session = await SocketGuestSession.open(
            randomUUID(),
            path.join(sockets, 'control'),
            1,
            15000
          )
          await writeFile(
            path.join(evidence, 'runtime.json'),
            JSON.stringify(
              {
                result: await session.request('runtime.inspect', {}),
                account: await session.request('auth.status', {}),
              },
              null,
              2
            )
          )
        }
        const result = JSON.parse(log.match(/PROBE_RESULT:(\{[^\r\n]+\})/)[1])
        await writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2))
        await writeFile(
          path.join(evidence, 'screenshot.png'),
          Buffer.from(log.match(/PROBE_PNG:([A-Za-z0-9+/=]+)/)[1], 'base64')
        )
        console.log('Verified: ' + evidence)
        return evidence
      }
      if (child.exitCode !== null || child.signalCode !== null)
        throw Error('VM exited before verification')
      console.log('VM verification pending; serial bytes ' + log.length)
      await new Promise((r) => setTimeout(r, 5000))
    }
    throw Error('Verification timed out')
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
    session?.close()
    child.kill('SIGTERM')
    await Promise.race([
      new Promise((r) => child.once('close', r)),
      new Promise((r) =>
        setTimeout(() => {
          child.kill('SIGKILL')
          r()
        }, 5000)
      ),
    ])
    await rm(sockets, { recursive: true, force: true })
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  verify().catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
