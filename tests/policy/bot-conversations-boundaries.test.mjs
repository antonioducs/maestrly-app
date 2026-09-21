import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const root = path.resolve(import.meta.dirname, '../..')
const read = (file) => readFileSync(path.join(root, file), 'utf8')
const contract = read('packages/protocol/src/bot-conversations.ts')
const shared = read('apps/desktop/src/shared/bot.ts')
const endpoint = (name) => read(`apps/desktop/src/main/bot/${name}`)

function runtimeSources() {
  const directory = path.join(root, 'apps/desktop/src/main/bot')
  assert.ok(existsSync(directory), 'apps/desktop/src/main/bot must exist')
  const files = readdirSync(directory).filter((name) => name.endsWith('.ts'))
  assert.ok(files.length > 0, 'the desktop bot runtime must have sources')
  return files.map((name) => readFileSync(path.join(directory, name), 'utf8')).join('\n')
}

/** The server relay is not part of the embedded path; whatever remains of it stays tenant free. */
function botMigrations() {
  const directory = path.join(root, 'apps/server/migrations')
  const files = readdirSync(directory).filter((name) => /bot/.test(name) && name.endsWith('.sql'))
  return files.map((name) => readFileSync(path.join(directory, name), 'utf8')).join('\n')
}

test('the bot endpoint is its own audience, separate from the API and from delegation', () => {
  assert.match(contract, /BOT_MCP_PATH = '\/mcp\/bots'/)
  assert.match(contract, /BOT_PROTECTED_RESOURCE_PATH = '\/\.well-known\/oauth-protected-resource\/mcp\/bots'/)
  // The resource a token is minted for is the bot endpoint itself, never the bare /mcp connector.
  assert.match(contract, /botMcpResource[\s\S]{0,200}BOT_MCP_PATH/)
  const oauth = endpoint('oauth.ts')
  assert.match(oauth, /resource\(\): string \{[\s\S]{0,120}BOT_MCP_PATH/)
  // A token minted for any other resource, including an earlier public URL, is refused here.
  assert.match(oauth, /row\.resource !== this\.resource\(\)/)
})

test('the endpoint this desktop publishes is configured, never taken from a request header', () => {
  const oauth = endpoint('oauth.ts')
  const http = endpoint('http-server.ts')
  // Plaintext is only ever acceptable on loopback; anything published must be HTTPS.
  assert.match(oauth, /must use HTTPS/)
  assert.match(oauth, /isLoopbackHostname/)
  // The issuer and audience come from the configured public URL.
  assert.match(http, /this\.options\.oauth\.configure\(config\.publicUrl\)/)
  assert.match(http, /normalizeBotPublicUrl\(config\.publicUrl\)/)
  // A forwarded name may only ever refuse a request, never decide who this server is.
  assert.match(http, /hostname === this\.publicHostname \|\| isLoopbackHostname\(hostname\)/)
  assert.doesNotMatch(http, /x-forwarded-(?:host|proto)[\s\S]{0,80}(?:issuer|publicOrigin|publicHostname)/)
  // Nothing is served until the person configured the address it answers under.
  assert.match(oauth, /The bot endpoint is not configured yet\./)
})

test('a bot is a public client with PKCE, and only the person at this computer grants it', () => {
  const oauth = endpoint('oauth.ts')
  const http = endpoint('http-server.ts')
  assert.match(oauth, /code_challenge_methods_supported: \['S256'\]/)
  assert.match(oauth, /token_endpoint_auth_methods_supported: \['none'\]/)
  assert.match(oauth, /PKCE with S256 is required\./)
  assert.match(oauth, /code_verifier/)
  // Approval happens in exactly one place, and nothing reachable over the network can reach it.
  const approvals = oauth.match(/SET status='approved'/g) ?? []
  assert.equal(approvals.length, 1, 'a request becomes approved in one place only')
  assert.match(oauth, /decide\(id: string, approved: boolean, connectionId: string\)/)
  assert.doesNotMatch(http, /\.decide\(/)
  assert.match(runtimeSources(), /\.decide\(/)
  // The waiting page holds its own secret, so knowing a request id never yields a code.
  assert.match(oauth, /poll_hash TEXT NOT NULL UNIQUE/)
})

test('no bot credential is stored in the clear, and a mutation needs the write scope', () => {
  const oauth = endpoint('oauth.ts')
  assert.match(oauth, /token_hash TEXT PRIMARY KEY/)
  assert.match(oauth, /code_hash TEXT UNIQUE/)
  assert.match(oauth, /sha256\(accessToken\)/)
  assert.doesNotMatch(oauth, /CREATE TABLE IF NOT EXISTS bot_oauth_tokens \([^;]*?\btoken TEXT/)
  const mcp = endpoint('mcp.ts')
  assert.match(mcp, /tool\.write && !principal\.scopes\.includes\(BOT_WRITE_SCOPE\)/)
})

test('a bot grant names one workspace and only conversation actions', () => {
  const actions = contract.slice(contract.indexOf('botActionSchema'), contract.indexOf('BOT_ACTIONS ='))
  for (const action of ['chats:read', 'chats:write', 'chats:control', 'chats:answer'])
    assert.ok(actions.includes(action), `the bot actions must include ${action}`)
  for (const forbidden of ['tasks:', 'execution:', 'delivery:', 'evidence:', 'inspect:']) {
    assert.ok(!actions.includes(forbidden), `a bot action must never be ${forbidden}*`)
    assert.ok(!shared.includes(forbidden), `the desktop bot surface must never offer ${forbidden}*`)
  }
  const grant = contract.slice(contract.indexOf('botGrantSchema'), contract.indexOf('botConnectionSchema'))
  assert.match(grant, /workspaceId/)
  assert.match(shared, /BotActionName = 'chats:read' \| 'chats:write' \| 'chats:control' \| 'chats:answer'/)
})

test('nothing in the bot path names an organization, project, board, card or runner', () => {
  const tenant =
    /\b(?:organizationId|projectId|boardId|cardId|runnerId|organization_id|project_id|board_id|card_id|runner_id)\b/
  assert.doesNotMatch(contract, tenant)
  assert.doesNotMatch(contract, /from '\.\/(?:organizations|projects|boards|delegations|runners)\.js'/)
  assert.doesNotMatch(shared, tenant)
  assert.doesNotMatch(runtimeSources(), tenant)
})

test('a workspace id is opaque, and no path or credential reaches a bot', () => {
  const workspace = contract
    .slice(contract.indexOf('botWorkspaceSchema'), contract.indexOf('botSelectionOptionSchema'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
  assert.doesNotMatch(workspace, /path|cwd|directory/i)
  // Not one tool a bot can call takes, or answers with, a local location.
  const tools = endpoint('mcp.ts')
  assert.doesNotMatch(tools, /\b(?:cwd|directory|absolute path|filesystem)\b/i)
  assert.doesNotMatch(tools, /credential|api key|client_secret/i)
})

test('permissions, plans and escalations are never relayed to a bot', () => {
  const events = contract.slice(
    contract.indexOf('botEventPayloadSchema'),
    contract.indexOf('botConversationEventSchema')
  )
  const types = [...events.matchAll(/z\.literal\('([a-z-]+)'\)/g)].map((match) => match[1])
  assert.ok(types.includes('question'), 'an ordinary question is relayed')
  for (const forbidden of ['permission', 'plan', 'escalation'])
    assert.ok(!types.includes(forbidden), `a ${forbidden} must never be a relayed event type`)
  const runtime = runtimeSources()
  assert.match(runtime, /type: 'plan',\s*ownerOnly: true/)
  assert.match(runtime, /type: 'permission',\s*ownerOnly: true/)
  // Only an ordinary question becomes a relayed event.
  assert.match(runtime, /interaction\.type === 'question'/)
  assert.doesNotMatch(runtime, /payload\s*=\s*\{\s*type:\s*'(?:permission|plan)'/)
  // The tool that answers is described as answering an ordinary question and nothing else.
  assert.match(endpoint('mcp.ts'), /Permission prompts and plan[\s\S]{0,80}never be answered here/)
})

test('a bot can never raise its own permission mode or borrow an effort it was not offered', () => {
  const runtime = runtimeSources()
  // How far a bot may go is the ceiling the person chose; a request above it is refused, never capped.
  assert.match(runtime, /botPermissionRank\(selection\.permissionMode\) > botPermissionRank\(this\.permissionCeiling\)/)
  assert.match(runtime, /requires owner approval for protected operations/)
  // Only the modes at or under that ceiling are ever published, so a bot is never offered more.
  assert.match(runtime, /permissionModes: this\.permissionModes\(\)/)
  assert.match(runtime, /botPermissionRank\(mode\) <= botPermissionRank\(this\.permissionCeiling\)/)
  // The turn runs with what the catalog resolved, never with what the bot asked for.
  assert.match(runtime, /permMode: model\.permissionMode/)
  assert.doesNotMatch(runtime, /permMode: (?:selection|input\.selection)\.permissionMode/)
  assert.match(runtime, /reasoningEfforts\.includes\(selection\.reasoning\)/)
})

test('only the person at this computer moves how far a bot may go', () => {
  const runtime = runtimeSources()
  // A saved record that predates the choice, or holds an unreadable one, asks about everything.
  assert.match(shared, /DEFAULT_BOT_PERMISSION_CEILING: BotPermissionCeiling = 'ask'/)
  assert.match(runtime, /ADD COLUMN permission_ceiling TEXT NOT NULL DEFAULT 'ask'/)
  assert.match(runtime, /permission_ceiling TEXT NOT NULL DEFAULT 'ask'/)
  assert.match(runtime, /catch\(DEFAULT_BOT_PERMISSION_CEILING\)/)
  // Moving it is an owner action on the desktop: it is a new version, and no bot tool reaches it.
  assert.match(runtime, /setPermissionCeiling\(connectionId: string, ceiling: BotPermissionCeiling\)/)
  assert.match(runtime, /SET permission_ceiling=\?,version=version\+1/)
  assert.doesNotMatch(endpoint('mcp.ts'), /permissionCeiling|setPermissionCeiling/)
})

test('an instruction already admitted is reported, never run a second time', () => {
  const runtime = runtimeSources()
  assert.match(runtime, /not replayed/)
  assert.match(runtime, /admit\(/)
  // The receipt outlives the conversation, so deleting one cannot resurrect a prompt.
  assert.match(runtime, /bot_command_receipts/)
})

test('obvious secrets are redacted before anything leaves the computer', () => {
  const runtime = runtimeSources()
  assert.match(runtime, /sk-/)
  assert.match(runtime, /Bearer/)
  assert.match(runtime, /\[redacted\]/)
})

test('any server bot table that still exists forces row level security and names no tenant', () => {
  const sql = botMigrations()
  if (!sql) return // The embedded endpoint owns no server table at all.
  assert.doesNotMatch(sql, /\b(?:organization_id|project_id|board_id|card_id|runner_id)\b/)
  assert.doesNotMatch(sql, /references\s+(?:organizations|projects|boards|cards|runners)\b/i)
  const tables = [...sql.matchAll(/create table (bot_[a-z_]+)/g)].map((match) => match[1])
  for (const table of tables) {
    const direct = sql.includes(`alter table ${table} enable row level security`)
    const looped = new RegExp(`'${table}'`).test(sql) && /format\('alter table %I force row level security'/.test(sql)
    assert.ok(direct || looped, `${table} must enable row level security`)
    assert.ok(sql.includes(`alter table ${table} force row level security`) || looped, `${table} must force it`)
  }
})

test('the end-to-end harness needs no server, no database and no real instance', () => {
  const harness = read('scripts/test-bot-conversations-e2e.mjs')
  assert.doesNotMatch(harness, /docker/i)
  assert.doesNotMatch(harness, /postgres/i)
  assert.doesNotMatch(harness, /sign-up|sign-in/i)
  // Whatever another worktree exported must not become this run's target.
  assert.match(harness, /delete env\[name\]/)
  for (const cleared of ['MAESTRLY_SERVER_URL', 'DATABASE_URL'])
    assert.ok(harness.includes(`'${cleared}'`), `the harness must clear ${cleared}`)
  assert.match(harness, /build:desktop/)
  assert.match(harness, /bot-relay-e2e\.spec\.ts/)
})

test('the end-to-end suite reaches loopback under the published name, and proves consent', () => {
  const spec = read('apps/desktop/test/e2e/bot-relay-e2e.spec.ts')
  assert.match(spec, /test\.skip\(!process\.env\.MAESTRLY_BOT_CONVERSATIONS_E2E/)
  assert.doesNotMatch(spec, /https:\/\/(?!maestrly\.example)/)
  assert.match(spec, /127\.0\.0\.1/)
  assert.match(spec, /host: options\.host \?\? publicHost/)
  // The person's approval, the denial, and the host that is not served are all exercised.
  assert.match(spec, /botAuthorize/)
  assert.match(spec, /access_denied/)
  assert.match(spec, /attacker\.example/)
  const workflow = read('.github/workflows/ci-platform.yml')
  assert.match(workflow, /test-bot-conversations-e2e\.mjs/)
})

test('the installable skill teaches the bot flow it actually has', () => {
  const skill = read('plugins/maestrly-development/SKILL.md')
  assert.match(skill, /^---\nname: maestrly-development\ndescription: /)
  for (const tool of ['bot_list_workspaces', 'bot_create_chat', 'bot_send_message', 'bot_read_chat', 'bot_wait_events'])
    assert.ok(skill.includes(tool), `the skill must describe ${tool}`)
  for (const rule of ['Never invent', 'Never claim work is done', 'idempotency key'])
    assert.ok(skill.includes(rule), `the skill must keep the rule about "${rule}"`)
  // The two paths stay distinct, the bot one never pretends it can approve a gate, and it is honest
  // about the endpoint being the person's own computer.
  assert.match(skill, /maestrly_\*/)
  assert.match(skill, /permission request, a plan or an escalation/)
  assert.match(skill, /Never treat a connection error as a delay/)
  const configuration = JSON.parse(read('plugins/maestrly-development/mcp.json'))
  const urls = Object.values(configuration.mcpServers).map((entry) => entry.url)
  assert.ok(
    urls.some((url) => url.endsWith('/mcp/bots')),
    'the example must offer the bot endpoint'
  )
  assert.ok(
    urls.some((url) => url.endsWith('/mcp')),
    'the example must keep the delegation endpoint'
  )
})

test('the documentation states what a remote bot needs to reach the desktop', () => {
  const guide = read('docs/grok-connector.md')
  assert.match(guide, /\/mcp\/bots/)
  assert.match(guide, /reachable over \*\*HTTPS from wherever the bot runs\*\*/)
  assert.match(guide, /localhost/)
  // The embedded path is described as what it is: no server, no database, and a Host that must match.
  assert.match(guide, /no server, no\s+database and no relay/)
  assert.match(guide, /`Host` header/)
  // Verification claims stay honest about what a local run can and cannot prove.
  assert.match(guide, /npm run test:e2e:bot-conversations/)
  assert.match(guide, /Homologation against a live Grok Bot installation/)
})
