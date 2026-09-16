import { lstat, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { probeVnc, vncArguments, VncTransmitter } from '../src/desktop/vnc-server.js'
import { temporary } from './helpers.js'

const PARAMETERS = ['display', 'desktop', 'rfbport', 'rfbunixpath', 'rfbunixmode', 'SecurityTypes', 'AcceptKeyEvents', 'AcceptPointerEvents', 'AcceptSetDesktopSize', 'AlwaysShared', 'NeverShared', 'DisconnectClients', 'FrameRate', 'QueryConnect', 'UseBlacklist']
async function fakeBinary(version: string, parameters: string[], server = '') {
  const directory = await temporary()
  const path = join(directory, 'X0tigervnc')
  const help = parameters.map((name) => `  ${name.padEnd(14)} - description`).join('\\n')
  await writeFile(path, `#!/bin/sh
case "$1" in
  -version) echo "TigerVNC Server version ${version}, built 2024-04-01"; exit 0 ;;
  -h) printf 'Usage: X0tigervnc\\nGlobal Parameters:\\n${help}\\n' >&2; exit 1 ;;
esac
${server}
`)
  await chmod(path, 0o755)
  return path
}
it('accepts 1.13 only because its scraping server has no clipboard, and fails closed otherwise', async () => {
  const absent = await probeVnc(await fakeBinary('1.13.1', PARAMETERS))
  expect(absent).toMatchObject({ version: '1.13.1', clipboard: 'absent' })
  const args = vncArguments(absent, { display: ':10', socketPath: '/run/maestrly-desktop/s/rfb.sock' })
  for (const flag of ['-rfbport=-1', '-rfbunixmode=384', '-SecurityTypes=None', '-AcceptKeyEvents=0', '-AcceptPointerEvents=0', '-AcceptSetDesktopSize=0', '-AlwaysShared=1', '-DisconnectClients=0', '-QueryConnect=0'])
    expect(args).toContain(flag)
  expect(args.some((arg) => /CutText|Primary/.test(arg))).toBe(false)
  await expect(probeVnc(await fakeBinary('1.14.0', PARAMETERS))).rejects.toMatchObject({ code: 'DESKTOP_UPDATE_REQUIRED' })
  await expect(probeVnc(await fakeBinary('1.13.1', [...PARAMETERS, 'SendCutText']))).rejects.toMatchObject({ code: 'DESKTOP_UPDATE_REQUIRED' })
  const withClipboard = await probeVnc(await fakeBinary('1.14.1', [...PARAMETERS, 'AcceptCutText', 'SendCutText', 'SendPrimary', 'SetPrimary']))
  expect(vncArguments(withClipboard, { display: ':10', socketPath: '/tmp/r/rfb.sock' })).toEqual(expect.arrayContaining(['-AcceptCutText=0', '-SendCutText=0', '-SendPrimary=0', '-SetPrimary=0']))
  await expect(probeVnc(await fakeBinary('1.13.1', PARAMETERS.filter((name) => name !== 'rfbunixpath')))).rejects.toMatchObject({ code: 'DESKTOP_UPDATE_REQUIRED' })
  await expect(probeVnc('/nonexistent/X0tigervnc')).rejects.toMatchObject({ code: 'DESKTOP_UPDATE_REQUIRED' })
})
it('refuses unstructured displays and socket paths', () => {
  const probe = { version: '1.13.1', parameters: PARAMETERS, clipboard: 'absent' as const }
  expect(() => vncArguments(probe, { display: ':10 -rfbport=5900', socketPath: '/tmp/x.sock' })).toThrow()
  expect(() => vncArguments(probe, { display: ':10', socketPath: 'relative.sock' })).toThrow()
  expect(() => vncArguments(probe, { display: ':10', socketPath: '/tmp/../etc/x.sock' })).toThrow()
})
// A stand-in server that opens the requested Unix socket with the requested mode.
const server = (mode: string) => `for arg in "$@"; do case "$arg" in -rfbunixpath=*) sock="\${arg#-rfbunixpath=}";; esac; done
exec "${process.execPath}" -e 'const n=require("net"),fs=require("fs");const s=n.createServer(c=>c.end("RFB 003.008\\n"));s.listen(process.argv[1],()=>fs.chmodSync(process.argv[1],${mode}));process.on("SIGTERM",()=>{s.close();process.exit(0)})' "$sock"`
it.skipIf(process.platform === 'win32')('starts on demand, stops only the transmitter after the last viewer, and rejects a non-private socket', async () => {
  const directory = await temporary()
  const binary = await fakeBinary('1.13.1', PARAMETERS, server('0o600'))
  const socketPath = join(directory, 'screen', 'rfb.sock')
  const transmitter = new VncTransmitter({ display: ':10', socketPath, environment: {}, binary, idleMs: 50, verifyListeners: false })
  await transmitter.acquire()
  await transmitter.acquire()
  expect((await lstat(socketPath)).isSocket()).toBe(true)
  expect(((await lstat(join(directory, 'screen'))).mode & 0o777).toString(8)).toBe('700')
  transmitter.release()
  await new Promise((resolve) => setTimeout(resolve, 120))
  expect(transmitter.running).toBe(true)
  transmitter.release()
  await new Promise((resolve) => setTimeout(resolve, 400))
  expect(transmitter.running).toBe(false)
  await expect(lstat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
  const open = new VncTransmitter({ display: ':10', socketPath: join(directory, 'open', 'rfb.sock'), environment: {}, binary: await fakeBinary('1.13.1', PARAMETERS, server('0o666')), verifyListeners: false })
  await expect(open.acquire()).rejects.toMatchObject({ code: 'DESKTOP_CONFIGURATION' })
  expect(open.running).toBe(false)
  await transmitter.close()
})
