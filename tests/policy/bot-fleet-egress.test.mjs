import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const root = path.resolve(import.meta.dirname, '../..')
const guard = path.join(root, 'deploy/bot-fleet/egress-guard.sh')
const entrypoint = path.join(root, 'deploy/bot-fleet/bot-entrypoint.sh')
const skip = process.platform === 'win32' && 'requires POSIX shell and executable fakes'

test('bot entrypoint and guard have valid bash syntax', { skip }, () => {
  for (const script of [guard, entrypoint]) {
    const result = spawnSync('bash', ['-n', script], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
})

function runGuard(fail = false, ipv6 = false) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-egress-'))
  const log = path.join(dir, 'calls.jsonl')
  const fake = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const tool = path.basename(process.argv[1])
const args = process.argv.slice(2)
if (tool.startsWith('iptables') || tool.startsWith('ip6tables')) {
  if (process.env.FAIL_TABLES === '1') process.exit(1)
  fs.appendFileSync(process.env.CALLS, JSON.stringify([tool, ...args]) + '\\n')
} else if (tool === 'ip') {
  const key = args.join(' ')
  if (key === '-4 route show default') console.log('default via 172.20.0.1 dev eth0')
  if (key === '-4 -o route show scope link') console.log('172.20.0.0/16 dev eth0 proto kernel scope link src 172.20.0.5')
  if (process.env.FAKE_IPV6 === '1') {
    if (key === '-6 -o addr show scope global') console.log('2: eth0    inet6 fd00:20::5/64 scope global nodad \\       valid_lft forever preferred_lft forever')
    if (key === '-6 route show default') console.log('default via fd00:20::1 dev eth0 metric 1024 pref medium')
    if (key === '-6 -o route show') {
      console.log('fd00:20::/64 dev eth0 proto kernel metric 256 pref medium')
      console.log('fe80::/64 dev eth0 proto kernel metric 256 pref medium')
      console.log('default via fd00:20::1 dev eth0 metric 1024 pref medium')
    }
  } else if (key.startsWith('-6 ')) process.exit(process.env.FAKE_NO_IPV6 === '1' ? 2 : 0)
} else if (tool === 'getent') {
  if (args[1] === 'host.docker.internal') console.log('192.168.65.254 STREAM host.docker.internal')
  else process.exit(2)
}
`
  for (const name of ['iptables', 'iptables-legacy', 'ip6tables', 'ip6tables-legacy', 'ip', 'getent']) {
    const file = path.join(dir, name)
    writeFileSync(file, fake)
    chmodSync(file, 0o755)
  }
  const result = spawnSync('bash', [guard], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: dir + path.delimiter + process.env.PATH,
      CALLS: log,
      FAIL_TABLES: fail ? '1' : '0',
      FAKE_IPV6: ipv6 === true ? '1' : '0',
      FAKE_NO_IPV6: ipv6 === 'unsupported' ? '1' : '0',
    },
  })
  const calls = !fail ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []
  rmSync(dir, { recursive: true, force: true })
  return { result, calls }
}

test('guard installs ordered IPv4 rules for synthetic routes', { skip }, () => {
  const { result, calls } = runGuard()
  assert.equal(result.status, 0, result.stderr)
  const destinations = [
    '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
    '172.16.0.0/12', '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15',
    '224.0.0.0/4', '240.0.0.0/4',
  ]
  assert.deepEqual(calls, [
    ['iptables', '-w', '-S', 'OUTPUT'],
    ['iptables', '-w', '-F', 'OUTPUT'],
    ['iptables', '-w', '-A', 'OUTPUT', '-o', 'lo', '-j', 'ACCEPT'],
    ['iptables', '-w', '-A', 'OUTPUT', '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT'],
    ['iptables', '-w', '-A', 'OUTPUT', '-d', '172.20.0.1', '-j', 'REJECT'],
    ['iptables', '-w', '-A', 'OUTPUT', '-d', '192.168.65.254', '-j', 'REJECT'],
    ['iptables', '-w', '-A', 'OUTPUT', '-d', '172.20.0.0/16', '-j', 'ACCEPT'],
    ...destinations.map((subnet) => ['iptables', '-w', '-A', 'OUTPUT', '-d', subnet, '-j', 'REJECT']),
  ])
  assert.match(result.stderr, /\[egress\] Private networks blocked/)
})

test('guard rejects the IPv6 gateway before accepting its own prefix', { skip }, () => {
  const { result, calls } = runGuard(false, true)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(
    calls.filter(([tool]) => tool === 'ip6tables'),
    [
      ['ip6tables', '-w', '-S', 'OUTPUT'],
      ['ip6tables', '-w', '-F', 'OUTPUT'],
      ['ip6tables', '-w', '-A', 'OUTPUT', '-o', 'lo', '-j', 'ACCEPT'],
      ['ip6tables', '-w', '-A', 'OUTPUT', '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT'],
      ['ip6tables', '-w', '-A', 'OUTPUT', '-p', 'ipv6-icmp', '-j', 'ACCEPT'],
      ['ip6tables', '-w', '-A', 'OUTPUT', '-d', 'fd00:20::1', '-j', 'REJECT'],
      ['ip6tables', '-w', '-A', 'OUTPUT', '-d', 'fd00:20::/64', '-j', 'ACCEPT'],
      ...['::1/128', 'fc00::/7', 'fe80::/10', 'ff00::/8'].map((prefix) => ['ip6tables', '-w', '-A', 'OUTPUT', '-d', prefix, '-j', 'REJECT']),
    ]
  )
})

test('guard leaves IPv6 alone on a kernel without it', { skip }, () => {
  const { result, calls } = runGuard(false, 'unsupported')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(calls.filter(([tool]) => tool.startsWith('ip6tables')).length, 0)
})

test('guard refuses to start without an available firewall', { skip }, () => {
  const { result } = runGuard(true)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /\[egress\]/)
})

test('entrypoint guards before session setup and removes NET_ADMIN', { skip }, () => {
  const source = readFileSync(entrypoint, 'utf8')
  assert.ok(source.indexOf('$(id -u)') < source.indexOf('--session'))
  assert.match(source, /maestrly-egress-guard/)
  assert.match(source, /--bounding-set=-net_admin/)
  assert.match(source, /MAESTRLY_BOT_EGRESS=public needs the container to start as root; refusing to start without the network guard/)
})
