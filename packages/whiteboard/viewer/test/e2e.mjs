#!/usr/bin/env node
// End to end: a real artifact host serves this viewer for a whiteboard, the owner and a guest open it in Chromium
// through the shell and its sandboxed frame, and the agent edits it through the admin while they do.
// Build first: `npm run build:artifact-host` and `npm run build:whiteboard-viewer`. Exits with 1 at the first failure.
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { openArtifactHost } from '../../../artifact-host/dist/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const viewerDir = path.resolve(here, '../../build/viewer')

const problems = []
const cdn = []
let failed = false

function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${name}${detail ? `: ${detail}` : ''}`)
  if (!ok) failed = true
  return ok
}

async function until(read, accept, timeoutMs) {
  const started = Date.now()
  let value = await read()
  while (!accept(value) && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    value = await read()
  }
  return value
}

function watch(page) {
  page.on('pageerror', (error) => problems.push(error.message))
  page.on('request', (request) => {
    if (request.url().includes('esm.sh')) cdn.push(request.url())
  })
  page.on('console', (message) => {
    if (message.text().includes('esm.sh')) cdn.push(message.text())
  })
}

async function canvasOf(page) {
  const started = Date.now()
  let frame
  while (!(frame = page.frames().find((candidate) => candidate.url().includes('/c/')))) {
    if (Date.now() - started > 20_000) throw new Error('the content frame never loaded')
    await page.waitForTimeout(100)
  }
  await frame.waitForFunction(() => window.__whiteboard?.ready(), null, { timeout: 30_000 })
  return frame
}

/** Drags an element of the canvas by `dx`, as a person does with the mouse. */
async function drag(page, frame, id, dx) {
  const box = await page.locator('iframe.content').boundingBox()
  const center = await frame.evaluate((target) => window.__whiteboard.viewportCenter(target), id)
  const x = box.x + center.x
  const y = box.y + center.y
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let step = 1; step <= 15; step++) {
    await page.mouse.move(x + (dx * step) / 15, y)
    await page.waitForTimeout(20)
  }
  await page.mouse.up()
}

const xOf = (frame, id) =>
  frame.evaluate((target) => window.__whiteboard.elements().find((element) => element.id === target)?.x, id)

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'whiteboard-e2e-'))
const host = await openArtifactHost({ dataDir, port: 0, quotaBytes: 256 * 1024 * 1024, whiteboardViewerDir: viewerDir })
const origin = `http://127.0.0.1:${host.port}`
const browser = await chromium.launch()
try {
  const created = await host.admin.createBoard({
    title: 'End to end',
    owner: { kind: 'local', id: 'local' },
    origin: { workspaceId: null, conversationId: 'e2e', conversationTitle: null },
    ops: [
      { op: 'section', id: 'plan', title: 'Plan' },
      { op: 'card', id: 'a', text: 'Alpha', in: 'plan' },
      { op: 'card', id: 'b', text: 'Beta', in: 'plan' },
      { op: 'card', id: 'c', text: 'Gamma', in: 'plan' },
    ],
  })
  const id = created.detail.id
  const opened = created.revision

  // 1. The owner opens the board the agent drew.
  const owner = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  watch(owner)
  const { ticket } = await host.admin.mintOwnerTicket(id)
  await owner.goto(`${origin}/a/${id}#o=${ticket}`)
  const ownerCanvas = await canvasOf(owner)
  const shown = await ownerCanvas.evaluate(() => {
    const elements = window.__whiteboard.elements()
    return {
      cards: elements
        .filter((element) => element.type === 'rectangle')
        .map((element) => element.id)
        .sort(),
      texts: elements
        .filter((element) => element.type === 'text')
        .map((element) => element.text)
        .sort(),
      canEdit: window.__whiteboard.canEdit(),
    }
  })
  check('the owner sees the three cards with their text', shown.cards.join() === 'a,b,c', JSON.stringify(shown))
  check(
    'the cards carry their text',
    ['Alpha', 'Beta', 'Gamma'].every((text) => shown.texts.includes(text))
  )
  check('the owner may draw', shown.canEdit)
  await owner.waitForTimeout(1500)
  const untouched = await host.admin.readBoard(id)
  check('opening the board sends nothing back', untouched.revision === opened, `revision ${untouched.revision}`)

  // 2. The owner drags a card; the host has it as the person's change.
  const before = await xOf(ownerCanvas, 'a')
  await drag(owner, ownerCanvas, 'a', 240)
  // The canvas is zoomed to fit, so the card moved by the drag in screen pixels over the zoom: compare with the canvas.
  const dropped = await xOf(ownerCanvas, 'a')
  check('the card moved', dropped > before + 50, `${before} -> ${dropped}`)
  const dragged = await until(
    async () => (await host.admin.readBoard(id, { since: opened })).outline.cards.find((card) => card.id === 'a'),
    (card) => card?.by === 'person' && Math.abs(card.box[0] - dropped) <= 1,
    2000
  )
  check('a dragged card reaches the host as the person’s', dragged?.by === 'person', JSON.stringify(dragged))
  check(
    'the host has where it was dropped',
    dragged && Math.abs(dragged.box[0] - dropped) <= 1,
    `${dragged?.box[0]} vs ${dropped}`
  )
  const afterDrag = (await host.admin.readBoard(id)).revision

  // 3. The agent moves another card; the open canvas follows.
  const moved = await host.admin.applyBoard({
    id,
    baseRevision: afterDrag,
    ops: [{ op: 'move', id: 'b', to: { x: 2000, y: 0 } }],
  })
  const target = (await host.admin.readBoard(id)).outline.cards.find((card) => card.id === 'b').box[0]
  const followed = await until(
    () => xOf(ownerCanvas, 'b'),
    (x) => Math.round(x) === target,
    3000
  )
  check('the canvas shows the agent’s move', Math.round(followed) === target, `${followed} vs ${target}`)
  check('the agent’s move applied', moved.applied.length === 1)

  // 4. The agent edits from before the drag: the person's move stays.
  const late = await host.admin.applyBoard({
    id,
    baseRevision: opened,
    ops: [{ op: 'move', id: 'a', to: { x: 0, y: 0 } }],
  })
  check(
    'an agent edit from before the drag is a conflict',
    late.conflicts[0]?.reason === 'changed',
    JSON.stringify(late.conflicts)
  )

  // 5. A guest opens the link: they see the board and cannot change it.
  await host.admin.setSharing(id, { visibility: 'link' })
  const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const guest = await guestContext.newPage()
  watch(guest)
  await guest.goto(`${origin}/a/${id}`)
  const entered = await guest.evaluate(async (artifact) => {
    const response = await fetch(`/a/${artifact}/api/session/code`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-maestrly-artifact': '1' },
      body: '{}',
    })
    return response.status
  }, id)
  check('a guest enters through the link', entered === 204, String(entered))
  await guest.reload()
  const guestCanvas = await canvasOf(guest)
  check('the guest’s canvas is read-only', (await guestCanvas.evaluate(() => window.__whiteboard.canEdit())) === false)
  const refused = await guest.evaluate(async (artifact) => {
    const response = await fetch(`/a/${artifact}/api/board/elements`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-maestrly-artifact': '1' },
      body: JSON.stringify({ elements: [] }),
    })
    return response.status
  }, id)
  check('the host refuses a guest’s change', refused === 403, String(refused))

  // 6. Once the owner lets the people it is shared with edit, the guest's drag reaches the owner's canvas.
  await host.admin.setSharing(id, { boardEditors: 'people' })
  await guest.reload()
  const editable = await canvasOf(guest)
  check('the guest may draw now', await editable.evaluate(() => window.__whiteboard.canEdit()))
  const startX = await xOf(ownerCanvas, 'c')
  await drag(guest, editable, 'c', 200)
  const droppedX = await until(
    () => xOf(editable, 'c'),
    (x) => x > startX + 50,
    2000
  )
  const seen = await until(
    () => xOf(ownerCanvas, 'c'),
    (x) => Math.abs(x - droppedX) <= 1,
    3000
  )
  check(
    'the guest’s drag reaches the owner’s canvas',
    Math.abs(seen - droppedX) <= 1 && droppedX > startX + 50,
    `${startX} -> ${droppedX}, owner sees ${seen}`
  )
  const guestCard = (await host.admin.readBoard(id)).outline.cards.find((card) => card.id === 'c')
  check('the host has the guest’s drag as a person’s', guestCard?.by === 'person', JSON.stringify(guestCard))

  // 7. Through all of it, nothing broke and nothing came from a CDN.
  check('no page errors', problems.length === 0, problems.slice(0, 3).join(' | '))
  check('no CDN requests', cdn.length === 0, `${cdn.length} attempted`)
} catch (error) {
  check('the run completed', false, error instanceof Error ? error.stack : String(error))
} finally {
  await browser.close()
  await host.close()
  rmSync(dataDir, { recursive: true, force: true })
}
process.exitCode = failed ? 1 : 0
