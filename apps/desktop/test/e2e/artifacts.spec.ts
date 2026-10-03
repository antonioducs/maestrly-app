import { existsSync } from 'node:fs'
import path from 'node:path'
import { openArtifactHost } from '@maestrly/artifact-host'
import { expect, test } from '@playwright/test'
import { type ArtifactApp, launchArtifactApp } from './helpers/artifact-app'

const encode = (text: string) => new TextEncoder().encode(text)
const PAGE = (heading: string) =>
  `<!doctype html><html><head><link rel="stylesheet" href="app.css"></head><body><h1 id="t">${heading}</h1></body></html>`
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7])

/** Waits for the drawer to show an artifact's page, and returns its heading from inside the sandboxed frame. */
async function renderedHeading(owner: ArtifactApp, id: string): Promise<string | null> {
  return owner.app.evaluate(async ({ webContents }, id) => {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      for (const contents of webContents.getAllWebContents()) {
        if (contents.isOffscreen() || !contents.getURL().includes(`/a/${id}`)) continue
        const frame = contents.mainFrame.framesInSubtree.find((candidate) => candidate.url.includes('/c/'))
        const heading = await frame
          ?.executeJavaScript(`document.getElementById('t')?.textContent ?? null`)
          .catch(() => null)
        if (heading) return heading as string
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return null
  }, id)
}

/**
 * Without a bot server there is nowhere to publish: the agent is told to ask for one instead of improvising, nothing is
 * kept on this computer, and the app offers to set up a server for artifacts alone.
 */
test('asks for a bot server instead of publishing on this computer', async () => {
  test.setTimeout(180_000)
  let owner: ArtifactApp | undefined
  try {
    owner = await launchArtifactApp({
      name: 'artifacts-no-server',
      server: false,
      respond: (request) =>
        'art-1' in request.toolResults
          ? { text: 'Told the user.' }
          : {
              call: {
                id: 'art-1',
                name: 'artifact_create',
                args: { title: 'Probe', files: [{ path: 'index.html', content: PAGE('Probe') }] },
              },
            },
    })
    const { page } = owner
    await owner.send('PUBLISH_ARTIFACT: make a probe page.', 'Told the user.')
    const result = owner.requests.find((request) => 'art-1' in request.toolResults)!.toolResults['art-1']!
    expect(result).toContain('No bot server is connected')
    expect(existsSync(path.join(owner.profile, 'artifacts'))).toBe(false)

    // The center explains what is missing, and leads to the setup.
    await page.getByTestId('sidebar-artifacts').click()
    const center = page.getByTestId('artifacts-center')
    await expect(center.getByTestId('artifacts-unavailable')).toHaveAttribute('data-reason', 'absent')
    await expect(center.getByTestId('artifacts-server-chip')).toContainText('Not connected')
    await center.getByRole('button', { name: 'Set up a bot server' }).click()
    await expect(center).toHaveCount(0)

    // Settings → Artifacts offers the installer's choices, and opens the server setup for artifacts alone.
    const settings = page.getByTestId('artifacts-settings')
    await expect(settings.getByTestId('artifacts-server-setup')).toBeVisible()
    await expect(settings.getByTestId('artifacts-server')).toHaveCount(0)
    await settings.getByRole('button', { name: /On a server \(VPS\)/ }).click()
    await expect(page.getByRole('radio', { name: /Artifacts only/ })).toBeChecked()
  } finally {
    await owner?.close()
  }
})

/**
 * Artifacts an earlier version published on this computer no longer open, until the owner moves them: they reach the
 * bot server with the same IDs, versions, comments and previews, shared ones become private, and the local folder goes.
 */
test('moves what an earlier version left on this computer to the bot server', async () => {
  test.setTimeout(240_000)
  const ids: { shared: string; plain: string } = { shared: '', plain: '' }
  let owner: ArtifactApp | undefined
  try {
    owner = await launchArtifactApp({
      name: 'artifacts-move',
      prepare: async (profile) => {
        const local = await openArtifactHost({
          dataDir: path.join(profile, 'artifacts'),
          port: 0,
          quotaBytes: 10 * 1024 * 1024,
        })
        try {
          const origin = { workspaceId: null, conversationId: 'earlier-chat', conversationTitle: 'Earlier chat' }
          const files = (heading: string) => [
            { path: 'index.html', bytes: encode(PAGE(heading)) },
            { path: 'app.css', bytes: encode('h1{color:rgb(1,2,3)}') },
          ]
          ids.shared = (
            await local.admin.create({
              title: 'Shared report',
              owner: { kind: 'local', id: 'local' },
              origin,
              files: files('Shared v1'),
            })
          ).id
          await local.admin.update({
            id: ids.shared,
            baseVersion: 1,
            change: { kind: 'edits', edits: [{ path: 'index.html', oldText: 'Shared v1', newText: 'Shared v2' }] },
          })
          await local.admin.setThumbnail(ids.shared, 2, PNG)
          await local.admin.addComment(ids.shared, { author: 'owner', version: 2, body: 'Check the totals' })
          await local.admin.setSharing(ids.shared, { visibility: 'link' })
          await local.admin.createInvite(ids.shared, { name: 'Maria' })
          ids.plain = (
            await local.admin.create({
              title: 'Plain page',
              owner: { kind: 'local', id: 'local' },
              origin,
              files: files('Plain'),
            })
          ).id
        } finally {
          await local.close()
        }
      },
      respond: () => ({ text: 'Nothing to do.' }),
    })
    const { page } = owner

    // The center reminds the owner, and leads to the move.
    await page.getByTestId('sidebar-artifacts').click()
    const center = page.getByTestId('artifacts-center')
    await expect(center.getByTestId('artifacts-legacy-banner')).toContainText('2 artifacts are still on this computer')
    await expect(center.getByTestId('artifacts-server-chip')).toContainText('Ready')
    await center.getByTestId('artifacts-legacy-banner').getByRole('button', { name: 'Move or delete' }).click()

    const notice = page.getByTestId('artifacts-legacy')
    await expect(notice).toContainText('2 artifacts are still on this computer')
    await notice.getByTestId('artifacts-legacy-move').click()
    const dialog = page.getByTestId('artifacts-move-dialog')
    await expect(dialog.getByTestId('artifacts-move-list')).toContainText('Shared report')
    await expect(dialog).toContainText('“Shared report” is shared. It becomes private')
    await dialog.getByTestId('artifacts-move-confirm').click()
    await expect(dialog.getByTestId('artifacts-move-result')).toBeVisible({ timeout: 60_000 })
    await expect(dialog).toContainText('2 artifacts moved')
    await expect(dialog).toContainText('“Shared report” became private')
    await dialog.getByRole('button', { name: 'Done' }).click()
    await expect(notice).toHaveCount(0)
    await expect.poll(() => existsSync(path.join(owner!.profile, 'artifacts')), { timeout: 15_000 }).toBe(false)

    // On the server, with the same IDs, history, comments and preview; the shared one is private now.
    const listed = (await owner.artifacts('list')) as Array<{ id: string; visibility: string; versionCount: number }>
    expect(listed.map((item) => item.id).sort()).toEqual([ids.shared, ids.plain].sort())
    expect(listed.find((item) => item.id === ids.shared)).toMatchObject({ visibility: 'private', versionCount: 2 })
    expect((await owner.artifacts('detail', ids.shared)).versions).toHaveLength(2)
    expect((await owner.artifacts('comments', ids.shared)).map((comment: { body: string }) => comment.body)).toEqual([
      'Check the totals',
    ])
    expect(await owner.artifacts('thumbnail', ids.shared, 2)).toMatchObject({ version: 2 })
    expect((await owner.artifacts('sharing', ids.shared)).people).toEqual([])
    expect(await owner.artifacts('legacyList')).toEqual([])

    // Its page opens again, from the bot server, by the same ID an old chat card holds.
    await owner.artifacts('openInConversation', owner.conversationId, ids.shared)
    expect(await renderedHeading(owner, ids.shared)).toBe('Shared v2')
  } finally {
    await owner?.close()
  }
})
