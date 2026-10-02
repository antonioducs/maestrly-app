import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import type { Api } from '../../src/preload'
import { removeTempDirEventually } from './helpers/temp-cleanup'

declare const window: Window & { api: Api }
const desktop = fileURLToPath(new URL('../..', import.meta.url))

/** Personal memory is reached from the chat settings, not from the sidebar. */
async function openPersonalMemory(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: 'Models & agents', exact: true }).click()
  await page.getByRole('button', { name: 'Manage personal memory', exact: true }).click()
  await expect(page.getByTestId('personal-memory-panel')).toBeVisible()
}

test('personal memory management survives restart and remains available when disabled', async () => {
  test.setTimeout(120_000)
  const root = mkdtempSync(path.join(os.tmpdir(), 'maestrly-personal-memory-'))
  let app: ElectronApplication | undefined
  const launch = () =>
    electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...process.env,
        AGENTS_E2E: '1',
        AGENTS_CHANNEL: 'dev',
        AGENTS_INSTANCE: 'personal-memory-fixture',
        AGENTS_USERDATA: root,
        AGENTS_LOCALE: 'en',
        ELECTRON_RENDERER_URL: '',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      },
    })
  try {
    app = await launch()
    let page = await app.firstWindow()
    await page.waitForFunction(() => Boolean(window.api))
    await page.waitForLoadState('load')
    await page.evaluate(() => window.api.setOnboardingDone(true))
    await page.reload()
    await page.getByRole('tab', { name: 'Chats', exact: true }).click()
    await expect(page.locator('#sidebar-panel-chats').getByRole('button', { name: 'Personal memory' })).toHaveCount(0)
    await openPersonalMemory(page)
    const emptyPanel = page.getByTestId('personal-memory-panel')
    await expect(emptyPanel.getByRole('heading', { name: 'No memories yet.', exact: true })).toBeVisible()
    await expect(emptyPanel.getByRole('button', { name: 'Clear filters', exact: true })).toHaveCount(0)
    await expect(emptyPanel.getByRole('button', { name: 'New memory', exact: true })).toHaveCount(2)
    await emptyPanel.getByRole('button', { name: 'New memory', exact: true }).last().click()
    await page.getByPlaceholder('Title', { exact: true }).fill('Synthetic writing preference')
    await page.getByPlaceholder('Durable content', { exact: true }).fill('Use concise synthetic examples.')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await window.api.listPersonalMemories()).length)).toBe(1)
    const memories = await page.evaluate(() => window.api.listPersonalMemories())
    expect(memories).toHaveLength(1)
    const id = memories[0].id
    await expect(page.getByRole('dialog', { name: 'Memory details', exact: true })).toBeVisible()
    await expect(page.getByRole('dialog', { name: 'Memory details', exact: true }).getByRole('textbox')).toHaveCount(0)
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByRole('checkbox', { name: 'Pin memory', exact: false }).check()
    await page.getByText('Type, scope and tags', { exact: true }).click()
    await page.getByRole('combobox', { name: 'Type', exact: true }).click()
    await page.getByRole('option', { name: 'Preference', exact: true }).click()
    await page.getByLabel('Scope', { exact: true }).fill('Synthetic writing')
    await page.getByLabel('Tags, comma-separated', { exact: true }).fill('synthetic, concise')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect
      .poll(() => page.evaluate(async (memoryId) => (await window.api.getPersonalMemory(memoryId))?.pinned, id))
      .toBe(true)
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    const contentEditor = page.getByPlaceholder('Durable content', { exact: true })
    await contentEditor.fill('Unsaved synthetic draft')
    const otherId = await page.evaluate(
      async () =>
        (
          await window.api.createPersonalMemory({
            title: 'Unrelated synthetic memory',
            content: 'A separate synthetic note.',
            type: 'reference',
          })
        ).memory.id
    )
    await expect(
      page.getByTestId('personal-memory-row').filter({ hasText: 'Unrelated synthetic memory' })
    ).toBeAttached()
    await expect(contentEditor).toHaveValue('Unsaved synthetic draft')
    await page.evaluate(
      (memoryId) =>
        window.api.updatePersonalMemory(memoryId, {
          title: 'Externally updated preference',
          content: 'External content must not replace the edited draft.',
          importance: 80,
        }),
      id
    )
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Externally updated preference')
    await expect(contentEditor).toHaveValue('Unsaved synthetic draft')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Externally updated preference', exact: true })).toBeVisible()
    expect(await page.evaluate((memoryId) => window.api.getPersonalMemory(memoryId), id)).toMatchObject({
      title: 'Externally updated preference',
      content: 'Unsaved synthetic draft',
      importance: 80,
      pinned: true,
      type: 'preference',
      scope: 'Synthetic writing',
      tags: ['concise', 'synthetic'],
    })
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    const oversizedDraft = 'x'.repeat(256 * 1024 + 1)
    await contentEditor.fill(oversizedDraft)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(contentEditor).toHaveValue(oversizedDraft)
    expect(await page.evaluate((memoryId) => window.api.getPersonalMemory(memoryId), id)).toMatchObject({
      content: 'Unsaved synthetic draft',
    })
    await page.keyboard.press('Escape')
    const discard = page.getByRole('dialog', { name: 'Discard changes?', exact: true })
    await expect(discard).toBeVisible()
    await discard.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(contentEditor).toHaveValue(oversizedDraft)
    await page.getByPlaceholder('Title', { exact: true }).fill('Synthetic writing preference')
    await contentEditor.fill('Use concise synthetic examples.')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect
      .poll(() => page.evaluate(async (memoryId) => (await window.api.getPersonalMemory(memoryId))?.title, id))
      .toBe('Synthetic writing preference')
    await page
      .getByRole('dialog', { name: 'Memory details', exact: true })
      .getByRole('button', { name: 'Close', exact: true })
      .last()
      .click()
    for (const closeAction of ['Escape', 'Close', 'Cancel']) {
      await page.getByRole('button', { name: 'New memory', exact: true }).click()
      await page.getByLabel('Title', { exact: true }).fill('Discarded synthetic draft')
      if (closeAction === 'Escape') await page.keyboard.press('Escape')
      else
        await page
          .getByRole('dialog', { name: 'New memory', exact: true })
          .getByRole('button', { name: closeAction, exact: true })
          .click()
      await discard.getByRole('button', { name: 'Discard', exact: true }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'New memory', exact: true })).toBeFocused()
    }
    await expect.poll(() => page.evaluate(async () => (await window.api.listPersonalMemories()).length)).toBe(2)
    await page.evaluate((memoryId) => window.api.forgetPersonalMemory(memoryId, true), otherId)
    await page.evaluate(async () => {
      const settings = await window.api.getPersonalMemorySettings()
      await window.api.setPersonalMemorySettings({ ...settings, enabled: false })
    })
    const chats = await page.evaluate(async () =>
      Promise.all([
        window.api.createStandaloneConversation({ name: 'Synthetic chat one' }),
        window.api.createStandaloneConversation({ name: 'Synthetic chat two' }),
      ])
    )
    await page.reload()
    await page.waitForFunction(() => Boolean(window.api))
    await page.getByRole('tab', { name: 'Chats', exact: true }).click()
    await expect(page.locator('li.conv-item', { hasText: 'Synthetic chat one' })).toBeVisible()
    for (const chat of chats) {
      await page.evaluate(
        ({ conversationId, memoryId }) =>
          window.dispatchEvent(new CustomEvent('maestrly:open-memory', { detail: { conversationId, memoryId } })),
        { conversationId: chat.id, memoryId: id }
      )
      await expect(
        page
          .getByRole('dialog', { name: 'Memory details', exact: true })
          .getByRole('heading', { name: 'Synthetic writing preference', exact: true })
      ).toBeVisible()
      await page.getByRole('button', { name: 'Close', exact: true }).last().click()
    }
    await app.close()
    app = await launch()
    page = await app.firstWindow()
    await page.waitForFunction(() => Boolean(window.api))
    expect(await page.evaluate(() => window.api.getPersonalMemorySettings())).toMatchObject({ enabled: false })
    expect(await page.evaluate((memoryId) => window.api.getPersonalMemory(memoryId), id)).toMatchObject({
      pinned: true,
      type: 'preference',
      scope: 'Synthetic writing',
      tags: ['concise', 'synthetic'],
    })
    await openPersonalMemory(page)
    await page
      .getByTestId('personal-memory-panel')
      .getByRole('button', { name: 'Synthetic writing preference', exact: true })
      .click()
    await expect(page.getByText('Personal memory is disabled. You can still manage saved memories.')).toBeVisible()
    await page.getByRole('button', { name: 'Archive', exact: true }).click()
    await expect
      .poll(() => page.evaluate(async (memoryId) => (await window.api.getPersonalMemory(memoryId))?.status, id))
      .toBe('archived')
    await page.getByRole('button', { name: 'Restore', exact: true }).click()
    await expect
      .poll(() => page.evaluate(async (memoryId) => (await window.api.getPersonalMemory(memoryId))?.status, id))
      .toBe('active')
    await page.getByRole('button', { name: 'Forget permanently', exact: true }).click()
    const forget = page.getByRole('dialog', { name: 'Forget this memory?', exact: true })
    await forget.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(await page.evaluate((memoryId) => window.api.getPersonalMemory(memoryId), id)).toBeTruthy()
    await page.getByRole('button', { name: 'Forget permanently', exact: true }).click()
    await forget.getByRole('button', { name: 'Forget permanently', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.api.listPersonalMemories())).toEqual([])
  } finally {
    await app?.close()
    await removeTempDirEventually(root)
  }
})

