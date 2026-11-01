import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import {
  FLEET_GATEWAY_ROUTES,
  fleetBotSchema,
  type FleetBotOwnSkillDetail,
  type FleetBotOwnSkillFile,
  type FleetBotOwnSkillVersion,
} from '@maestrly/bot-fleet-protocol'
import { removeTempDirEventually } from './helpers/temp-cleanup'

const desktop = fileURLToPath(new URL('../..', import.meta.url))

// The owner reviews the skills a bot keeps for itself in its settings: a fixture server plays the gateway with one
// skill the bot changed (a proposal waits) and one it archived, through the protocol's schemas.

const skillMd = (body: string) =>
  `---\nname: make-animation\ndescription: Use when the owner asks for a short animation.\n---\n\n${body}\n`

/** One skill the fixture keeps, with what its routes answer. */
function animationSkill(at: number) {
  let revision = 4
  let current: FleetBotOwnSkillFile[] = [
    { path: 'SKILL.md', content: skillMd('1. Draw the frames.\n2. Run scripts/render.sh at 30 fps.') },
    { path: 'scripts/render.sh', content: '#!/bin/sh\nffmpeg -framerate 30 -i "$1/%04d.png" "$2"\n' },
  ]
  let proposal: FleetBotOwnSkillFile[] | null = [
    { path: 'SKILL.md', content: skillMd('1. Draw the frames.\n2. Run scripts/render.sh at 24 fps for GIFs.') },
    current[1],
  ]
  let lastEditedBy: 'bot' | 'owner' = 'bot'
  let locked = false
  let gone = false
  const versions: FleetBotOwnSkillVersion[] = [
    {
      id: 'v-2',
      at: at - 60_000,
      actor: 'bot',
      action: 'write-file',
      reason: 'Render step',
      paths: ['SKILL.md', 'scripts/render.sh'],
    },
    {
      id: 'v-1',
      at: at - 120_000,
      actor: 'bot',
      action: 'create',
      reason: 'Learned to animate',
      paths: ['SKILL.md'],
    },
  ]
  const firstFiles = [{ path: 'SKILL.md', content: skillMd('1. Draw the frames.') }]
  const summary = () => ({
    name: 'make-animation',
    description: 'Use when the owner asks for a short animation.',
    status: 'active' as const,
    createdBy: 'bot' as const,
    lastEditedBy,
    createdAt: at - 120_000,
    updatedAt: at - 60_000,
    revision,
    locked,
    files: current.length,
    hasScripts: current.some((file) => file.path.startsWith('scripts/')),
    uses: 3,
    lastUsedAt: at - 30_000,
    shadowed: false,
    proposal: proposal
      ? {
          actor: 'bot' as const,
          reason: 'GIFs need 24 fps',
          createdAt: at - 10_000,
          updatedAt: at - 10_000,
          baseRevision: revision,
        }
      : null,
  })
  const detail = (): FleetBotOwnSkillDetail => ({
    ...summary(),
    currentFiles: current,
    proposalFiles: proposal,
    versions,
  })
  const push = (actor: 'owner', action: 'approve' | 'write-file' | 'revert', reason = '') =>
    versions.unshift({
      id: `v-${versions.length + 1}`,
      at: Date.now(),
      actor,
      action,
      reason,
      paths: current.map((file) => file.path),
    })
  return {
    get gone() {
      return gone
    },
    summary,
    detail,
    version: (id: string) => ({ files: id === 'v-1' ? firstFiles : current }),
    act(body: { action: string; revision: number; path?: string; content?: string; versionId?: string }) {
      if (body.revision !== revision) return null
      revision += 1
      if (body.action === 'approve' && proposal) {
        current = proposal
        proposal = null
        push('owner', 'approve')
      } else if (body.action === 'write-file') {
        current = current.map((file) => (file.path === body.path ? { ...file, content: body.content! } : file))
        lastEditedBy = 'owner'
        push('owner', 'write-file')
      } else if (body.action === 'revert') {
        current = body.versionId === 'v-1' ? firstFiles : current
        lastEditedBy = 'owner'
        push('owner', 'revert')
      } else if (body.action === 'lock' || body.action === 'unlock') locked = body.action === 'lock'
      else if (body.action === 'delete') {
        gone = true
        return { skill: null }
      }
      return { skill: detail() }
    },
  }
}

