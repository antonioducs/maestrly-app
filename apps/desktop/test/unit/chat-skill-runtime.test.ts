import { describe, expect, it, vi } from 'vitest'
import type { ChatSkill } from '../../src/main/chat/skills'

const h = vi.hoisted(() => ({
  effectiveSkills: vi.fn(),
  findEffectiveSkill: vi.fn(),
}))

vi.mock('../../src/main/chat/skill-state', () => ({
  effectiveSkills: h.effectiveSkills,
  findEffectiveSkill: h.findEffectiveSkill,
}))

import { buildModelSkillRuntime, renderModelSkillCatalog } from '../../src/main/chat/skill-runtime'

const skill = (overrides: Partial<ChatSkill> = {}): ChatSkill => ({
  name: 'frontend-design',
  description: 'Creates intentional, polished interfaces.',
  body: '# Frontend design\nUse expressive typography and deliberate composition.',
  source: '.agents/skills/frontend-design/SKILL.md',
  dir: '/repo/.agents/skills/frontend-design',
  scope: 'project',
  modelInvocable: true,
  userInvocable: true,
  resources: ['references/type.md'],
  ...overrides,
})

describe('model skill runtime', () => {
  it('announces only model-invocable skills and loads their full instructions on demand', async () => {
    const frontend = skill()
    h.effectiveSkills.mockResolvedValue([
      frontend,
      skill({ name: 'manual-only', description: 'Manual only.', modelInvocable: false }),
    ])
    h.findEffectiveSkill.mockResolvedValue(frontend)

    const runtime = await buildModelSkillRuntime({ cwd: '/repo', conversationId: 'conv-1' })

    expect(runtime.catalog).toContain('- frontend-design: Creates intentional, polished interfaces.')
    expect(runtime.catalog).not.toContain('manual-only')
    expect(runtime.catalog).toContain('call `use_skill` before acting')

    const loader = runtime.tools.use_skill as unknown as {
      execute: (input: { name: string }, options: { toolCallId: string }) => Promise<string>
    }
    const loaded = await loader.execute({ name: 'frontend-design' }, { toolCallId: 'skill-1' })
    expect(loaded).toContain('Skill "frontend-design" loaded.')
    expect(loaded).toContain('Skill directory (any relative path below resolves from here)')
    expect(loaded).toContain('references/type.md')
    expect(loaded).toContain('Use expressive typography')
    expect(h.findEffectiveSkill).toHaveBeenCalledWith('/repo', 'conv-1', 'frontend-design')

    h.findEffectiveSkill.mockClear()
    h.findEffectiveSkill.mockResolvedValue(skill({ name: 'newly-enabled' }))
    await expect(loader.execute({ name: 'newly-enabled' }, { toolCallId: 'skill-unlisted' })).resolves.toContain(
      'not found'
    )
    expect(h.findEffectiveSkill).not.toHaveBeenCalled()
  })

  it('revalidates effective state on every load and exposes no loader for an empty catalog', async () => {
    h.effectiveSkills.mockResolvedValueOnce([skill()]).mockResolvedValueOnce([])
    h.findEffectiveSkill.mockResolvedValue(null)

    const active = await buildModelSkillRuntime({ cwd: '/repo', conversationId: 'conv-1' })
    const loader = active.tools.use_skill as unknown as {
      execute: (input: { name: string }, options: { toolCallId: string }) => Promise<string>
    }
    await expect(loader.execute({ name: 'frontend-design' }, { toolCallId: 'skill-2' })).resolves.toContain('not found')

    const empty = await buildModelSkillRuntime({ cwd: '/repo', conversationId: 'conv-1' })
    expect(empty.catalog).toBe('')
    expect(empty.tools).toEqual({})
  })

  it('renders an empty overlay when no skills are available', () => {
    expect(renderModelSkillCatalog([])).toBe('')
  })
})
