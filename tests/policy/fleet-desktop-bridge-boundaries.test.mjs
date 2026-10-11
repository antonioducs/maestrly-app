import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const root = path.resolve(import.meta.dirname, '../..')
const read = (file) => readFileSync(path.join(root, file), 'utf8')
const code = (file) =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

const gateway = code('apps/bot-gateway/src/desktop-bridge.ts')
const events = code('apps/bot-gateway/src/events.ts')
const routes = code('apps/bot-gateway/src/routes/public.ts')
const domain = code('packages/bot-fleet-protocol/src/domain.ts')
const bridge = code('apps/desktop/src/main/fleet/client/desktop-bridge.ts')
const tools = code('apps/desktop/src/main/mcp/tools/bot-desktops.ts')
const policy = code('apps/desktop/src/main/chat/tool-policy.ts')
const conversationTools = code('apps/desktop/src/main/bot/local-service.ts')

test('a desktop call reaches only the computer its link names, and only that computer answers it', () => {
  // The target comes from the stored link of the calling bot, never from anything else in the request.
  assert.match(gateway, /const link = this\.store\.desktopLinkById\(request\.desktopId\)/)
  assert.match(gateway, /!link \|\| link\.botId !== botId/)
  assert.match(gateway, /this\.events\.sendToDevice\(link\.deviceId,/)
  // An answer from any other device is refused.
  assert.match(gateway, /call\.deviceId !== deviceId\) throw new GatewayError\('FORBIDDEN'/)
  // The answering device is the one its own token names.
  assert.match(
    routes,
    /case 'desktopCallResult':[\s\S]{0,200}ctx\.auth\.device\(res\.req\?\.headers\.authorization\)\.id/
  )
  // A call is written to one device's stream, never broadcast to every subscriber.
  assert.doesNotMatch(gateway, /events\.emit\(\{\s*type: 'desktop\.call'/)
  assert.match(events, /sendToDevice\(deviceId: string, event: FleetGatewayEvent\): boolean/)
  // A computer that did not ask for calls is never online, and is never sent one.
  assert.match(routes, /desktopBridge: url\.searchParams\.get\(FLEET_DESKTOP_BRIDGE_QUERY\) === '1'/)
})

test('an offline computer fails the call at once: nothing is queued and no other computer stands in', () => {
  assert.match(gateway, /if \(!this\.events\.bridgeOnline\(link\.deviceId\)\) return Promise\.resolve\(offline\)/)
  // A call looks up the one link it names: it never searches the bot's other links, and never waits in a queue.
  const call = gateway.slice(gateway.indexOf('call(botId: string'), gateway.indexOf('result(callId: string'))
  assert.ok(call.length > 100, 'the gateway routes calls')
  assert.doesNotMatch(call, /desktopLinks\(|desktopLinksOfDevice\(|\bqueue\b|fallback/i)
  // The gateway keeps which computer linked which bot, never what that computer granted or holds.
  const table = read('apps/bot-gateway/src/store.ts').match(/CREATE TABLE desktop_links \(([^;]*)\);/)?.[1] ?? ''
  assert.ok(table, 'the gateway stores desktop links')
  assert.doesNotMatch(table, /workspace|grant|selection|conversation|transcript|path/i)
})

test('a bot can never approve a permission or a plan through a computer', () => {
  const ops = domain.slice(
    domain.indexOf('FLEET_DESKTOP_OPS = ['),
    domain.indexOf('] as const', domain.indexOf('FLEET_DESKTOP_OPS = ['))
  )
  assert.doesNotMatch(ops, /permission|plan|approve|escalat/i)
  // Each op runs a conversation tool of the local bot service, and those never answer an approval.
  const mapped = [...bridge.matchAll(/:\s*'(bot_[a-z_]+)'/g)].map((match) => match[1])
  assert.ok(mapped.length >= 11, 'every desktop op names a conversation tool')
  for (const tool of mapped)
    assert.ok(conversationTools.includes(`case '${tool}':`), `${tool} is a conversation tool of the local bot service`)
  assert.doesNotMatch(bridge, /replyPermission|resolvePermission|review_plan|decidePlan|\.decide\(/)
  assert.doesNotMatch(tools, /permission request|approve the plan/i)
  // Changes pass the bot's own approval ceiling first.
  for (const name of [
    'desktop_create_chat',
    'desktop_send_message',
    'desktop_configure_chat',
    'desktop_cancel_turn',
    'desktop_answer_question',
  ])
    assert.match(policy, new RegExp(`${name}: policy\\(false, false, false\\)`), `${name} is a change`)
})

test('nothing a bot reads names a local path or this computer’s own id', () => {
  // What crosses is the output of the conversation tools, whose catalog carries no path, with this computer's own id
  // replaced by the opaque id the bot knows it by.
  assert.match(bridge, /if \(item === local\) return self\.desktopId/)
  assert.doesNotMatch(bridge, /\b(?:cwd|worktreePath|workspace\.path|getWorkspace)\b/)
  assert.doesNotMatch(tools, /\b(?:cwd|absolute path|filesystem)\b/i)
  // An unexpected failure is reported without its message, which could carry a path.
  assert.match(bridge, /'This computer could not run the call\. Tell your owner\.'/)
  // A desktop id is opaque: never the device id the computer paired with.
  assert.match(gateway, /'dsk_' \+ randomBytes\(16\)\.toString\('base64url'\)/)
  assert.match(domain, /fleetDesktopIdSchema = z\.string\(\)\.regex\(\/\^dsk_/)
})

test('only a fleet bot’s connection is served here, and its access needs both sides', () => {
  const host = code('apps/desktop/src/main/bot/host.ts')
  assert.match(host, /export const FLEET_BOT_CLIENT_PREFIX = 'fleet:'/)
  // A tool call or a revocation names a connection of a fleet bot; anything else left on this computer is retired.
  assert.match(host, /if \(!isFleetConnection\(connection\)\) throw new Error/)
  assert.match(host, /if \(!isFleetConnection\(connection\)\) await this\.retire\(connection\)/)
  // A link the server could not record leaves no access behind, and a missing link revokes the access here.
  assert.match(bridge, /if \(created\) await this\.host\.revokeFleetConnection\(connection\.id\)/)
  assert.match(bridge, /else if \(!self && connection\) \{[\s\S]{0,200}revokeFleetConnection/)
})