async function withSkills(
  options: { feature: boolean },
  run: (fixture: { page: Page; requests: Array<{ key: string; path: string; body: unknown }> }) => Promise<void>
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maestrly-bot-own-skills-'))
  const at = Date.now()
  const iso = new Date(at).toISOString()
  const skill = animationSkill(at)
  let review: 'auto' | 'approve' = 'auto'
  const archived = {
    name: 'old-export',
    description: 'Use when exporting the old way.',
    status: 'archived' as const,
    createdBy: 'bot' as const,
    lastEditedBy: 'bot' as const,
    createdAt: at - 500_000,
    updatedAt: at - 400_000,
    revision: 2,
    locked: false,
    files: 1,
    hasScripts: false,
    uses: 0,
    lastUsedAt: null,
    absorbedInto: 'make-animation',
    shadowed: false,
    proposal: null,
  }
  const bot = fleetBotSchema.parse({
    id: 'skill-bot',
    name: 'Skill Bot',
    role: '',
    instructions: '',
    tint: '#6688aa',
    ceiling: 'auto',
    selection: null,
    talksTo: [],
    paused: false,
    lifecycle: 'running',
    setup: { step: 'ready', error: null, errorMessage: null },
    status: 'idle',
    activity: null,
    pendingCount: 0,
    accounts: { connected: false, providers: [] },
    takeover: { state: 'none', deviceId: null, deviceName: null, since: null },
    resources: { memoryBytes: null, memoryLimitBytes: null, cpuPercent: null, startedAt: iso },
    screen: { width: 1280, height: 800, display: ':1' },
    appVersion: '0.12.0',
    capabilities: options.feature ? ['bot-own-skills'] : [],
    createdAt: iso,
    updatedAt: iso,
  })
  const requests: Array<{ key: string; path: string; body: unknown }> = []
  const failures: string[] = []
  const streams = new Set<ServerResponse>()
  let app: ElectronApplication | undefined
  const server = createServer(async (request, response) => {
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const entry = Object.entries(FLEET_GATEWAY_ROUTES).find(
        ([, route]) =>
          route.method === request.method &&
          new RegExp(`^${route.path.replace(/:[^/]+/g, '[^/]+')}$`).test(url.pathname)
      )
      if (!entry) return send(404, { code: 'NOT_FOUND', message: 'Unknown fixture route' })
      const [key, route] = entry
      if (!['meta', 'pair'].includes(key) && request.headers.authorization !== 'Bearer fixture-skills-token') {
        failures.push(`Missing authentication: ${key}`)
        return send(401, { code: 'UNAUTHORIZED', message: 'Bad token' })
      }
      let body: any
      if (route.body) {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        body = route.body.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      }
      if (key.startsWith('botOwnSkill')) requests.push({ key, path: url.pathname, body })
      let value: unknown
      switch (key) {
        case 'meta':
          value = {
            protocol: 1,
            gatewayVersion: '0.12.0',
            botImage: 'fixture',
            botImageVersion: null,
            features: [],
            moreFeatures: options.feature ? ['bot-own-skills'] : [],
          }
          break
        case 'pair':
          value = { deviceId: 'fixture-device', token: 'fixture-skills-token' }
          break
        case 'events':
          response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
          streams.add(response)
          response.write(': connected\n\n')
          request.on('close', () => streams.delete(response))
          return
        case 'host':
          value = {
            hostname: 'skills-fixture',
            os: 'Linux',
            kernel: '6.8',
            arch: 'x64',
            cpus: 4,
            cpuPercent: 0,
            memory: { totalBytes: 8 * 1024 ** 3, usedBytes: 0, botsBytes: 0 },
            disk: { totalBytes: 80 * 1024 ** 3, usedBytes: 0 },
            uptimeSeconds: 60,
            gatewayVersion: '0.12.0',
            botImage: 'fixture',
            botImageVersion: null,
            dockerVersion: '28',
          }
          break
        case 'botsList':
          value = { bots: [bot] }
          break
        case 'botGet':
          value = bot
          break
        case 'inbox':
          value = { items: [] }
          break
        case 'peerMessages':
          value = { messages: [] }
          break
        case 'botSelections':
          value = { options: [], current: null }
          break
        case 'botRoutinesList':
          value = { routines: [] }
          break
        case 'botMemoriesList':
          value = { memories: [] }
          break
        case 'botTranscript':
          value = { items: [], before: null }
          break
        case 'botConversationCall':
          value = {
            result:
              body.op === 'chatSkillsState'
                ? {
                    skills: [],
                    groups: [],
                    selection: { kind: 'all' },
                    selectedGroupMissing: false,
                    hasOverrides: false,
                  }
                : body.op === 'chatCommands'
                  ? { prompts: [], project: [], skills: [] }
                  : body.op === 'chatConfig'
                    ? { mcpServers: [], appToolsEnabled: true, imageGenEnabled: true }
                    : { ok: true },
          }
          break
        case 'botOwnSkillsList':
          value = { review, skills: [...(skill.gone ? [] : [skill.summary()]), archived] }
          break
        case 'botOwnSkillsSettings':
          review = body.review
          value = { review, skills: [...(skill.gone ? [] : [skill.summary()]), archived] }
          break
        case 'botOwnSkillGet':
          value = skill.detail()
          break
        case 'botOwnSkillVersion':
          value = skill.version(url.pathname.split('/').at(-1)!)
          break
        case 'botOwnSkillAction': {
          const result = skill.act(body)
          if (!result) return send(409, { code: 'CONFLICT', message: 'The skill changed since you opened it.' })
          value = result
          break
        }
        default:
          return send(404, { code: 'NOT_FOUND', message: `Unused fixture route: ${key}` })
      }
      send(200, route.response ? route.response.parse(value) : value)
    } catch (error) {
      failures.push(String(error))
      send(500, { code: 'INTERNAL', message: 'Invalid fixture response' })
    }
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    app = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...process.env,
        AGENTS_E2E: '1',
        AGENTS_CHANNEL: 'dev',
        AGENTS_INSTANCE: 'bot-own-skills',
        AGENTS_USERDATA: path.join(root, 'profile'),
        AGENTS_LOCALE: 'en',
        ELECTRON_RENDERER_URL: '',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      },
    })
    const page = await app.firstWindow()
    await page.waitForFunction(() => Boolean(window.api))
    await page.getByRole('button', { name: 'Skip', exact: true }).click()
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing gateway address')
    await page.evaluate(
      (url) => window.api.fleetConnect({ url, code: 'ABCD-EFGH' }),
      `http://127.0.0.1:${address.port}`
    )
    await page.getByRole('tab', { name: /^Bots/ }).click()
    await page
      .getByRole('button', { name: /Skill Bot/ })
      .first()
      .click()
    await expect(page.getByRole('heading', { name: 'Skill Bot', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Bot settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Skill Bot settings' })
    await settings
      .getByRole('tablist', { name: 'Settings sections', exact: true })
      .getByRole('tab', { name: /^Skills\b/ })
      .click()
    await run({ page, requests })
    expect(failures).toEqual([])
  } finally {
    await app?.close().catch(() => {})
    for (const stream of streams) stream.end()
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
    await removeTempDirEventually(root)
  }
}

test("the owner reviews, approves, edits, restores and deletes a bot's own skill", async () => {
  await withSkills({ feature: true }, async ({ page, requests }) => {
    const section = page.getByRole('region', { name: 'Skills', exact: true })
    const open = section.getByRole('button', { name: 'Open the skill make-animation', exact: true })
    await expect(open).toBeVisible()
    await expect(open).toContainText('Proposal pending')
    await expect(open).toContainText('Has scripts')
    await expect(open).toContainText('Used 3 times')
    // The archived skill stays out of the list until asked for.
    await expect(section.getByRole('button', { name: 'Open the skill old-export', exact: true })).toHaveCount(0)
    await section.getByRole('button', { name: 'Show 1 archived', exact: true }).click()
    await expect(section.getByRole('button', { name: 'Open the skill old-export', exact: true })).toContainText(
      'Archived'
    )

    await section.getByRole('switch', { name: 'Review changes before they take effect', exact: true }).click()
    await expect
      .poll(() => requests.filter((item) => item.key === 'botOwnSkillsSettings').map((item) => item.body))
      .toEqual([{ review: 'approve' }])
    await expect(
      section.getByRole('switch', { name: 'Review changes before they take effect', exact: true })
    ).toHaveAttribute('aria-checked', 'true')

    await open.click()
    const detail = section.getByTestId('bot-own-skill-detail')
    const proposal = detail.getByRole('region', { name: 'Change waiting for you', exact: true })
    await expect(proposal).toContainText('GIFs need 24 fps')
    await expect(proposal.getByText('2. Run scripts/render.sh at 24 fps for GIFs.', { exact: true })).toBeVisible()
    await proposal.getByRole('button', { name: 'Approve', exact: true }).click()
    await expect(proposal).toHaveCount(0)
    expect(requests.find((item) => item.key === 'botOwnSkillAction')?.body).toEqual({ action: 'approve', revision: 4 })

    // A script warns before it is edited; SKILL.md is edited in place.
    await detail.getByRole('button', { name: 'scripts/render.sh', exact: true }).click()
    await expect(detail.getByRole('note')).toContainText('runs this script in its terminal')
    await detail.getByRole('button', { name: 'SKILL.md', exact: true }).click()
    const editor = detail.getByRole('textbox', { name: 'Content of SKILL.md', exact: true })
    await editor.fill(skillMd('1. Draw the frames.\n2. Run scripts/render.sh at 25 fps.'))
    await detail.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(detail.getByText('Saved. The bot uses it from its next turn.', { exact: true })).toBeVisible()
    expect(requests.filter((item) => item.key === 'botOwnSkillAction').at(-1)?.body).toEqual({
      action: 'write-file',
      revision: 5,
      path: 'SKILL.md',
      content: skillMd('1. Draw the frames.\n2. Run scripts/render.sh at 25 fps.'),
    })
    await expect(detail).toContainText('Edited by you')

    // The first version, compared and restored.
    const history = detail.getByRole('region', { name: 'History', exact: true })
    const first = history.getByRole('listitem').filter({ hasText: 'Learned to animate' })
    await first.getByRole('button', { name: 'Compare', exact: true }).click()
    await expect(first.getByText('scripts/render.sh', { exact: true })).toBeVisible()
    await first.getByRole('button', { name: 'Restore this version', exact: true }).click()
    await expect(detail.getByText(/^Restored\./)).toBeVisible()
    expect(requests.filter((item) => item.key === 'botOwnSkillAction').at(-1)?.body).toEqual({
      action: 'revert',
      revision: 6,
      versionId: 'v-1',
    })
    expect(requests.some((item) => item.key === 'botOwnSkillVersion' && item.path.endsWith('/versions/v-1'))).toBe(true)

    await detail.getByRole('button', { name: 'Delete forever', exact: true }).click()
    const confirm = page.getByRole('dialog', { name: 'Delete the skill make-animation forever?' })
    await confirm.getByRole('button', { name: 'Delete forever', exact: true }).click()
    await expect(section.getByRole('button', { name: 'Open the skill make-animation', exact: true })).toHaveCount(0)
    expect(requests.filter((item) => item.key === 'botOwnSkillAction').at(-1)?.body).toEqual({
      action: 'delete',
      revision: 7,
    })
  })
})

test('asks to update the bot server before showing the skills of a bot', async () => {
  await withSkills({ feature: false }, async ({ page, requests }) => {
    await expect(page.getByTestId('bot-own-skills-update')).toHaveText(
      'Update the bot server to see the skills this bot keeps.'
    )
    expect(requests).toEqual([])
  })
})
