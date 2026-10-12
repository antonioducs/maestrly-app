import { describe, expect, it } from 'vitest'
import { fsPackageTree } from '../../src/main/plugins/package-tree'
import { scanCommands, scanSkills } from '../../src/main/plugins/skills-scan'
import { writeTree } from '../helpers/plugin-fixtures'

describe('plugin package tree', () => {
  it('lists files, executables and symlinks without following links', async () => {
    const root = await writeTree({
      'a.txt': 'hello',
      'bin/tool': { content: '#!/bin/sh\n', mode: 0o755 },
      link: { symlink: '/etc/hosts' },
      '.git/config': 'ignored',
    })
    const tree = await fsPackageTree(root)
    expect(tree.entries.get('a.txt')).toEqual({ path: 'a.txt', mode: 'file' })
    expect(tree.entries.get('bin/tool')).toEqual({ path: 'bin/tool', mode: 'executable' })
    expect(tree.entries.get('link')).toEqual({ path: 'link', mode: 'symlink' })
    expect(tree.entries.has('.git/config')).toBe(false)
    expect((await tree.read('a.txt', 100))?.toString()).toBe('hello')
    expect(await tree.read('a.txt', 2)).toBeNull()
    expect(await tree.read('link', 1000)).toBeNull()
    expect(await tree.read('missing', 1000)).toBeNull()
    const sub = tree.sub('bin')
    expect([...sub.entries.keys()]).toEqual(['tool'])
    expect((await sub.read('tool', 100))?.toString()).toBe('#!/bin/sh\n')
  })
})

describe('plugin skill discovery', () => {
  it('finds immediate skill folders only and validates Agent Skills strictly', async () => {
    const root = await writeTree({
      'skills/summarize/SKILL.md': '---\nname: summarize\ndescription: Summarize text\n---\nDo it.',
      'skills/summarize/scripts/run.sh': { content: '#!/bin/sh\n', mode: 0o755 },
      'skills/Bad_Name/SKILL.md': '---\nname: Bad_Name\ndescription: x\n---\nx',
      'skills/mismatch/SKILL.md': '---\nname: other\ndescription: x\n---\nx',
      'skills/nested/deeper/SKILL.md': '---\nname: deeper\ndescription: x\n---\nx',
    })
    const { skills, issues } = await scanSkills(await fsPackageTree(root), ['skills'], { strictAgentSkills: true })
    expect(skills).toEqual([
      {
        name: 'summarize',
        dirPath: 'skills/summarize',
        description: 'Summarize text',
        kind: 'skill',
        hasScripts: true,
      },
    ])
    expect(issues.map((i) => i.path).sort()).toEqual(['skills/Bad_Name/SKILL.md', 'skills/mismatch/SKILL.md'])
  })

  it('is lenient for Codex/Claude and falls back to the folder name', async () => {
    const root = await writeTree({ 'skills/deploy/SKILL.md': '---\ndescription: Ship it\n---\nSteps.' })
    const { skills } = await scanSkills(await fsPackageTree(root), ['skills'], { strictAgentSkills: false })
    expect(skills.map((s) => s.name)).toEqual(['deploy'])
  })

  it('keeps a lenient skill without a description and reports it', async () => {
    const root = await writeTree({ 'skills/plain/SKILL.md': 'Just steps.' })
    const { skills, issues } = await scanSkills(await fsPackageTree(root), ['skills'], { strictAgentSkills: false })
    expect(skills.map((s) => s.name)).toEqual(['plain'])
    expect(issues).toEqual([expect.objectContaining({ code: 'skill-invalid', path: 'skills/plain/SKILL.md' })])
  })

  it('treats a root holding SKILL.md as one skill', async () => {
    const root = await writeTree({ 'SKILL.md': '---\nname: single\ndescription: One\n---\nBody' })
    const { skills } = await scanSkills(await fsPackageTree(root), [''], { strictAgentSkills: false, rootName: 'pkg' })
    expect(skills).toEqual([{ name: 'single', dirPath: '', description: 'One', kind: 'skill', hasScripts: false }])
  })

  it('skips a symlinked SKILL.md', async () => {
    const root = await writeTree({ 'skills/x/SKILL.md': { symlink: '/etc/hosts' } })
    const { skills, issues } = await scanSkills(await fsPackageTree(root), ['skills'], { strictAgentSkills: false })
    expect(skills).toEqual([])
    expect(issues[0]).toMatchObject({ code: 'skill-invalid', path: 'skills/x/SKILL.md' })
  })

  it('turns commands with a description into command skills', async () => {
    const root = await writeTree({
      'commands/review.md': '---\ndescription: Review the diff\nargument-hint: [file]\n---\nReview $ARGUMENTS',
      'commands/nodesc.md': 'No frontmatter',
    })
    const { skills, issues } = await scanCommands(await fsPackageTree(root), ['commands'])
    expect(skills).toEqual([
      {
        name: 'review',
        dirPath: 'commands/review.md',
        description: 'Review the diff',
        kind: 'command',
        hasScripts: false,
      },
    ])
    expect(issues).toEqual([expect.objectContaining({ code: 'command-invalid', path: 'commands/nodesc.md' })])
  })
})
