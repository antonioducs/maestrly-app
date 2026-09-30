import { type Browser, chromium, expect, type Page, test } from '@playwright/test'
import { type ArtifactApp, launchArtifactApp } from './helpers/artifact-app'

const PAGE = '<!doctype html><html><head></head><body><h1 id="t">Shared probe</h1></body></html>'
const UNAVAILABLE = 'This page is not available'

/**
 * The owner shares an artifact from the Artifacts center while other people open it in an ordinary browser: a
 * personal link that joins only on request, an access request the owner approves under a corrected name, and a
 * link for anyone behind an access code. Revoking a person and going back to private cut access at once.
 */
test('shares an artifact with invited people, approved requests and guests', async () => {
  test.setTimeout(240_000)
  let owner: ArtifactApp | undefined
  let browser: Browser | undefined
  try {
    owner = await launchArtifactApp({
      name: 'artifacts-sharing',
      respond: (request) =>
        'art-1' in request.toolResults
          ? { text: 'Published.' }
          : {
              call: {
                id: 'art-1',
                name: 'artifact_create',
                args: { title: 'Probe', files: [{ path: 'index.html', content: PAGE }] },
              },
            },
    })
    const { page } = owner
    await owner.send('PUBLISH_ARTIFACT: make a probe page.', 'Published.')
    const id = owner.toolResult('art-1').artifact.id as string
    const pageUrl = `http://127.0.0.1:${owner.port}/a/${id}`

    // Each visitor is a separate browser profile, as separate people on separate devices would be.
    browser = await chromium.launch()
    const visitor = async (): Promise<Page> => (await browser!.newContext({ locale: 'en-US' })).newPage()
    const heading = (visitorPage: Page) => visitorPage.frameLocator('iframe.content').locator('#t')

    await page.getByTestId('sidebar-artifacts').click()
    const center = page.getByTestId('artifacts-center')
    const card = center.locator(`[data-testid="artifact-card"][data-artifact-id="${id}"]`)
    await expect(card).toContainText('Probe')
    const dialog = page.getByTestId('artifact-share')
    const openShare = async () => {
      await card.getByTestId('artifact-menu').click()
      await page.getByTestId('artifact-share-open').click()
      await expect(dialog.getByTestId('artifact-share-visibility')).toBeVisible()
    }
    const choose = async (visibility: 'private' | 'people' | 'link') => {
      await dialog.getByTestId('artifact-share-visibility').click()
      await page.getByTestId(`artifact-share-visibility-${visibility}`).click()
      await expect.poll(async () => (await owner!.artifacts('sharing', id)).visibility as string).toBe(visibility)
    }
    const closeShare = async () => {
      await dialog.getByRole('button', { name: 'Done' }).click()
      await expect(dialog).toHaveCount(0)
    }

    // 1. The owner shares with people and creates Maria's link.
    await openShare()
    await choose('people')
    await dialog.getByTestId('artifact-share-name').fill('Maria')
    await dialog.getByTestId('artifact-share-create').click()
    await expect(dialog.getByTestId('artifact-person')).toContainText('Maria')
    await expect(dialog.getByTestId('artifact-share-status')).toContainText('Link for Maria copied')
    const [maria] = (await owner.artifacts('sharing', id)).people as Array<{ id: string; devices: unknown[] }>
    const link = (await owner.artifacts('inviteLink', id, maria!.id)) as string
    expect(link).toMatch(new RegExp(`^${pageUrl}#i=[A-Za-z0-9_-]{43}$`))

    // 2. Opening the link shows who the visitor is about to be, and joins nothing until they confirm.
    const mariaPage = await visitor()
    await mariaPage.goto(link)
    await expect(mariaPage.getByRole('heading', { name: 'Antonio invited you as Maria' })).toBeVisible()
    expect(mariaPage.url()).toBe(pageUrl)
    expect(((await owner.artifacts('sharing', id)).people as Array<{ devices: unknown[] }>)[0]!.devices).toEqual([])
    await mariaPage.getByRole('button', { name: 'Continue as Maria' }).click()
    await expect(heading(mariaPage)).toHaveText('Shared probe')
    await expect(mariaPage.locator('.identity')).toHaveAttribute('aria-label', 'You: Maria, invited by Antonio')

    // 3. The owner sees Maria's device and a new event, which the detail panel marks as seen.
    await expect(dialog.getByTestId('artifact-person-devices').locator('li')).toHaveCount(1)
    await expect(dialog.getByTestId('artifact-person-devices')).toContainText('Chrome on')
    await expect(page.getByTestId('sidebar-artifacts-unseen')).toHaveText('1')
    await closeShare()
    await card.getByTestId('artifact-card-select').click()
    const detail = center.getByTestId('artifact-detail')
    await expect(detail.getByTestId('artifact-events')).toContainText('Maria opened it on Chrome on')
    await expect(detail.getByTestId('artifact-detail-people')).toContainText('1 person · 1 device')
    await expect(page.getByTestId('sidebar-artifacts-unseen')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(detail).toHaveCount(0)

    // 4. Revoking Maria removes her from the list and cuts her off at once: her browser is back to asking for
    // access, without the page.
    await openShare()
    await dialog.getByTestId('artifact-person-revoke').click()
    await dialog.getByRole('button', { name: 'Revoke', exact: true }).click()
    await expect(dialog.getByTestId('artifact-person')).toHaveCount(0)
    await closeShare()
    await mariaPage.reload()
    await expect(mariaPage.getByRole('heading', { name: 'Ask Antonio for access' })).toBeVisible()
    await expect(mariaPage.locator('iframe.content')).toHaveCount(0)
    await mariaPage.goto(link)
    await expect(mariaPage.getByRole('heading', { name: 'Ask Antonio for access' })).toBeVisible()

    // 5. Someone without a link asks for access; the owner approves under the name they confirmed.
    const joaoPage = await visitor()
    await joaoPage.goto(pageUrl)
    await joaoPage.getByLabel('Your name').fill('João')
    await joaoPage.getByLabel('Message (optional)').fill('Can I see it?')
    await joaoPage.getByRole('button', { name: 'Ask for access' }).click()
    await expect(joaoPage.getByRole('heading', { name: 'Waiting for approval' })).toBeVisible()
    await expect(card.getByTestId('artifact-card-requests')).toHaveText('1 request')
    await card.getByTestId('artifact-card-select').click()
    const request = detail.getByTestId('artifact-request')
    await expect(request).toContainText('Can I see it?')
    await request.getByTestId('artifact-request-name').fill('João Silva')
    await request.getByTestId('artifact-request-approve').click()
    await expect(detail.getByTestId('artifact-request')).toHaveCount(0)
    await expect(heading(joaoPage)).toHaveText('Shared probe', { timeout: 10_000 })
    await expect(joaoPage.locator('.identity')).toHaveAttribute('aria-label', 'You: João Silva, approved by Antonio')
    await page.keyboard.press('Escape')

    // 6. With a link for anyone behind an access code, a guest gets in only with the right code.
    await openShare()
    await choose('link')
    await dialog.getByTestId('artifact-share-code').fill('letmein1')
    await dialog.getByRole('button', { name: 'Save code' }).click()
    await expect(dialog.getByTestId('artifact-share-status')).toContainText('Access code saved')
    const guestPage = await visitor()
    await guestPage.goto(pageUrl)
    await guestPage.getByLabel('Access code').fill('wrong-code')
    await guestPage.getByRole('button', { name: 'View page' }).click()
    await expect(guestPage.getByRole('alert')).toHaveText('That code is not right.')
    await guestPage.getByLabel('Access code').fill('letmein1')
    await guestPage.getByRole('button', { name: 'View page' }).click()
    await expect(heading(guestPage)).toHaveText('Shared probe')
    await expect(guestPage.locator('.identity')).toHaveAttribute('aria-label', 'You: guest')

    // 7. Private again: nobody but the owner reaches the page, whatever they held before.
    await choose('private')
    await closeShare()
    for (const visitorPage of [mariaPage, joaoPage, guestPage]) {
      await visitorPage.reload()
      await expect(visitorPage.getByRole('heading', { name: UNAVAILABLE })).toBeVisible()
      await expect(visitorPage.locator('iframe.content')).toHaveCount(0)
    }
    await expect(card.getByTestId('artifact-card-visibility')).toHaveCount(0)
  } finally {
    await browser?.close().catch(() => {})
    await owner?.close()
  }
})
