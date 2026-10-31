import { describe, expect, it } from 'vitest'
import {
  FLEET_BOT_OWN_SKILLS_FEATURE,
  FLEET_GATEWAY_ROUTES,
  FLEET_INSTANCE_ROUTES,
  fleetBotOwnSkillActionSchema,
  fleetBotOwnSkillDetailSchema,
  fleetBotOwnSkillPathSchema,
  fleetBotOwnSkillsSettingsSchema,
} from '../src/index.js'

const summary = {
  name: 'make-animation',
  description: 'Use when animating.',
  status: 'active',
  createdBy: 'bot',
  lastEditedBy: 'owner',
  createdAt: 1,
  updatedAt: 2,
  revision: 3,
  locked: false,
  files: 2,
  hasScripts: true,
  uses: 4,
  lastUsedAt: 5,
  shadowed: false,
  proposal: null,
}

describe('bot own skills contract', () => {
  it('names the feature', () => {
    expect(FLEET_BOT_OWN_SKILLS_FEATURE).toBe('bot-own-skills')
  })

  it('pairs the gateway and instance routes', () => {
    const pairs = [
      ['botOwnSkillsList', 'GET', ''],
      ['botOwnSkillsSettings', 'PATCH', ''],
      ['botOwnSkillGet', 'GET', '/:name'],
      ['botOwnSkillVersion', 'GET', '/:name/versions/:versionId'],
      ['botOwnSkillAction', 'POST', '/:name'],
    ] as const
    for (const [key, method, rest] of pairs) {
      expect(FLEET_GATEWAY_ROUTES[key]).toMatchObject({ method, path: `/v1/bots/:id/own-skills${rest}` })
      expect(FLEET_INSTANCE_ROUTES[key]).toMatchObject({ method, path: `/v1/bots/:botId/own-skills${rest}` })
    }
  })

  it('accepts only plain paths inside a skill', () => {
    for (const path of ['SKILL.md', 'scripts/render.sh', 'templates/a/b.svg', 'assets/x_1.png'])
      expect(fleetBotOwnSkillPathSchema.safeParse(path).success, path).toBe(true)
    for (const path of ['../x', 'scripts/../x', 'notes/a.md', 'scripts/.env', '/etc/passwd', 'scripts', 'skill.md'])
      expect(fleetBotOwnSkillPathSchema.safeParse(path).success, path).toBe(false)
  })

  it('requires the revision the owner saw for every change, and nothing else', () => {
    expect(fleetBotOwnSkillActionSchema.safeParse({ action: 'archive', revision: 3 }).success).toBe(true)
    expect(fleetBotOwnSkillActionSchema.safeParse({ action: 'archive' }).success).toBe(false)
    expect(fleetBotOwnSkillActionSchema.safeParse({ action: 'archive', revision: 3, extra: 1 }).success).toBe(false)
    expect(
      fleetBotOwnSkillActionSchema.safeParse({ action: 'write-file', revision: 3, path: 'scripts/a.sh', content: 'x' })
        .success
    ).toBe(true)
    expect(
      fleetBotOwnSkillActionSchema.safeParse({ action: 'write-file', revision: 3, path: 'scripts/a.sh' }).success
    ).toBe(false)
    expect(fleetBotOwnSkillActionSchema.safeParse({ action: 'revert', revision: 3, versionId: 'v' }).success).toBe(true)
    expect(fleetBotOwnSkillActionSchema.safeParse({ action: 'erase', revision: 3 }).success).toBe(false)
    expect(fleetBotOwnSkillsSettingsSchema.safeParse({ review: 'approve' }).success).toBe(true)
    expect(fleetBotOwnSkillsSettingsSchema.safeParse({ review: 'never' }).success).toBe(false)
  })

  it('describes a skill with its files, proposal and history', () => {
    const detail = {
      ...summary,
      currentFiles: [{ path: 'SKILL.md', content: '---\nname: make-animation\n---\nDo it.' }],
      proposalFiles: null,
      versions: [{ id: 'v1', at: 1, actor: 'bot', action: 'create', reason: 'Learned', paths: ['SKILL.md'] }],
    }
    expect(fleetBotOwnSkillDetailSchema.parse(detail)).toEqual(detail)
    expect(fleetBotOwnSkillDetailSchema.safeParse({ ...detail, name: 'Bad Name' }).success).toBe(false)
    expect(fleetBotOwnSkillDetailSchema.safeParse({ ...detail, secret: 1 }).success).toBe(false)
  })
})
