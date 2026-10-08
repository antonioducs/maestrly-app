import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, _electron as electron, chromium, type ElectronApplication, type Page } from '@playwright/test'
import { createSettingsGateway } from './helpers/environment-settings-gateway'
import { removeTempDirEventually } from './helpers/temp-cleanup'

const desktop = fileURLToPath(new URL('../..', import.meta.url))
// Keep comparison artifacts outside Playwright's per-run output cleanup.
const captures = path.join(desktop, '../../test-results/environment-settings')
const sections = {
  accounts: 'Contas',
  models: 'Modelos',
  skills: 'Skills',
  tools: 'Ferramentas',
  components: 'Componentes',
  preferences: 'Preferências',
}
type Gateway = Awaited<ReturnType<typeof createSettingsGateway>>
let gateway: Gateway
let app: ElectronApplication
let page: Page
let root: string
const panel = () =>
  page
    .getByRole('tabpanel')
    .last()
    .or(page.getByRole('dialog', { name: /^(Editar conta|Servidor MCP)$/ }))
    .last()
const apiCard = () =>
  page
    .getByRole('tabpanel')
    .last()
    .locator('div.rounded-lg')
    .filter({ hasText: /Estúdio Google AI|Estúdio principal|Second keyboard save|Saved on close/ })
    .first()
/** The environment settings panel, open over its environment's view. */
const sheet = () => page.getByRole('dialog', { name: /^Configurações de / })
/** A tab of the settings panel, by its label; its name goes on to say when it has unsaved changes. */
const tab = (name: keyof typeof sections) =>
  sheet()
    .getByRole('tablist', { name: 'Seções das configurações do ambiente', exact: true })
    .getByRole('tab', { name: new RegExp(`^${sections[name]}\\b`) })
const section = async (name: keyof typeof sections) => {
  await tab(name).click()
}
/** The one bar that saves every section of the panel with unsaved changes. */
const saveBar = () => sheet().getByRole('region', { name: 'Alterações não salvas', exact: true })
async function openEnvironment(name = gateway.environments.find((environment) => environment.id === 'studio')!.name) {
  // Another environment is reached from the sidebar, past the panel of the current one.
  if (await sheet().isVisible()) {
    await sheet().getByRole('button', { name: 'Fechar configurações', exact: true }).click()
    await expect(sheet()).toBeHidden()
  }
  await page
    .getByRole('group', { name, exact: true })
    .getByRole('button', { name: new RegExp(`^Ambiente ${name} ·`) })
    .click()
  await page.getByRole('button', { name: 'Configurações do ambiente', exact: true }).click()
  await expect(sheet().getByRole('tablist', { name: 'Seções das configurações do ambiente' })).toBeVisible()
}
async function launch(pair = true) {
  app = await electron.launch({
    args: [path.join(desktop, 'out/main/index.js')],
    env: {
      ...process.env,
      AGENTS_E2E: '1',
      AGENTS_E2E_SKILLS_HOME: root,
      AGENTS_CHANNEL: 'dev',
      AGENTS_INSTANCE: 'settings-e2e',
      AGENTS_USERDATA: path.join(root, 'profile'),
      AGENTS_LOCALE: 'pt-BR',
      ELECTRON_RENDERER_URL: '',
    },
  })
  await app.evaluate(({ shell }) => {
    const state = globalThis as typeof globalThis & { __settingsOpened: string[] }
    state.__settingsOpened = []
    shell.openExternal = async (url) => {
      state.__settingsOpened.push(url)
    }
  })
  gateway.setVersion(await app.evaluate(({ app }) => app.getVersion()))
  page = await app.firstWindow()
  await page.waitForFunction(() => Boolean((window as any).api))
  await page.emulateMedia({ colorScheme: 'dark', forcedColors: 'none', reducedMotion: 'reduce' })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1000, 800))
  if (pair) {
    await page.getByRole('button', { name: 'Configurações', exact: true }).click()
    await page.getByRole('button', { name: 'Servidor de bots' }).first().click()
    await page.getByRole('button', { name: 'Já tenho um servidor configurado', exact: true }).click()
    await page.getByLabel('Endereço do servidor').fill(gateway.url)
    await page.getByLabel('Código de pareamento').fill('ABCD-EFGH')
    await page.getByRole('button', { name: 'Conectar', exact: true }).click()
    await expect(page.getByRole('main').getByRole('status').filter({ hasText: 'Conectado' })).toContainText(
      'fleet-env-host'
    )
    await page.getByRole('button', { name: 'Fechar', exact: true }).first().click()
  }
  if (!pair) {
    // Without an OS keyring (Linux CI) the pairing token lives in memory only, so a relaunch must pair again.
    const connection = await page.evaluate(() => window.api.fleetGetConnection())
    if (connection.tokenPersistence === 'memory')
      await page.evaluate((url) => window.api.fleetConnect({ url, code: 'ABCD-EFGH' }), gateway.url)
  }
  await page.getByRole('tab', { name: /^Bots/ }).click()
  await openEnvironment()
}
test.beforeEach(async () => {
  test.setTimeout(180_000)
  root = await mkdtemp(path.join(os.tmpdir(), 'maestrly-settings-e2e-'))
  gateway = await createSettingsGateway()
  if (process.env.MAESTRLY_SETTINGS_CAPTURE === '1' && test.info().title.startsWith('six remote'))
    gateway.alignCapture()
  await launch()
})
test.afterEach(async () => {
  await app?.close()
  await gateway?.close()
  await removeTempDirEventually(root)
  expect(gateway.errors, 'Gateway fixture schema validation').toEqual([])
})

