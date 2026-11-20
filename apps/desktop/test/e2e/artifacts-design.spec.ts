import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Browser, chromium, expect, type Page, test } from '@playwright/test'
import { type ArtifactApp, launchArtifactApp, type ModelReply, type ModelRequest } from './helpers/artifact-app'

const fixtureDir = fileURLToPath(
  new URL('../../../../packages/artifact-host/test/fixtures/design-sample', import.meta.url)
)

function loadFixtureFiles(dir: string, prefix = ''): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...loadFixtureFiles(full, rel))
    else files.push({ path: rel, content: readFileSync(full, 'utf8') })
  }
  return files
}

function respond(artifact: { id: string }): (request: ModelRequest) => ModelReply {
  return ({ lastUser, toolResults }) => {
    if (lastUser.includes('PUBLISH_DESIGN_SAMPLE')) {
      if ('art-1' in toolResults) return { text: 'Published.' }
      return {
        call: {
          id: 'art-1',
          name: 'artifact_create',
          args: { title: 'Crumb orders', files: loadFixtureFiles(fixtureDir) },
        },
      }
    }
    if (lastUser.includes('READ_COMMENTS')) {
      if ('read-1' in toolResults) return { text: 'Read.' }
      return {
        call: {
          id: 'read-1',
          name: 'artifact_comments',
          args: { id: artifact.id, status: 'all' },
        },
      }
    }
    return { text: 'Nothing to do.' }
  }
}

/**
 * End-to-end design mode viewer flows against the shared `design-sample` fixture:
 * 1. Inspect: select an instance on Today and jump to its main component in components.html.
 * 2. Tokens: edit a token with live preview and save as a new version.
 * 3. Suggestions: a shared guest proposes a token edit, the owner previews and applies it,
 *    creating a new version and exposing the structured suggestion to `artifact_comments`.
 */
