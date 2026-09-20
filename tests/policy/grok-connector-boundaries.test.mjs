import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const root = path.resolve(import.meta.dirname, '../..')
const connectors = path.join(root, 'apps/server/src/modules/connectors')
const delegations = path.join(root, 'apps/server/src/modules/delegations')
const plugin = path.join(root, 'plugins/maestrly-development')

function sourceFiles(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(file) : /\.(?:ts|tsx|mjs)$/.test(file) ? [file] : []
  })
}

const read = (file) => readFileSync(file, 'utf8')

test('the MCP tool catalog reaches the database only through services that authorize', () => {
  // A tool that queried the database directly would bypass the grant recheck every service performs.
  const catalog = read(path.join(connectors, 'tool-catalog.ts'))
  assert.doesNotMatch(catalog, /\b(?:client|pool)\.query\(/, 'tool-catalog.ts must not run SQL directly')
  assert.doesNotMatch(catalog, /inTenantTransaction/, 'tool-catalog.ts must not open its own tenant transaction')
})

test('every tool that names a project declares the action it needs', () => {
  const catalog = read(path.join(connectors, 'tool-catalog.ts'))
  const tools = catalog.match(/defineTool\(\{/g) ?? []
  const actions = catalog.match(/^\s{6}action:/gm) ?? []
  assert.equal(tools.length, actions.length, 'each defineTool must declare an action (null only for discovery)')
  assert.ok(tools.length >= 15, `the connector should expose the full surface, found ${tools.length} tools`)
})

test('an outbound callback can never reach this network by default', () => {
  const outbound = read(path.join(connectors, 'outbound.ts'))
  for (const range of ['127.0.0.0', '169.254.0.0', '10.0.0.0', '192.168.0.0', 'fc00::', 'fe80::', '::1'])
    assert.ok(outbound.includes(range), `the blocked ranges must include ${range}`)
  // Redirects are reported as failures; chasing one would defeat the address that was validated.
  assert.doesNotMatch(outbound, /redirect:\s*['"]follow['"]/)
  assert.match(outbound, /lookup:/, 'the request must connect to the address that was validated')
})

test('a stored connector secret is never returned by the API', () => {
  const protocol = read(path.join(root, 'packages/protocol/src/connectors.ts'))
  const endpoint = protocol.slice(protocol.indexOf('connectorNotificationEndpointSchema'))
  const fields = endpoint.slice(0, endpoint.indexOf('connectorNotificationEndpointInputSchema'))
  assert.doesNotMatch(fields, /\bsecret:\s*z\./, 'the endpoint view must expose only a fingerprint')
  assert.match(fields, /secretFingerprint/)
  // The row mapper decides what leaves the server: it may read the fingerprint, never the sealed secret.
  const notifications = read(path.join(connectors, 'notifications.ts'))
  const mapper = notifications.slice(notifications.indexOf('function mapEndpoint'))
  assert.doesNotMatch(mapper.slice(0, mapper.indexOf('\n}')), /secret_cipher|secret_nonce|key_id/)
})

test('delegation events reach a connector only through the transactional outbox', () => {
  const repository = read(path.join(delegations, 'repository.ts'))
  assert.match(repository, /enqueueConnectorNotifications\(client, task, event\)/)
  const notifications = read(path.join(connectors, 'notifications.ts'))
  // The fan-out is restricted to endpoints whose connection still holds a read grant on that project.
  assert.match(notifications, /connector_project_grants/)
  assert.match(notifications, /c\.revoked_at is null/)
})

test('the connector modules stay inside the server and never import a product', () => {
  const forbidden = /(?:from\s*|import\s*\()['"](?:electron|@maestrly\/desktop|@maestrly\/runner-core|(?:\.\.\/)+apps\/)/
  for (const file of [...sourceFiles(connectors), ...sourceFiles(delegations)])
    assert.doesNotMatch(read(file), forbidden, path.relative(root, file))
})

test('the installable skill carries instructions and no credential', () => {
  assert.ok(existsSync(plugin), 'plugins/maestrly-development must exist')
  const skill = read(path.join(plugin, 'SKILL.md'))
  assert.match(skill, /^---\nname: maestrly-development\ndescription: /, 'the skill needs a usable frontmatter')
  for (const rule of ['Never invent', 'Never claim work is done', 'idempotency key'])
    assert.ok(skill.includes(rule), `the skill must state the rule about "${rule}"`)
  for (const file of readdirSync(plugin)) {
    const body = read(path.join(plugin, file))
    assert.doesNotMatch(body, /\b(?:sk-[A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9._-]{16,})/, `${file} must carry no credential`)
    assert.doesNotMatch(body, /client_secret/, `${file} must not suggest a client secret`)
  }
})