test('six remote sections expose shared scope and capture the real Electron renderer', async () => {
  await mkdir(captures, { recursive: true })
  for (const key of Object.keys(sections)) {
    await section(key as keyof typeof sections)
    await expect(tab(key as keyof typeof sections)).toHaveAttribute('aria-selected', 'true')
    const content = {
      accounts: 'Estúdio Google AI',
      models: 'Gemini Pro',
      skills: '/studio-review',
      tools: 'Estúdio Docs',
      components: 'Antigravity ACP',
      preferences: 'Geração de imagens',
    }
    await expect(
      panel()
        .getByText(content[key as keyof typeof content], { exact: false })
        .first()
    ).toBeVisible()
    await expect(
      sheet().getByText('As configurações deste computador continuam separadas.', { exact: false })
    ).toBeVisible()
    await page.screenshot({ animations: 'disabled', scale: 'css', path: path.join(captures, `real-${key}.png`) })
  }
  await section('accounts')
  await expect(panel().getByRole('button', { name: 'Entrar com Google AI', exact: true })).toBeVisible()
  await apiCard().getByRole('button', { name: 'Editar', exact: true }).click()
  await expect(panel().getByLabel('Nova chave de API')).toHaveValue('')
  await page.screenshot({ animations: 'disabled', scale: 'css', path: path.join(captures, 'real-edit.png') })
  await panel().getByLabel('Nome', { exact: true }).fill('Estúdio principal')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Salvar antes de sair?' })).toBeVisible()
  await page.screenshot({ animations: 'disabled', scale: 'css', path: path.join(captures, 'real-edit-modal.png') })
  await page.getByRole('button', { name: 'Continuar editando' }).click()
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setMinimumSize(600, 600)
    window.setContentSize(700, 800)
  })
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(700)
  await page.screenshot({ animations: 'disabled', scale: 'css', path: path.join(captures, 'real-narrow.png') })
  await panel().getByRole('button', { name: 'Descartar', exact: true }).click()
  if (process.env.MAESTRLY_SETTINGS_CAPTURE === '1') {
    const browser = await chromium.launch()
    try {
      const proposal = await browser.newPage({ viewport: { width: 1000, height: 800 }, locale: 'pt-BR' })
      for (const key of Object.keys(sections)) {
        await proposal.goto(`${process.env.MAESTRLY_SETTINGS_PROTOTYPE_URL ?? 'http://127.0.0.1:4317'}/`)
        await proposal.locator(`#section-${key === 'tools' ? 'mcp' : key === 'preferences' ? 'advanced' : key}`).click()
        await proposal.waitForLoadState('networkidle')
        await proposal.screenshot({ animations: 'disabled', path: path.join(captures, `proposal-${key}.png`) })
      }
      await proposal.locator('#section-accounts').click()
      await proposal.getByRole('button', { name: 'Editar', exact: true }).last().click()
      await expect(proposal.getByRole('dialog')).toBeVisible()
      await proposal.screenshot({ animations: 'disabled', path: path.join(captures, 'proposal-edit.png') })
      await proposal.setViewportSize({ width: 700, height: 800 })
      await proposal.screenshot({ animations: 'disabled', path: path.join(captures, 'proposal-narrow.png') })
      for (const key of [...Object.keys(sections), 'edit', 'edit-modal', 'narrow']) {
        const raw = await readFile(path.join(captures, `real-${key}.png`))
        const composite = await proposal.evaluate(
          async (data) => {
            const image = new Image()
            image.src = data
            await image.decode()
            const canvas = document.createElement('canvas')
            canvas.width = image.naturalWidth
            canvas.height = image.naturalHeight
            const context = canvas.getContext('2d')!
            context.fillStyle = '#141416'
            context.fillRect(0, 0, canvas.width, canvas.height)
            context.drawImage(image, 0, 0)
            return canvas.toDataURL('image/png').split(',')[1]
          },
          `data:image/png;base64,${raw.toString('base64')}`
        )
        await writeFile(path.join(captures, `real-${key}-composite.png`), Buffer.from(composite, 'base64'))
      }
      await writeFile(
        path.join(captures, 'comparison.html'),
        `<!doctype html><meta charset="utf-8"><title>Environment settings comparison</title><style>body{background:#18181b;color:white;font:16px system-ui}section{display:flex;gap:12px}figure{margin:0;width:50%}img{width:100%}</style><h1>Real Electron renderer and approved proposal</h1><p>Real renderer captures use a synthetic gateway. Environment names, bot counts and core accounts/models match the proposal; Google AI and Gemini are additional supported providers. Skill and MCP fixture contents and runtime versions differ. Raw Electron PNGs are preserved alongside display copies composited on the actual theme background (#141416). The approved prototype is unchanged.</p>${Object.entries(
          {
            ...sections,
            edit: 'Account editor dialog',
            narrow: 'Account editor at 700 × 800',
          }
        )
          .map(
            ([key, label]) =>
              `<h2>${label}</h2><section><figure><figcaption>Real Electron renderer (alpha composited on #141416)</figcaption><img src="real-${key}-composite.png"></figure><figure><figcaption>Approved proposal</figcaption><img src="proposal-${key}.png"></figure></section>`
          )
          .join('')}`
      )
    } finally {
      await browser.close()
    }
  }
})

test('the overview sums up what the bots share and opens where each part changes', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900))
  await sheet().getByRole('button', { name: 'Fechar configurações', exact: true }).click()
  await expect(sheet()).toHaveCount(0)
  const overview = page.getByRole('region', { name: 'Visão geral de Estúdio Dev', exact: true })
  // Its bots occupy the bays of the environment; the next bay creates a bot in it.
  await expect(overview.getByText('2 de 8 bots', { exact: true })).toBeVisible()
  await expect(overview.getByRole('button', { name: /^Scout/ })).toBeVisible()
  await expect(overview.getByRole('button', { name: /^Atlas/ })).toBeVisible()
  await expect(overview.getByRole('button', { name: 'Novo bot neste ambiente', exact: true })).toBeEnabled()
  // What every bot shares, read from the environment.
  const tile = (label: string) => overview.getByRole('button', { name: new RegExp(`^${label}`) })
  await expect(tile('Contas')).toContainText('2 contas')
  await expect(tile('Contas')).toContainText('Google AI · Estúdio Google AI')
  await expect(tile('Modelos')).toContainText('2 visíveis')
  await expect(tile('Modelos')).toContainText('Nenhum oculto')
  await expect(tile('Skills')).toContainText('1 skill')
  await expect(tile('Ferramentas')).toContainText('1 servidor MCP')
  await expect(tile('Ferramentas')).toContainText('Todos ligados')
  await test.info().attach('environment-overview.png', {
    body: await page.screenshot({ path: test.info().outputPath('environment-overview.png') }),
    contentType: 'image/png',
  })
  // Each opens its tab of the settings panel; what changed there shows once the panel closes.
  await tile('Modelos').click()
  await expect(tab('models')).toHaveAttribute('aria-selected', 'true')
  await panel()
    .getByRole('checkbox', { name: /^Gemini Flash/ })
    .uncheck()
  await expect(saveBar()).toBeVisible()
  await expect(sheet()).toHaveCSS('opacity', '1')
  await test.info().attach('environment-settings-sheet.png', {
    body: await page.screenshot({ path: test.info().outputPath('environment-settings-sheet.png') }),
    contentType: 'image/png',
  })
  await saveBar()
    .getByRole('button', { name: /^Salvar alterações/ })
    .click()
  await expect(saveBar()).toHaveCount(0)
  await sheet().getByRole('button', { name: 'Fechar configurações', exact: true }).click()
  await expect(tile('Modelos')).toContainText('1 visível')
  await expect(tile('Modelos')).toContainText('1 oculto de 2')
  // Archiving lives in the panel's last tab, and asks first.
  await page.getByRole('button', { name: 'Configurações do ambiente', exact: true }).click()
  await sheet().getByRole('tab', { name: 'Arquivar', exact: true }).click()
  await sheet().getByRole('button', { name: 'Arquivar Estúdio Dev', exact: true }).click()
  const confirm = page.getByRole('dialog', { name: 'Arquivar ambiente?', exact: true })
  await expect(confirm).toContainText('Scout')
  await expect(confirm).toContainText('Atlas')
  await confirm.getByRole('button', { name: 'Cancelar', exact: true }).click()
  await expect(confirm).toHaveCount(0)
  await expect(sheet()).toBeVisible()
  expect(gateway.requests.filter((request) => request.key === 'environmentArchive')).toEqual([])
})

test('account edits omit unchanged secrets, cancel removal, and preserve state on failures and conflicts', async () => {
  await apiCard().getByRole('button', { name: 'Editar', exact: true }).click()
  await expect(panel().getByLabel('Nova chave de API')).toHaveValue('')
  for (const name of ['First keyboard save', 'Second keyboard save']) {
    await panel().getByLabel('Nome', { exact: true }).fill(name)
    // The gateway records a save before its response reaches the editor; the shortcut is ignored until it does.
    await expect(panel().getByRole('button', { name: 'Salvar alterações' })).toBeEnabled()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
    await expect.poll(() => gateway.states.get('studio')!.accounts.apiKeys[0].name).toBe(name)
    await expect(panel().getByRole('button', { name: 'Salvar alterações' })).toBeDisabled()
  }
  const saves = gateway.requests.filter((r) => r.key === 'settingsPatchAccount')
  expect(saves.at(-1)!.body.expectedRevision).not.toBe(saves.at(-2)!.body.expectedRevision)
  expect(saves.at(-1)!.body).not.toHaveProperty('baseURL')
  expect(gateway.states.get('studio')!.accounts.apiKeys[0].baseURL).toBe('https://api.example.test/[redacted]')
  // The shortcut pressed in the very task of the edit, before the panel renders the change, still saves it.
  await panel()
    .getByLabel('Nome', { exact: true })
    .evaluate((input: HTMLInputElement) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Same-moment save')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }))
    })
  await expect.poll(() => gateway.states.get('studio')!.accounts.apiKeys[0].name).toBe('Same-moment save')
  await expect(panel().getByRole('button', { name: 'Salvar alterações' })).toBeDisabled()
  await panel().getByLabel('Nome', { exact: true }).fill('Saved on close')
  await panel().getByRole('button', { name: 'Fechar', exact: true }).last().click()
  const guard = page.getByRole('dialog', { name: 'Salvar antes de sair?' })
  await expect(guard).toBeVisible()
  await guard.getByRole('button', { name: 'Continuar editando' }).click()
  await expect(panel().getByLabel('Nome', { exact: true })).toHaveValue('Saved on close')
  await page.mouse.click(10, 400)
  await expect(guard).toBeVisible()
  await guard.getByRole('button', { name: 'Salvar e continuar' }).click()
  await expect(page.getByRole('dialog', { name: 'Editar conta' })).toHaveCount(0)
  expect(gateway.states.get('studio')!.accounts.apiKeys[0].name).toBe('Saved on close')
  await apiCard().getByRole('button', { name: 'Editar', exact: true }).click()
  await panel().getByLabel('Nome', { exact: true }).fill('Estúdio principal')
  gateway.controls.failNext = 'settingsPatchAccount'
  await panel().getByRole('button', { name: 'Salvar alterações' }).click()
  await expect(panel().getByRole('alert')).toBeVisible()
  expect(gateway.states.get('studio')!.accounts.apiKeys[0].name).toBe('Saved on close')
  await panel().getByRole('button', { name: 'Salvar alterações' }).click()
  await expect(panel().getByText('Estúdio principal', { exact: false })).toBeVisible()
  expect(gateway.requests.filter((r) => r.key === 'settingsPatchAccount').at(-1)!.body).not.toHaveProperty('apiKey')
  await apiCard().getByRole('button', { name: 'Remover', exact: true }).click()
  // The confirmation opens over the settings panel.
  const removal = page.getByRole('dialog', { name: 'Remover', exact: true })
  await expect(removal).toContainText('Scout, Atlas')
  await removal.getByRole('button', { name: 'Cancelar', exact: true }).click()
  expect(gateway.requests.filter((r) => r.key === 'settingsRemoveAccount')).toHaveLength(0)
  await apiCard().getByRole('button', { name: 'Editar', exact: true }).click()
  await panel().getByLabel('Nome', { exact: true }).fill('Stale rename')
  gateway.states.get('studio')!.accounts.revision = randomUUID()
  await panel().getByRole('button', { name: 'Salvar alterações' }).click()
  await expect(panel().getByRole('alert')).toBeVisible()
  expect(gateway.states.get('studio')!.accounts.apiKeys[0].name).toBe('Estúdio principal')
  await panel().getByRole('button', { name: 'Descartar', exact: true }).click()
  await apiCard().getByRole('button', { name: 'Remover', exact: true }).click()
  await removal.getByRole('button', { name: 'Remover', exact: true }).click()
  await expect(panel().getByText('Estúdio principal', { exact: false })).toHaveCount(0)
  expect(gateway.states.get('research')!.accounts.apiKeys[0].name).toBe('Radar Google AI')
})

test('model visibility drafts survive other tabs, save from one bar, and guard leaving the panel', async () => {
  await section('models')
  const model = panel().getByRole('checkbox', { name: /^Gemini Pro/ })
  await expect(model).toBeChecked()
  await model.uncheck()
  // Another tab keeps the draft: no question, the tab says it has unsaved changes and the bar names it.
  await section('skills')
  const guard = page.getByRole('dialog', { name: 'Salvar antes de sair?' })
  await expect(guard).toHaveCount(0)
  await expect(tab('models')).toHaveAccessibleName(/^Modelos\s*, alterações não salvas$/)
  await saveBar().getByRole('button', { name: 'Modelos', exact: true }).click()
  await expect(tab('models')).toHaveAttribute('aria-selected', 'true')
  await expect(model).not.toBeChecked()
  await saveBar().getByRole('button', { name: 'Descartar', exact: true }).click()
  await expect(model).toBeChecked()
  await expect(saveBar()).toHaveCount(0)
  await model.uncheck()
  await section('accounts')
  await saveBar()
    .getByRole('button', { name: /^Salvar alterações/ })
    .click()
  await expect.poll(() => gateway.states.get('studio')!.models.providers[0].hiddenModelIds).toEqual(['gemini-pro'])
  await expect(saveBar()).toHaveCount(0)
  await section('models')
  await expect(panel().getByText('Em uso por Scout, Atlas')).toBeVisible()
  expect(gateway.bots.find((bot) => bot.id === 'scout')!.selection?.modelId).toBe('gemini-pro')
  expect(gateway.requests.filter((r) => r.key === 'botPatch')).toEqual([])
  // Leaving the panel with a draft asks first; outside it, a press closes it.
  await model.check()
  await page.mouse.click(10, 400)
  await expect(guard).toBeVisible()
  await expect(guard).toContainText('Modelos')
  await guard.getByRole('button', { name: 'Descartar e sair' }).click()
  await expect(sheet()).toHaveCount(0)
  await openEnvironment('Pesquisa Radar')
  await section('models')
  await expect(panel().getByText('Radar Google AI')).toBeVisible()
  await expect(model).toBeChecked()
  expect(gateway.states.get('studio')!.models.providers[0].hiddenModelIds).toEqual(['gemini-pro'])
})

test('MCP editors never reveal secrets and fixture connection results stay bounded', async () => {
  await section('tools')
  await panel().getByRole('button', { name: 'Editar', exact: true }).click()
  await expect(panel().getByLabel('Nova URL', { exact: true })).toHaveValue('')
  await expect(panel().getByLabel('Cabeçalhos para definir', { exact: false })).toHaveValue('')
  for (const name of ['Docs keyboard save', 'Docs keyboard save again']) {
    await panel().getByLabel('Nome', { exact: true }).fill(name)
    // The gateway records a save before its response reaches the editor; the shortcut is ignored until it does.
    await expect(panel().getByRole('button', { name: 'Salvar alterações' })).toBeEnabled()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
    await expect.poll(() => gateway.states.get('studio')!.mcp.servers[0].name).toBe(name)
    await expect(panel().getByRole('button', { name: 'Salvar alterações' })).toBeDisabled()
  }
  const saves = gateway.requests.filter((r) => r.key === 'settingsPatchMcpServer')
  expect(saves.at(-1)!.body.expectedRevision).not.toBe(saves.at(-2)!.body.expectedRevision)
  await panel().getByLabel('Nome', { exact: true }).fill('Estúdio documentation')
  await panel().getByLabel('Remover chave armazenada Authorization').check()
  await panel().getByLabel('Cabeçalhos para definir', { exact: false }).fill('X-Fixture=synthetic-value')
  await panel().getByRole('button', { name: 'Salvar alterações' }).click()
  await expect.poll(() => gateway.states.get('studio')!.mcp.servers[0].headerKeys).toEqual(['X-Fixture'])
  const patch = gateway.requests.filter((r) => r.key === 'settingsPatchMcpServer').at(-1)!.body
  expect(patch.replace ?? {}).toEqual({})
  expect(patch.headers).toEqual({ set: { 'X-Fixture': 'synthetic-value' }, remove: ['Authorization'] })
  for (const [code, text] of [
    ['ok', 'Conectado · 7 ferramentas'],
    ['connection-failed', 'Falha na conexão · 0 ferramentas'],
    ['timeout', 'Tempo de conexão esgotado · 0 ferramentas'],
  ] as const) {
    gateway.controls.mcpResult = code
    await panel().getByRole('button', { name: 'Testar conexão' }).click()
    await expect(panel().getByRole('status')).toContainText(text)
  }
})

test('a compaction draft survives other tabs and a shared default survives revisiting settings', async () => {
  await section('preferences')
  await panel().getByRole('button', { name: 'Modelo de compactação', exact: true }).click()
  await page.getByRole('option', { name: /Gemini Flash/ }).click()
  // The section's own buttons give way to the panel's bar.
  await expect(panel().getByRole('button', { name: 'Salvar padrão' })).toHaveCount(0)
  await section('accounts')
  await expect(page.getByRole('dialog', { name: 'Salvar antes de sair?' })).toHaveCount(0)
  await expect(tab('preferences')).toHaveAccessibleName(/alterações não salvas$/)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
  await expect(saveBar()).toHaveCount(0)
  expect(gateway.environments.find((environment) => environment.id === 'studio')!.compaction?.modelId).toBe(
    'gemini-flash'
  )
  expect(gateway.requests.filter((request) => request.key === 'environmentPatch').at(-1)!.body).toMatchObject({
    expected: { compaction: null },
  })
  await section('preferences')
  await expect(panel().getByRole('button', { name: 'Modelo de compactação', exact: true })).toContainText(
    'Gemini Flash'
  )
})

test('runtime actions poll and cancel remotely; preferences survive relaunch and remain environment scoped', async () => {
  await section('components')
  await expect(panel().getByRole('heading', { name: 'Antigravity ACP' })).toBeVisible()
  const automatic = panel().getByRole('switch', { name: 'Atualizações automáticas' }).first()
  await automatic.click()
  await expect.poll(() => gateway.states.get('studio')!.runtimes.runtimes[0].automatic).toBe(false)
  await panel().getByRole('button', { name: 'Verificar atualizações', exact: true }).first().click()
  await expect(panel().getByText('1.0.0 · Verificando')).toBeVisible()
  const before = gateway.requests.filter((r) => r.key === 'settingsRuntimes').length
  await expect.poll(() => gateway.requests.filter((r) => r.key === 'settingsRuntimes').length).toBeGreaterThan(before)
  await panel().getByRole('button', { name: 'Cancelar', exact: true }).click()
  await panel().getByRole('button', { name: 'Atualizar', exact: true }).first().click()
  await expect(panel().getByText('1.0.0 · Instalando')).toBeVisible()
  await panel().getByRole('button', { name: 'Cancelar', exact: true }).click()
  await section('preferences')
  await panel().getByRole('switch', { name: 'Geração de imagens', exact: true }).click()
  await saveBar()
    .getByRole('button', { name: /^Salvar alterações/ })
    .click()
  await expect.poll(() => gateway.states.get('studio')!.preferences.imageGenEnabled).toBe(false)
  await app.close()
  await launch(false)
  await section('preferences')
  await expect(panel().getByRole('switch', { name: 'Geração de imagens', exact: true })).not.toBeChecked()
  await expect(panel().getByRole('switch', { name: 'Ferramentas de aplicativos', exact: true })).toBeDisabled()
})

test('closing the app with an unsaved draft is never blocked', async () => {
  await section('preferences')
  await panel().getByRole('switch', { name: 'Geração de imagens', exact: true }).click()
  await expect(saveBar().getByRole('button', { name: /^Salvar alterações/ })).toBeEnabled()
  // A beforeunload guard would cancel the window close silently, so quitting would hang.
  await Promise.race([
    app.close(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('The app did not close with a draft')), 20_000)),
  ])
})

test('switching environments drops delayed responses and old images cannot write settings', async () => {
  // The overview already read the models for its summary; the delay applies to the panel's own read.
  const reads = gateway.requests.filter((r) => r.key === 'settingsModels').length
  gateway.controls.delayNext = 'settingsModels'
  gateway.controls.delayMs = 1500
  await section('models')
  await expect.poll(() => gateway.requests.filter((r) => r.key === 'settingsModels').length).toBe(reads + 1)
  await openEnvironment('Pesquisa Radar')
  await section('models')
  await expect(panel().getByText('Radar Google AI')).toBeVisible()
  // The delay belongs to the controlled gateway, not a browser readiness assumption.
  await page.waitForTimeout(1600)
  await expect(panel().getByText('Estúdio Google AI')).toHaveCount(0)
  const environment = gateway.environments.find((e) => e.id === 'research')!
  environment.capabilities = ['environments', 'provisioning']
  gateway.emit({ type: 'environment.updated', at: new Date().toISOString(), environment })
  await expect(
    sheet().getByText('Reinicie este ambiente com a imagem atualizada para configurá-lo pelo app.')
  ).toBeVisible()
  const writes = gateway.requests.filter((r) => r.key.startsWith('settings') && Object.keys(r.body).length).length
  await expect(page.getByRole('checkbox')).toHaveCount(0)
  expect(gateway.requests.filter((r) => r.key.startsWith('settings') && Object.keys(r.body).length)).toHaveLength(
    writes
  )
})

test('named account creation and Google AI login relay leave the local profile unchanged', async () => {
  const localBefore = await page.evaluate(() => window.api.chatConfig())
  await panel().getByRole('button', { name: 'Adicionar uma chave de API', exact: true }).click()
  await panel().getByLabel('Nome da conta', { exact: true }).fill('Synthetic integration')
  await panel().getByLabel('Chave de API', { exact: true }).fill('synthetic-placeholder-not-a-real-key')
  await panel().getByRole('button', { name: 'Adicionar conta', exact: true }).click()
  await expect(panel().getByText('Synthetic integration', { exact: false })).toBeVisible()
  await expect(panel().getByLabel('Chave de API', { exact: true })).toHaveValue('')
  await panel().getByRole('button', { name: 'Adicionar uma chave de API', exact: true }).click()
  await panel().getByRole('button', { name: 'Entrar com Google AI', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Entrar em Google AI no Estúdio Dev' })
  await expect(dialog.getByRole('button', { name: 'Abrir de novo' })).toBeVisible()
  const opened = await app.evaluate(
    () => (globalThis as typeof globalThis & { __settingsOpened: string[] }).__settingsOpened
  )
  expect(opened).toHaveLength(1)
  expect(new URL(opened[0]).origin).toBe('https://accounts.google.com')
  const callback = await fetch(`http://127.0.0.1:${gateway.callbackPort}/?code=synthetic-code&state=synthetic-state`)
  expect(callback.status).toBe(200)
  await expect(dialog.getByRole('status')).toContainText('Conectado como')
  await dialog.getByRole('button', { name: 'Pronto', exact: true }).click()
  expect(gateway.requests.find((r) => r.key === 'environmentLoginStart')).toMatchObject({
    environmentId: 'studio',
    body: { kind: 'antigravity', method: 'browser', slot: 'auto' },
  })
  expect(gateway.requests.find((r) => r.key === 'environmentLoginCallback')?.body).toEqual({
    path: '/',
    query: 'code=synthetic-code&state=synthetic-state',
  })
  expect(await page.evaluate(() => window.api.chatConfig())).toEqual(localBefore)
})

