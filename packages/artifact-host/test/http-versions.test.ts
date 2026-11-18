import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { utf8 } from './helpers.js'
import { type Browser, type Harness, startHarness } from './http-harness.js'

let h: Harness
let id: string
let api: string
let owner: Browser
let maria: Browser

const REPLACED = { status: 409, json: { error: 'version_replaced' } }
const numbers = (versions: { number: number }[]) => versions.map((version) => version.number)

async function join(name = 'Maria'): Promise<Browser> {
  const { token } = await h.admin.createInvite(id, { name })
  const browser = h.browser()
  expect((await browser.send('POST', `${api}/session/invite`, { token })).status).toBe(204)
  return browser
}

async function addVersion(label: string, baseVersion: number): Promise<void> {
  await h.admin.update({
    id,
    baseVersion,
    summary: `Summary ${label}`,
    change: { kind: 'replace', files: [{ path: 'index.html', bytes: utf8(`<p>${label}</p>`) }] },
  })
}

beforeEach(async () => {
  h = await startHarness()
  id = h.id
  api = `/a/${id}/api`
  await addVersion('v2', 1)
  await addVersion('v3', 2)
  await h.admin.setSharing(id, { visibility: 'link' })
  owner = await h.owner()
  maria = await join('Maria')
})
afterEach(() => h.close())

describe('version visibility', () => {
  it('hides earlier versions from shared viewers by default while the owner sees all of them', async () => {
    const visitorState = await maria.get(`${api}/state`)
    expect(visitorState.status).toBe(200)
    expect(visitorState.json.artifact.currentVersion).toBe(3)
    expect(visitorState.json.artifact.versions).toHaveLength(1)
    expect(visitorState.json.artifact.versions[0]).toMatchObject({ number: 3, summary: 'Summary v3' })
    expect(visitorState.json.can.history).toBe(false)

    const ownerState = await owner.get(`${api}/state`)
    expect(ownerState.status).toBe(200)
    expect(numbers(ownerState.json.artifact.versions)).toEqual([3, 2, 1])
    expect(ownerState.json.can.history).toBe(true)
  })

  it('refuses frame requests for earlier versions to shared viewers when versionsVisible is off', async () => {
    expect(await maria.send('POST', `${api}/frame`, { version: 1 })).toMatchObject(REPLACED)
    expect(await maria.send('POST', `${api}/frame`, { version: 2 })).toMatchObject(REPLACED)
    expect((await maria.send('POST', `${api}/frame`, { version: 99 })).status).toBe(404)
    expect((await maria.send('POST', `${api}/frame`, { version: 0 })).status).toBe(400)

    const currentFrame = await maria.send('POST', `${api}/frame`, { version: 3 })
    expect(currentFrame.status).toBe(200)
    expect((await maria.raw('GET', currentFrame.json.url)).body).toContain('<p>v3</p>')

    const ownerOldFrame = await owner.send('POST', `${api}/frame`, { version: 1 })
    expect(ownerOldFrame.status).toBe(200)
    expect((await owner.raw('GET', ownerOldFrame.json.url)).body).toContain('The quick brown fox')
  })

  it('stops serving an earlier-version capability immediately when versionsVisible is turned off', async () => {
    await h.admin.setSharing(id, { versionsVisible: true })

    const shown = (await maria.get(`${api}/state`)).json
    expect(shown.can.history).toBe(true)
    expect(numbers(shown.artifact.versions)).toEqual([3, 2, 1])
    const oldFrame = await maria.send('POST', `${api}/frame`, { version: 2 })
    expect(oldFrame.status).toBe(200)
    expect((await maria.raw('GET', oldFrame.json.url)).body).toContain('<p>v2</p>')

    await h.admin.setSharing(id, { versionsVisible: false })
    expect((await maria.raw('GET', oldFrame.json.url)).status).toBe(404)
    expect(numbers((await maria.get(`${api}/state`)).json.artifact.versions)).toEqual([3])

    // A capability minted for the current version also stops serving once a new version is published.
    const v3Frame = await maria.send('POST', `${api}/frame`, { version: 3 })
    expect(v3Frame.status).toBe(200)
    expect((await maria.raw('GET', v3Frame.json.url)).status).toBe(200)
    await addVersion('v4', 3)
    expect((await maria.raw('GET', v3Frame.json.url)).status).toBe(404)
    // The viewer still on version 3 asks for it again and learns a newer one replaced it.
    expect(await maria.send('POST', `${api}/frame`, { version: 3 })).toMatchObject(REPLACED)
    const v4Frame = await maria.send('POST', `${api}/frame`, { version: 4 })
    expect(v4Frame.status).toBe(200)
    expect((await maria.raw('GET', v4Frame.json.url)).body).toContain('<p>v4</p>')
  })
})
