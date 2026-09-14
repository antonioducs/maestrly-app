import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { connect } from 'node:net'
import type { HostTarget } from '../shared/types'
import { aliasValue } from './validation'
async function sshDestination(alias: string) {
  const { stdout } = await promisify(execFile)('/usr/bin/ssh', ['-G', '--', aliasValue(alias)], { timeout: 5000, maxBuffer: 128 * 1024 })
  const lines = stdout.split('\n')
  const hostname = lines.find(line => line.startsWith('hostname '))?.slice(9).trim()
  const port = Number(lines.find(line => line.startsWith('port '))?.slice(5) ?? 22)
  if (!hostname || /[\s/@?#]/.test(hostname) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Não foi possível resolver o computador cadastrado')
  return { hostname, port }
}
export async function accountEndpointFor(authority: HostTarget, receiver: HostTarget, port: number) {
  let address: string
  if (authority.kind === 'ssh') address = (await sshDestination(authority.alias)).hostname
  else if (receiver.kind === 'ssh') {
    const remote = await sshDestination(receiver.alias)
    // Ask the OS which local address reaches this already trusted Host; no interface scan or discovery.
    address = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: remote.hostname, port: remote.port })
      socket.setTimeout(3000, () => socket.destroy(new Error('Não foi possível conectar o serviço de contas entre estes computadores')))
      socket.once('error', reject)
      socket.once('connect', () => { const local = socket.localAddress; socket.destroy(); local ? resolve(local) : reject(new Error('Endereço local indisponível')) })
    })
  } else address = '127.0.0.1'
  address = address.replace(/^::ffff:/, '')
  return `https://${address.includes(':') && !address.startsWith('[') ? `[${address}]` : address}:${port}/`
}