test('skills create, edit, toggle and install through the remote library', async () => {
  const localBefore = await page.evaluate(() => window.api.chatSkills())
  await section('skills')
  await page.getByRole('button', { name: 'Nova skill', exact: true }).click()
  await page.getByPlaceholder('nome (ex.: deploy)', { exact: true }).fill('synthetic-review')
  await page.getByPlaceholder('quando o agente deve usar esta skill?', { exact: true }).fill('Review synthetic changes')
  await page.getByRole('button', { name: 'Criar', exact: true }).click()
  await expect(page.getByText('/synthetic-review', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Ver SKILL.md', exact: true }).last().click()
  const markdown = page.getByRole('textbox', { name: 'Instruções da habilidade (Markdown)' })
  await markdown.fill('# Synthetic review\nUpdated remote instructions.')
  await page.getByRole('button', { name: 'Salvar alterações', exact: true }).click()
  await expect
    .poll(() => gateway.states.get('studio')!.skills.find((s) => s.name === 'synthetic-review')?.markdown)
    .toContain('Updated remote instructions')
  await page.getByRole('button', { name: 'Fechar', exact: true }).last().click()
  await page.getByRole('switch').last().click()
  await expect
    .poll(() => gateway.states.get('studio')!.skills.find((s) => s.name === 'synthetic-review')?.enabled)
    .toBe(false)
  await page.getByRole('tab', { name: 'Biblioteca', exact: true }).click()
  await page.getByPlaceholder('Buscar skills… (ex.: react, testing, changelog)', { exact: true }).fill('review')
  await page.getByRole('button', { name: 'Buscar', exact: true }).click()
  await page.getByRole('button', { name: 'Instalar', exact: true }).click()
  await expect.poll(() => gateway.states.get('studio')!.skills.some((s) => s.name === 'library-review')).toBe(true)
  expect(gateway.states.get('research')!.skills).toHaveLength(1)
  expect(await page.evaluate(() => window.api.chatSkills())).toEqual(localBefore)
})

test('offline gateway retains remote scope and blocks writes without local fallback', async () => {
  await section('preferences')
  await expect(panel().getByRole('switch', { name: 'Geração de imagens', exact: true })).toBeChecked()
  const before = gateway.requests.length
  gateway.disconnect()
  await expect(
    sheet().getByText('Sem conexão. As últimas configurações continuam visíveis; reconecte para editar.')
  ).toBeVisible()
  await expect(panel()).toHaveAttribute('inert', '')
  await expect(panel().getByRole('switch', { name: 'Geração de imagens', exact: true })).toBeChecked()
  expect(
    gateway.requests.slice(before).filter((r) => r.key.startsWith('settings') && Object.keys(r.body).length)
  ).toEqual([])
  expect(gateway.states.get('studio')!.preferences.imageGenEnabled).toBe(true)
})

test('gateway without settings capability offers an update and makes no settings calls', async () => {
  await app.close()
  gateway.controls.capable = false
  gateway.requests.length = 0
  await launch(false)
  await expect(sheet().getByText('Atualize o servidor dos bots para configurar este ambiente pelo app.')).toBeVisible()
  for (const key of Object.keys(sections)) await section(key as keyof typeof sections)
  expect(gateway.requests.filter((r) => r.key.startsWith('settings'))).toEqual([])
})

test('portal editors disable offline writes and guard close without losing drafts', async () => {
  await apiCard().getByRole('button', { name: 'Editar', exact: true }).click()
  await panel().getByLabel('Nome', { exact: true }).fill('Offline draft')
  gateway.disconnect()
  await expect(panel().getByLabel('Nome', { exact: true })).toBeDisabled()
  await expect(panel().getByRole('button', { name: 'Salvar alterações' })).toBeDisabled()
  const writes = gateway.requests.filter((request) => request.key === 'settingsPatchAccount').length
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
  await page.keyboard.press('Escape')
  const guard = page.getByRole('dialog', { name: 'Salvar antes de sair?' })
  await expect(guard.getByRole('button', { name: 'Salvar e continuar' })).toBeDisabled()
  await guard.getByRole('button', { name: 'Continuar editando' }).click()
  await expect(panel().getByLabel('Nome', { exact: true })).toHaveValue('Offline draft')
  await page.keyboard.press('Escape')
  await guard.getByRole('button', { name: 'Descartar e sair' }).click()
  await expect(page.getByRole('dialog', { name: 'Editar conta' })).toHaveCount(0)
  expect(gateway.requests.filter((request) => request.key === 'settingsPatchAccount')).toHaveLength(writes)
})
