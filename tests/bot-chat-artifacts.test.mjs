import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFile(path.join(root, relative), 'utf8')
async function walk(directory) {
  const out = []
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`
    if (entry.isDirectory()) out.push(...(await walk(relative)))
    else out.push(relative)
  }
  return out
}

test('the shared chat package depends on neither application', async () => {
  const files = (await walk('packages/chat-ui/src')).filter((file) => /\.(ts|tsx)$/.test(file))
  for (const file of files) {
    const source = await read(file)
    // Copy, navigation and bytes arrive through the provider; nothing reaches the window or a catalogue.
    assert.doesNotMatch(source, /window\.(api|bot)\b/, file)
    assert.doesNotMatch(source, /react-i18next|from '@\/|\.\.\/\.\.\/shared/, file)
  }
  // Both applications render the same table and the same transcript; neither keeps a private copy.
  for (const app of ['apps/desktop/src/renderer/components/UsagePanel.tsx', 'apps/bot-desktop/src/renderer/features/usage/UsagePage.tsx'])
    assert.match(await read(app), /from '@maestrly\/chat-ui'/)
  assert.doesNotMatch(await read('apps/desktop/src/renderer/components/UsagePanel.tsx'), /<table/)
})

test('a transcript is one projection, folded from durable rows on the Host and applied live in the app', async () => {
  const transcript = await read('packages/host-protocol/src/transcript.ts')
  assert.match(transcript, /export function foldTranscript/)
  assert.match(transcript, /export function applyTranscriptEvent/)
  // The Bot never invents a second fold: it reads the page and applies events with the shared function.
  const hook = await read('apps/bot-desktop/src/renderer/features/chat/useTranscript.ts')
  assert.match(hook, /applyTranscriptEvent/)
  assert.doesNotMatch(hook, /parts\.push\(\{\s*type: 'tool'/)
  const service = await read('packages/host-core/src/bots/service.ts')
  assert.match(service, /bot\.transcript\.list/)
})

test('a secret goes in once and never comes back through any reply', async () => {
  const contracts = await read('packages/host-protocol/src/extensions.ts')
  // The state an application reads carries names of variables, never values.
  assert.match(contracts, /envKeys: z\.array\(envKeySchema\)/)
  assert.match(contracts, /Names only: the values are secrets and never come back/)
  const service = await read('packages/host-core/src/chat/extensions-service.ts')
  // Values live in private files, written with the private-file helper, never in SQLite.
  assert.match(service, /writePrivate\(this\.secretPath/)
  assert.doesNotMatch(service, /INSERT INTO bot_extensions[^;]*env/)
  const repository = await read('packages/host-core/src/chat/extensions-repository.ts')
  assert.doesNotMatch(repository, /env:/)
  // The guest keeps the values in memory only; the skills are the only thing it writes.
  const store = await read('apps/bot-runtime/src/extensions/store.ts')
  assert.doesNotMatch(store, /writeFile\([^)]*servers|JSON\.stringify\(.*env/)
  assert.match(store, /stays in memory only/)
  // The desktop form sends values write-only and shows a placeholder for what is stored.
  const form = await read('apps/bot-desktop/src/renderer/features/extensions/McpSettings.tsx')
  assert.match(form, /type="password"/)
  assert.match(form, /envStored/)
})

test('extensions reach a guest only through the private channel, with a capability, before a turn', async () => {
  const guest = await read('packages/host-protocol/src/guest-runtime.ts')
  assert.match(guest, /hostRequest\('extensions\.apply', extensionsApplySchema\)/)
  // The turn snapshot stays strict and carries no extension: an older guest sees the exact old shape.
  assert.doesNotMatch(guest, /extensions: extensionsApplySchema/)
  const delivery = await read('packages/host-core/src/chat/extensions-delivery.ts')
  assert.match(delivery, /EXTENSIONS_CAPABILITY/)
  assert.match(delivery, /EXTENSIONS_UPDATE_REQUIRED/)
  const coordinator = await read('packages/host-core/src/bots/runtime-coordinator.ts')
  // Preparation happens before the authorization is revalidated and before the wire write.
  const prepare = coordinator.indexOf('this.extensions?.prepare(')
  const guard = coordinator.indexOf('this.dispatchGuard?.(turn.id)')
  assert.ok(prepare > 0 && guard > prepare, 'extensions are prepared before the dispatch guard')
  const supervisor = await read('apps/bot-runtime/src/runtime-supervisor.ts')
  assert.match(supervisor, /EXTENSIONS_CAPABILITY/)
  // Never mid-turn: Codex would only pick the change up at an unknown moment.
  assert.match(supervisor, /if \(this\.turns\.busy\) throw runtimeError\('TURN_BUSY'/)
  // The bot's own tool server keeps its name and the elicitation of a foreign server is declined.
  const store = await read('apps/bot-runtime/src/extensions/store.ts')
  assert.match(store, /server\.name === MCP_SERVER_NAME\) throw/)
  const events = await read('apps/bot-runtime/src/providers/codex/events.ts')
  assert.match(events, /context\.configuredServers\.includes\(server\)/)
  assert.match(events, /permissionMode === 'full-vm'\) return \{ action: 'accept' \}/)
})

test('the Host counts usage and never prices it', async () => {
  const rpc = await read('packages/host-protocol/src/usage-rpc.ts')
  // No field of the contract carries money; the comment saying so is the only place the word appears.
  assert.doesNotMatch(rpc.replace(/\/\*\*[\s\S]*?\*\//g, ''), /cost|price|usd/i)
  assert.match(rpc, /USAGE_MAX_WINDOW_DAYS = 90/)
  assert.match(rpc, /USAGE_RANGE_INVALID/)
  const service = await read('packages/host-core/src/chat/usage-service.ts')
  assert.doesNotMatch(service, /Per1M|costOf|fetch\(/)
  // The ledger row is written in the same transaction as the finished turn: never counted twice.
  const coordinator = await read('packages/host-core/src/bots/runtime-coordinator.ts')
  assert.match(coordinator, /this\.repo\.saveTurnUsage\(/)
  // Prices come from the public catalogue, cached by the application with a TTL, never from the Host.
  const meta = await read('apps/bot-desktop/src/main/model-meta.ts')
  assert.match(meta, /models\.dev/)
  assert.match(meta, /0o600/)
})

test('the application never renders a native select and keeps its fixtures out of packaged builds', async () => {
  const files = (await walk('apps/bot-desktop/src/renderer')).filter((file) => file.endsWith('.tsx'))
  for (const file of files) assert.doesNotMatch(await read(file), /<select[\s>]/, file)
  for (const fixture of ['fixture-prompts', 'fixture-extensions', 'fixture-usage'])
    assert.match(await read(`apps/bot-desktop/src/main/${fixture}.ts`), /fixture|Fixture/)
  const index = await read('apps/bot-desktop/src/main/index.ts')
  assert.match(index, /!app\.isPackaged && process\.env\.MAESTRLY_BOT_FIXTURE === '1'/)
  // A skill folder is read in the main process from a dialog; the fixture path exists only under the fixture.
  assert.match(index, /const preset = fixture \? process\.env\.MAESTRLY_BOT_FIXTURE_PICK_FOLDER : undefined/)
})

test('both main processes bundle the shared chat package instead of leaving it external', async () => {
  // The package ships TypeScript sources only. Left external, the packaged Bot Lab 0.4.0 failed to
  // load `@maestrly/chat-ui/model-meta` from its asar and never opened a window; the e2e runs that
  // launch `out/main/index.js` from the workspace did not catch it.
  for (const config of ['apps/bot-desktop/electron.vite.config.ts', 'apps/desktop/electron.vite.config.ts'])
    assert.match(await read(config), /externalizeDepsPlugin\(\{\s*exclude:\s*\[\s*'@maestrly\/chat-ui'\s*\]\s*\}\)/, config)
})

test('capabilities and versions are the ones the rollout kit expects', async () => {
  const chat = await read('packages/host-protocol/src/chat.ts')
  assert.match(chat, /CHAT_HOST_CAPABILITY = 'chat\.experience\.v1'/)
  assert.match(chat, /TRANSCRIPT_CAPABILITY = 'bot\.transcript\.v1'/)
  assert.match(chat, /EXTENSIONS_CAPABILITY = 'bot\.extensions\.v1'/)
  const declared = JSON.parse(await read('apps/host/package.json')).version
  const reported = /serviceVersion: '([^']+)'/.exec(await read('packages/host-core/src/service.ts'))?.[1]
  assert.equal(reported, declared)
  assert.equal(declared, '0.4.0')
  assert.equal(JSON.parse(await read('apps/bot-desktop/package.json')).version, '0.4.0')
  assert.match(await read('packages/host-core/src/persistence/store.ts'), /migrateToV8/)
  assert.match(await read('packages/host-core/src/bots/migrations.ts'), /HOST_DB_VERSION = 8/)
})

test('the laboratory asks before it installs anything, removes what it installed and prints no answer', async () => {
  const lab = await read('scripts/bot-chat-lab.mjs')
  assert.match(lab, /EXTENSIONS_LAB_NOT_AUTHORIZED/)
  assert.match(lab, /CHAT_METHOD_NOT_ALLOWED/)
  assert.match(lab, /EXTENSIONS_TARGET_REQUIRED/)
  assert.match(lab, /EXTENSIONS_LAB_LEFTOVER/)
  // The answer is reported by length; the echo server needs no network and no files.
  assert.match(lab, /answerLength/)
  assert.doesNotMatch(lab, /require\('(net|http|https|fs|child_process)'\)/)
  assert.match(lab, /extension\.skill\.remove/)
  assert.match(lab, /extension\.mcp\.remove/)
  const config = await read('scripts/host-lab.mjs')
  assert.match(config, /allowExtensionsSmoke/)
})

test('the chat experience is wired into the repository checks and the CI', async () => {
  const manifest = JSON.parse(await read('package.json'))
  for (const script of ['check:bot-chat', 'test:bot-chat', 'test:e2e:bot-chat', 'typecheck:chat-ui', 'test:chat-ui', 'lab:bot:chat']) assert.ok(manifest.scripts[script], `missing script ${script}`)
  // The laboratory is never part of an automated run.
  assert.doesNotMatch(manifest.scripts.test, /lab:bot:chat/)
  assert.match(manifest.scripts.check, /check:bot-chat/)
  assert.match(manifest.scripts.test, /test:bot-chat/)
  // The desktop suites run in the same check: a shared package must not break either application.
  assert.match(manifest.scripts['check:bot-chat'], /typecheck --workspace @maestrly\/desktop/)
  assert.doesNotMatch(manifest.scripts['test:bot-chat'], /lab:|ssh/)
  const bot = JSON.parse(await read('apps/bot-desktop/package.json'))
  assert.match(bot.scripts['test:e2e:chat'], /bot-chat-extensions\.spec\.ts/)
  assert.match(bot.scripts['test:e2e:chat'], /bot-chat-usage\.spec\.ts/)
  const workflow = await read('.github/workflows/ci-platform.yml')
  assert.match(workflow, /npm run check:bot-chat && npm run test:bot-chat/)
  assert.match(workflow, /xvfb-run -a npm run test:e2e:bot-chat/)
})
