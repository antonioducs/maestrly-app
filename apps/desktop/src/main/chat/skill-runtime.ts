import { jsonSchema, tool, type ToolSet } from 'ai'
import { effectiveSkills, findEffectiveSkill } from './skill-state'
import { normalizedSkillName, renderSkillContext, skillCatalogLine, type ChatSkill } from './skills'

export interface ModelSkillRuntime {
  skills: ChatSkill[]
  catalog: string
  tools: ToolSet
}

export function renderModelSkillCatalog(skills: readonly ChatSkill[]): string {
  if (!skills.length) return ''
  return [
    '# Available project skills',
    'These specialized capabilities are available through `use_skill`.',
    'When the task clearly matches a listed skill, call `use_skill` before acting, read the returned instructions completely, and follow them for this task. Use only the minimal relevant set. User instructions take precedence.',
    ...skills.map(skillCatalogLine),
  ].join('\n')
}

/**
 * Provider-neutral progressive-disclosure runtime for model-invocable skills. The catalog is intentionally
 * lightweight; every load revalidates the effective conversation state before returning the full SKILL.md.
 */
export async function buildModelSkillRuntime(args: {
  cwd: string
  conversationId?: string
}): Promise<ModelSkillRuntime> {
  const skills = (await effectiveSkills(args.cwd, args.conversationId)).filter((skill) => skill.modelInvocable)
  const catalogNames = new Set(skills.map((skill) => skill.name))
  const unavailable = (name: string): string =>
    `Skill "${name}" not found. Available: ${skills.map((item) => item.name).join(', ') || '(none)'}`
  const tools: ToolSet = skills.length
    ? {
        use_skill: tool({
          description:
            'Loads the full instructions of an enabled project skill. Call this before performing a task ' +
            'covered by a skill listed in the system prompt, then follow the returned instructions.',
          inputSchema: jsonSchema<{ name: string }>({
            type: 'object',
            properties: { name: { type: 'string', description: 'Skill name listed in the system prompt.' } },
            required: ['name'],
            additionalProperties: false,
          }),
          execute: async ({ name }) => {
            if (!catalogNames.has(normalizedSkillName(name))) return unavailable(name)
            const skill = await findEffectiveSkill(args.cwd, args.conversationId, name)
            return skill?.modelInvocable ? renderSkillContext(skill) : unavailable(name)
          },
        }),
      }
    : {}
  return { skills, catalog: renderModelSkillCatalog(skills), tools }
}
