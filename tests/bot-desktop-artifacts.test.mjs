// Phase 3 live desktop: static guarantees over the shipped sources and deployment files.
// Runtime behaviour is covered by the workspace suites and the opt-in laboratory.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')

test('the screen server is read-only, TCP-less and reachable only through a private Unix socket', () => {
  const vnc = read('apps/bot-runtime/src/desktop/vnc-server.ts')
  for (const flag of ["'-rfbport=-1'", "'-rfbunixmode=384'", "'-AcceptKeyEvents=0'", "'-AcceptPointerEvents=0'", "'-AcceptSetDesktopSize=0'", "'-DisconnectClients=0'", "'-QueryConnect=0'"])
    assert.ok(vnc.includes(flag), flag)
  assert.match(vnc, /'\/usr\/bin\/X0tigervnc'/)
  assert.match(vnc, /mode: 0o700/)
  assert.match(vnc, /assertNoTcpListener\(child\.pid\)/)
  assert.doesNotMatch(vnc, /x11vnc|Xvnc|xrdp|-interface|-localhost=0|rfbport=\d/)
})

test('human input never travels over RFB: the app viewer only decodes, on loopback', () => {
  assert.match(read('apps/bot-desktop/src/renderer/features/desktop/DesktopCanvas.tsx'), /rfb\.viewOnly = true/)
  assert.equal(JSON.parse(read('apps/bot-desktop/package.json')).dependencies['@novnc/novnc'], '1.7.0')
  assert.match(read('apps/bot-desktop/src/main/desktop-view-server.ts'), /host: '127\.0\.0\.1', port: 0/)
  const csp = /connect-src ([^;]+);/.exec(read('apps/bot-desktop/src/renderer/index.html'))?.[1] ?? ''
  for (const source of csp.split(/\s+/)) assert.match(source, /^('self'|ws:\/\/(localhost|127\.0\.0\.1):\*)$/, source)
})

test('desktop services run unprivileged per session; their admin socket is root-only', () => {
  const service = read('deploy/bot-runtime/linux/maestrly-bot-desktop-services@.service')
  assert.match(service, /^User=nobody$/m)
  assert.match(service, /MAESTRLY_BOT_SESSION_REQUIRED=1/)
  const socket = read('deploy/bot-runtime/linux/maestrly-bot-desktop-services@.socket')
  assert.match(socket, /^ListenStream=\/run\/maestrly-vm\/%i\/desktop-admin\.sock$/m)
  assert.match(socket, /^SocketUser=root$/m)
  assert.match(socket, /^SocketMode=0600$/m)
  const install = read('deploy/bot-runtime/linux/install.sh')
  assert.match(install, /maestrly-bot-desktop-services@\.service maestrly-bot-desktop-services@\.socket/)
  assert.match(install, /org\.maestrly\.bot\.desktop\.0/)
  const profile = read('apps/bot-runtime/src/vm/session-profile.ts')
  assert.match(profile, /-\/run\/maestrly-desktop/)
  assert.doesNotMatch(profile, /PartOf=/)
})

test('the media lane is a dedicated virtio port on a NIC-less VM; the Host exposes only local sockets', () => {
  assert.match(read('packages/host-protocol/src/desktop-media.ts'), /DESKTOP_PORT_NAME = 'org\.maestrly\.bot\.desktop\.0'/)
  const profile = read('packages/host-core/src/guest/profile.ts')
  assert.match(profile, /virtserialport,chardev=botdesktop0,name=\$\{DESKTOP_PORT_NAME\}/)
  assert.doesNotMatch(profile, /netdev|-nic|user,id/)
  assert.match(read('apps/host/src/transport.ts'), /DESKTOP_SOCKET_PATH = '\/Library\/MaestrlyHost\/run\/desktop\.sock'/)
  const transport = read('apps/bot-desktop/src/main/desktop-transport.ts')
  assert.match(transport, /'desktop-stdio'/)
})

test('updating an environment keeps one earlier installation, checks space first and stays usable after a failure', () => {
  const install = read('packages/host-core/src/guest/install.ts')
  assert.match(install, /RETAIN_PREVIOUS/)
  assert.match(install, /mv -- "\$p" "\$r"/)
  assert.doesNotMatch(install, /rm -rf[^\n]*maestrly-bot\.previous/)
  assert.ok(install.indexOf("'retain', bundle.version") < install.indexOf('GUEST_INSTALLER_PATH, \'--bundle\''), 'retention runs before the installer')
  // Bounded retention: pruning and the space check run before anything is copied into the guest.
  assert.ok(install.indexOf("PRUNE_RETAINED, 'prune'") < install.indexOf("'guest-file-open'"), 'space is checked before the transfer')
  assert.match(install, /GUEST_DISK_SPACE/)
  assert.match(install, /CLEAN_FAILED, 'clean'/)
  assert.match(install, /FINISH_INSTALL, 'finish'/)
  assert.match(read('packages/host-core/src/environments/service.ts'), /record\?\.state === 'preparing' \|\| record\?\.state === 'verifying'\) throw new HostError\('ENVIRONMENT_BUSY'/)
  const environments = read('packages/host-core/src/environments/service.ts')
  assert.match(environments, /updateAvailable: 'desktop'/)
  assert.match(read('packages/host-protocol/src/environments.ts'), /updateAvailable: z\.enum\(\['desktop'\]\)\.optional\(\)/)
})

test('the window manager binds every window control a person or the bot clicks', () => {
  // A config file replaces Openbox's defaults: a missing binding leaves a dead button.
  const rc = read('deploy/bot-runtime/linux/openbox-rc.xml')
  const context = (name) => new RegExp(`<context name="${name}">([\\s\\S]*?)</context>`).exec(rc)?.[1] ?? ''
  assert.match(context('Titlebar'), /button="Left" action="Drag"><action name="Move"\/>/)
  assert.match(context('Titlebar'), /action="DoubleClick"><action name="ToggleMaximize"\/>/)
  assert.match(context('Close'), /button="Left" action="Click"><action name="Close"\/>/)
  assert.match(context('Maximize'), /button="Left" action="Click"><action name="ToggleMaximize"\/>/)
  assert.match(context('Client'), /button="Left" action="Press"><action name="Focus"\/><action name="Raise"\/>/)
  for (const edge of ['top', 'left', 'right', 'bottom']) assert.match(rc, new RegExp(`<edge>${edge}</edge>`))
  // No minimize (there is no panel to restore from), no shading, no desktop switching.
  assert.match(rc, /<titleLayout>NLMC<\/titleLayout>/)
  assert.doesNotMatch(rc, /name="Iconify"|name="Shade"|GoToDesktop/)
  assert.match(read('apps/bot-desktop/src/renderer/style.css'), /\.desktop-canvas\.local-cursor \.desktop-screen canvas \{ cursor:default !important; \}/)
})

test('the prepared image pins the screen server and phase 3 has its own checks', () => {
  assert.match(read('scripts/build-bot-image-qemu.mjs'), /'tigervnc-scraping-server'/)
  const scripts = JSON.parse(read('package.json')).scripts
  for (const name of ['check:bot-phase3', 'test:bot-phase3', 'lab:bot:desktop']) assert.ok(scripts[name], `missing script ${name}`)
  assert.match(scripts.check, /check:bot-phase3/)
  assert.match(scripts.test, /test:bot-phase3/)
  const notices = read('THIRD_PARTY_NOTICES.md')
  assert.match(notices, /tigervnc-scraping-server/)
  assert.match(notices, /noVNC/)
})
