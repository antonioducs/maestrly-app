#!/usr/bin/env node
import { inspectService } from './client.js'
import { doctor } from './doctor.js'
import { daemon } from './main.js'
import { rpcStdio } from './rpc-stdio.js'
import { desktopStdio } from './desktop-stdio.js'

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (args.length) throw Error('Unexpected arguments')
  if (command === 'status') {
    const host = await inspectService()
    process.stdout.write(`${JSON.stringify({ status: host.supported ? 'supported' : 'blocked', ...host })}\n`)
    process.exitCode = host.supported ? 0 : 2
  } else if (command === 'doctor' || command === 'diagnostics') {
    const report = await doctor()
    process.stdout.write(`${JSON.stringify(report)}\n`)
    process.exitCode = report.status === 'supported' ? 0 : 2
  } else if (command === 'daemon') await daemon()
  else if (command === 'rpc-stdio') await rpcStdio()
  else if (command === 'desktop-stdio') await desktopStdio()
  else throw Error('Usage: maestrly-host doctor|status|diagnostics|daemon|rpc-stdio|desktop-stdio')
}
main().catch(() => {
  process.stderr.write(
    process.platform !== 'darwin' && ['daemon', 'rpc-stdio'].includes(process.argv[2] ?? '')
      ? 'maestrly-host: daemon and rpc-stdio require macOS\n'
      : process.platform !== 'darwin' && process.argv[2] === 'desktop-stdio'
        ? 'maestrly-host: desktop-stdio requires macOS\n'
      : 'maestrly-host: command failed; check installation and structured doctor report\n'
  )
  process.exitCode = 1
})
