export interface PluginSkillSection<T> {
  /** Null for the person's own skills (and a bot's); otherwise the plugin that provides `skills`. */
  plugin: { key: string; displayName: string } | null
  skills: T[]
}

/**
 * Skill lists show the person's own skills first, then each plugin's skills under the plugin's name, plugins in name
 * order. Order inside a section is kept. Sections without skills are left out.
 */
export function groupSkillsByPlugin<T extends { plugin?: { key: string; displayName: string } }>(
  skills: readonly T[]
): PluginSkillSection<T>[] {
  const own: T[] = []
  const byPlugin = new Map<string, PluginSkillSection<T>>()
  for (const skill of skills) {
    if (!skill.plugin) {
      own.push(skill)
      continue
    }
    let section = byPlugin.get(skill.plugin.key)
    if (!section) {
      section = { plugin: { key: skill.plugin.key, displayName: skill.plugin.displayName }, skills: [] }
      byPlugin.set(skill.plugin.key, section)
    }
    section.skills.push(skill)
  }
  const plugins = [...byPlugin.values()].sort(
    (a, b) =>
      (a.plugin?.displayName ?? '').localeCompare(b.plugin?.displayName ?? '') ||
      (a.plugin?.key ?? '').localeCompare(b.plugin?.key ?? '')
  )
  return [...(own.length ? [{ plugin: null, skills: own }] : []), ...plugins]
}
