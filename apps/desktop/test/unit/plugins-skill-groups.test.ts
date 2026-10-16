import { describe, expect, it } from 'vitest'
import { groupSkillsByPlugin } from '../../src/renderer/components/plugins/plugin-skill-groups'

const skill = (name: string, plugin?: { key: string; displayName: string }) => ({ name, ...(plugin ? { plugin } : {}) })
const zeta = { key: 'zeta@m', displayName: 'Zeta' }
const alpha = { key: 'alpha@m', displayName: 'Alpha' }

describe('plugin skill sections', () => {
  it('puts own skills first, then each plugin under its name in name order, keeping the order inside', () => {
    const sections = groupSkillsByPlugin([
      skill('zeta:b', zeta),
      skill('mine'),
      skill('alpha:a', alpha),
      skill('zeta:a', zeta),
      skill('other'),
    ])
    expect(sections).toEqual([
      { plugin: null, skills: [skill('mine'), skill('other')] },
      { plugin: alpha, skills: [skill('alpha:a', alpha)] },
      { plugin: zeta, skills: [skill('zeta:b', zeta), skill('zeta:a', zeta)] },
    ])
  })

  it('leaves out empty sections', () => {
    expect(groupSkillsByPlugin([])).toEqual([])
    expect(groupSkillsByPlugin([skill('alpha:a', alpha)])).toEqual([
      { plugin: alpha, skills: [skill('alpha:a', alpha)] },
    ])
  })
})