test('design mode viewer: inspect to main, edit tokens to version, suggest and apply', async () => {
  test.setTimeout(90_000)
  const artifact = { id: '' }
  let owner: ArtifactApp | undefined
  let browser: Browser | undefined
  try {
    owner = await launchArtifactApp({ name: 'artifacts-design', respond: respond(artifact) })
    await owner.send('PUBLISH_DESIGN_SAMPLE: publish the design sample.', 'Published.')
    artifact.id = owner.toolResult('art-1').artifact.id as string
    const id = artifact.id

    browser = await chromium.launch()
    const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' })
    const ownerPage: Page = await ownerContext.newPage()
    await ownerPage.goto(await owner.gateway.ownerViewerUrl(id))
    const stageFrame = ownerPage.frameLocator('iframe.content')
    await expect(stageFrame.locator('[data-ds="Button"]').first()).toBeVisible({ timeout: 20_000 })

    // 1. Inspect -> select instance -> Go to main component.
    await ownerPage.locator('.inspect-button').click()
    await stageFrame.locator('[data-ds="Button"]').nth(1).click()
    const inspectPanel = ownerPage.locator('.inspect-panel')
    await expect(inspectPanel).toBeVisible()
    await expect(inspectPanel.locator('.side-head h2')).toHaveText('Button')
    await expect(inspectPanel.locator('.side-sub')).toContainText('Instance')
    await expect(inspectPanel.locator('.go-main')).toBeEnabled()

    await inspectPanel.locator('.go-main').click()
    await expect(inspectPanel.locator('.side-sub')).toHaveText('Main component · components.html')
    await expect(inspectPanel.locator('.usage')).toBeVisible()
    await expect(inspectPanel.locator('.usage-total')).toContainText('15 instances on 6 screens', { timeout: 20_000 })
    await expect(inspectPanel.locator('.side-back')).toContainText('Back to Today')

    // Return to Today before editing tokens.
    await inspectPanel.locator('.side-back').click()
    await expect(stageFrame.locator('[data-ds="Button"]').first()).toBeVisible()

    // 2. Tokens -> edit -> save as new version (v2).
    await ownerPage.locator('.tokens-button').click()
    const tokensPanel = ownerPage.locator('.tokens-panel')
    await expect(tokensPanel).toBeVisible()
    const accentRow = tokensPanel.locator('.token-row', {
      has: ownerPage.locator('.token-name', { hasText: /^--color-accent$/ }),
    })
    const accentInput = accentRow.locator('input.token-input')
    await expect(accentInput).toHaveValue(/^#b4532a$/i)
    await accentInput.fill('#0F766E')
    await accentInput.press('Enter')
    await expect(accentRow).toHaveClass(/is-changed/)

    // Live preview updates the computed style of components inside the stage frame.
    await expect
      .poll(
        () =>
          stageFrame
            .locator('[data-ds="Button"]')
            .nth(1)
            .evaluate((el) => getComputedStyle(el).backgroundColor),
        { timeout: 10_000 }
      )
      .toBe('rgb(15, 118, 110)')

    await tokensPanel.locator('.button.primary').click()
    const saveDialog = ownerPage.locator('dialog.save-dialog[open]')
    await expect(saveDialog).toBeVisible()
    await saveDialog.locator('button[type="submit"]').click()
    await expect(ownerPage.locator('.toast')).toContainText('Saved as version 2', { timeout: 15_000 })
    await expect(ownerPage.getByRole('group', { name: 'Version' })).toContainText('v2')
    expect((await owner.artifacts('detail', id)).versions).toHaveLength(2)

    // Close Tokens panel on owner side before guest submits a suggestion.
    await ownerPage.locator('.tokens-button').click()

    // 3. Guest suggests a token change -> Owner previews and applies it (v3).
    await owner.artifacts('setSharing', id, { visibility: 'people' })
    const invite = (await owner.artifacts('createInvite', id, 'Maria')) as { link: string }
    const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' })
    const maria: Page = await guestContext.newPage()
    await maria.goto(invite.link)
    await maria.getByRole('button', { name: 'Continue as Maria' }).click()
    await expect(maria.frameLocator('iframe.content').locator('[data-ds="Button"]').first()).toBeVisible({
      timeout: 20_000,
    })

    await maria.locator('.tokens-button').click()
    const mariaTokens = maria.locator('.tokens-panel')
    const radiusRow = mariaTokens.locator('.token-row', {
      has: maria.locator('.token-name', { hasText: /^--radius-md$/ }),
    })
    const radiusInput = radiusRow.locator('input.token-input')
    await radiusInput.fill('14px')
    await radiusInput.press('Enter')
    await mariaTokens.locator('.button.primary').click()
    const suggestCard = maria.locator('.card')
    await expect(suggestCard).toBeVisible()
    await suggestCard.locator('textarea').fill('Rounder buttons fit the delivery cards better.')
    await suggestCard.locator('button[type="submit"]').click()
    await expect(maria.locator('.toast')).toContainText('Suggestion sent', { timeout: 15_000 })

    // Owner reloads to pick up Maria's suggestion thread, previews it, then applies it as v3.
    await ownerPage.reload()
    await expect(stageFrame.locator('[data-ds="Button"]').first()).toBeVisible({ timeout: 20_000 })
    await ownerPage.locator('.list-button').click()
    const suggestionItem = ownerPage.locator('.list .item', { hasText: 'Rounder buttons' }).first()
    await expect(suggestionItem).toBeVisible({ timeout: 15_000 })
    await suggestionItem.click()

    const card = ownerPage.locator('.card')
    await expect(card.locator('.suggestion')).toBeVisible()
    await expect(card.locator('.suggestion')).toContainText('--radius-md')
    await expect(card.locator('.suggestion')).toContainText('14px')

    await card.locator('.suggestion-actions button', { hasText: 'Preview' }).click()
    await expect
      .poll(
        () =>
          stageFrame
            .locator('[data-ds="Button"]')
            .nth(1)
            .evaluate((el) => getComputedStyle(el).borderRadius),
        { timeout: 10_000 }
      )
      .toBe('14px')

    await card.locator('.suggestion-actions .button.primary').click()
    const applyDialog = ownerPage.locator('dialog.save-dialog[open]')
    await expect(applyDialog).toBeVisible()
    await applyDialog.locator('button[type="submit"]').click()
    await expect(ownerPage.locator('.toast')).toContainText('Saved as version 3', { timeout: 15_000 })
    await expect(ownerPage.getByRole('group', { name: 'Version' })).toContainText('v3')
    await expect(card.locator('.suggestion')).toContainText('Applied in version 3')
    expect((await owner.artifacts('detail', id)).versions).toHaveLength(3)

    // Verify `artifact_comments` exposes the structured suggestion with appliedVersion to agents.
    await owner.send('READ_COMMENTS: inspect the comments.', 'Read.')
    const readEnvelope = owner.requests.find((req) => 'read-1' in req.toolResults)!.toolResults['read-1']!
    const parsed = JSON.parse(
      readEnvelope.slice(
        readEnvelope.indexOf('>', readEnvelope.indexOf('<artifact-comments')) + 1,
        readEnvelope.lastIndexOf('</artifact-comments>')
      )
    ) as {
      comments: Array<{
        body: string
        status: string
        suggestion?: {
          file: string
          changes: Array<{ name: string; from: string; to: string; theme?: string }>
          appliedVersion: number | null
        } | null
      }>
    }
    const suggestionComment = parsed.comments.find((c) => c.body.includes('Rounder buttons'))
    expect(suggestionComment).toMatchObject({
      status: 'resolved',
      suggestion: {
        file: 'tokens.css',
        changes: [{ name: '--radius-md', from: '10px', to: '14px' }],
        appliedVersion: 3,
      },
    })
  } finally {
    await browser?.close()
    await owner?.close()
  }
})
