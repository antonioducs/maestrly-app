import { connect } from 'node:net'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const [mode, label, otherSocket] = process.argv.slice(2)
const workspace = process.env.MAESTRLY_BOT_WORKSPACE
if (mode === 'cross-socket') {
  const outcome = await new Promise(resolve => {
    const socket = connect({ path: otherSocket })
    socket.once('connect', () => { socket.destroy(); resolve('CONNECTED') })
    socket.once('error', error => resolve(error.code))
  })
  if (outcome !== 'EACCES') throw Error('Cross-session endpoint did not deny access: ' + outcome)
  console.log('SOCKET_ISOLATED')
} else if (mode === 'direct') {
  const outcome = await new Promise(resolve => {
    const socket = connect({ host: '1.1.1.1', port: 443 })
    const timeout = setTimeout(() => { socket.destroy(); resolve('TIMEOUT') }, 1000)
    socket.once('connect', () => { clearTimeout(timeout); socket.destroy(); resolve('CONNECTED') })
    socket.once('error', error => { clearTimeout(timeout); resolve(error.code) })
  })
  if (!['ENETUNREACH', 'EHOSTUNREACH'].includes(outcome)) throw Error('Direct network did not fail with no route: ' + outcome)
  console.log('NO_DIRECT_NETWORK')
} else {
  const result = await new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: 3128 })
    const timeout = setTimeout(() => { socket.destroy(); reject(Error('Proxy test timeout')) }, 15000)
    let buffer = '', open = false
    socket.on('error', reject)
    socket.once('connect', () => socket.write('CONNECT public.test:443 HTTP/1.1\r\nHost: public.test:443\r\n\r\n'))
    socket.on('data', bytes => {
      buffer += bytes.toString()
      if (!open && buffer.includes('\r\n\r\n')) {
        if (!buffer.startsWith('HTTP/1.1 200')) { clearTimeout(timeout); socket.destroy(); resolve('DENIED'); return }
        open = true; buffer = ''; socket.write('probe-' + label)
      } else if (open && buffer.includes('echo:probe-' + label)) {
        void writeFile(join(workspace, `stream-${label}.ready`), 'open')
      }
    })
    socket.once('close', () => { clearTimeout(timeout); resolve(open ? 'REVOKED' : 'DENIED') })
  })
  if (mode === 'offline' && result !== 'DENIED' || mode === 'stream' && result !== 'REVOKED') throw Error('Unexpected proxy result')
  console.log(result)
}
