#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { FLEET_PROTOCOL_VERSION } from '@maestrly/bot-fleet-protocol'

export function run(argv: string[], write: (text: string) => void = console.log): number {
  if (argv.includes('--version')) {
    write('0.1.0 (protocol ' + FLEET_PROTOCOL_VERSION + ')')
    return 0
  }

  const [command] = argv
  if (!command || !['serve', 'pair', 'devices', 'doctor'].includes(command)) {
    write('Usage: maestrly-bot-gateway <serve|pair|devices|doctor> [--version]')
    return 1
  }
  write('not implemented')
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run(process.argv.slice(2))
}