test('personal memory filters, keyboard selection and settings use persisted data', async () => {
  test.setTimeout(120_000)
  const root = mkdtempSync(path.join(os.tmpdir(), 'maestrly-personal-memory-filters-'))
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...process.env,
        AGENTS_E2E: '1',
        AGENTS_CHANNEL: 'dev',
        AGENTS_INSTANCE: 'personal-memory-filters-fixture',
        AGENTS_USERDATA: root,
        AGENTS_LOCALE: 'en',
        ELECTRON_RENDERER_URL: '',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      },
    })
    const page = await app.firstWindow()
    await page.waitForFunction(() => Boolean(window.api))
    await page.evaluate(async () => {
      await window.api.setOnboardingDone(true)
      const settings = await window.api.getPersonalMemorySettings()
      await window.api.setPersonalMemorySettings({
        ...settings,
        enabled: true,
        extraction: { enabled: false, selection: null },
      })
      const types = ['decision', 'constraint', 'preference', 'procedure', 'lesson', 'reference'] as const
      for (const [index, type] of types.entries()) {
        const { memory } = await window.api.createPersonalMemory({
          title: `Synthetic ${type}`,
          content: `Synthetic durable ${type} content.`,
          type,
          pinned: type === 'preference',
          scope: `scope-${type}`,
          tags: [`tag-${type}`],
        })
        if (index === 0) await window.api.archivePersonalMemory(memory.id)
        if (index === 1) await window.api.updatePersonalMemory(memory.id, { status: 'superseded' })
      }
    })
    await page.reload()
    await openPersonalMemory(page)
    const panel = page.getByTestId('personal-memory-panel')
    const rows = panel.getByTestId('personal-memory-row')
    await expect(rows).toHaveCount(6)
    const type = panel.getByRole('combobox', { name: 'Type', exact: true })
    await type.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('option')).toHaveText([
      'All types',
      'Decision',
      'Constraint',
      'Preference',
      'Procedure',
      'Lesson',
      'Reference',
    ])
    await page.keyboard.press('End')
    await expect(page.getByRole('option', { name: 'Reference', exact: true })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(type).toHaveText('Reference')
    await expect(rows).toHaveCount(1)
    await expect(rows).toHaveAttribute('aria-label', 'Synthetic reference')
    await type.click()
    await page.getByRole('option', { name: 'All types', exact: true }).click()
    const status = panel.getByRole('combobox', { name: 'Status', exact: true })
    await status.click()
    await expect(page.getByRole('option')).toHaveText(['All statuses', 'Active', 'Superseded', 'Archived'])
    await page.getByRole('option', { name: 'Superseded', exact: true }).click()
    await expect(rows).toHaveCount(1)
    await expect(rows).toHaveAttribute('aria-label', 'Synthetic constraint')
    await rows.click()
    const details = page.getByRole('dialog', { name: 'Memory details', exact: true })
    await expect(
      details.getByText('This memory was superseded and is not used by chats.', { exact: true })
    ).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(rows).toBeFocused()
    await status.click()
    await page.getByRole('option', { name: 'All statuses', exact: true }).click()
    await panel.getByRole('button', { name: 'Pinned', exact: true }).click()
    await expect(rows).toHaveCount(1)
    await expect(rows).toHaveAttribute('aria-label', 'Synthetic preference')
    await panel.getByRole('button', { name: 'Pinned', exact: true }).click()
    const search = panel.getByPlaceholder('Search memories, tags or scope…', { exact: true })
    for (const query of ['scope-lesson', 'tag-lesson', 'Synthetic lesson']) {
      await search.fill(query)
      await expect(rows).toHaveCount(1)
      await expect(rows).toHaveAttribute('aria-label', 'Synthetic lesson')
    }
    await search.fill('')
    await panel.getByRole('tab', { name: /^Archived/ }).click()
    await expect(rows).toHaveCount(1)
    await expect(rows).toHaveAttribute('aria-label', 'Synthetic decision')
    await panel.getByRole('tab', { name: /^Recent/ }).click()
    await expect(rows).toHaveCount(5)
    await panel.getByRole('tab', { name: /^All/ }).click()
    await expect(rows).toHaveCount(6)

    await panel.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Personal memory settings', exact: true })
    const enabled = settings.getByRole('checkbox', { name: 'Enable personal memory', exact: false })
    const extraction = settings.getByRole('checkbox', { name: 'Save memories from conversations', exact: true })
    await expect(enabled).toBeChecked()
    await extraction.check()
    await settings.getByRole('button', { name: 'Save memory settings', exact: true }).click()
    await expect(settings.getByRole('status')).toHaveText('Choose a model to save memories from conversations.')
    await expect(extraction).toBeChecked()
    expect(await page.evaluate(() => window.api.getPersonalMemorySettings())).toMatchObject({
      extraction: { enabled: false, selection: null },
    })
    await page.keyboard.press('Escape')
    const discard = page.getByRole('dialog', { name: 'Discard changes?', exact: true })
    await discard.getByRole('button', { name: 'Keep editing', exact: true }).click()
    await expect(extraction).toBeChecked()
    await settings.getByRole('button', { name: 'Cancel', exact: true }).click()
    await discard.getByRole('button', { name: 'Discard changes', exact: true }).click()
    await expect(settings).toHaveCount(0)
    await panel.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(extraction).not.toBeChecked()
    await enabled.uncheck()
    await settings.getByRole('button', { name: 'Save memory settings', exact: true }).click()
    await expect(settings).toHaveCount(0)
    expect(await page.evaluate(() => window.api.getPersonalMemorySettings())).toMatchObject({
      enabled: false,
      extraction: { enabled: false, selection: null },
    })
    await expect(rows).toHaveCount(6)
    await panel.getByRole('button', { name: 'More options', exact: true }).click()
    const more = page.getByRole('dialog', { name: 'More options', exact: true })
    await expect(more.getByRole('button', { name: 'Export JSON', exact: true })).toBeEnabled()
    await expect(more.getByRole('button', { name: 'Export Markdown', exact: true })).toBeEnabled()
    await expect(more.getByRole('button', { name: 'Rebuild index', exact: true })).toBeVisible()
  } finally {
    await app?.close()
    await removeTempDirEventually(root)
  }
})
