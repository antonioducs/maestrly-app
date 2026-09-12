import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  applySkillArguments,
  createSkill,
  countSkillResources,
  listSkills,
  parseSkillInvocation,
  readSkillBody,
  removeSkillDir,
  renderSkillContext,
  writeSkillFromPrompt,
} from '../../src/main/chat/skills'

/** Skills are DIRECTORIES with SKILL.md (frontmatter and body) plus packaged scripts, references, and assets. */
let dir = ''
const mkSkill = (root: string, folder: string, content: string) => {
  mkdirSync(path.join(dir, root, folder), { recursive: true })
  writeFileSync(path.join(dir, root, folder, 'SKILL.md'), content)
}
const mkResource = (root: string, folder: string, rel: string, content = 'x') => {
  const file = path.join(dir, root, folder, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'chat-skills-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))
// Matching home and cwd isolates fixtures from real user skills.

describe('listSkills', () => {
  it('reads frontmatter skills from supported roots', async () => {
    mkSkill(
      '.agents/skills',
      'review',
      '---\nname: Review PR\ndescription: review checklist\n---\nRead the diff and verify X, Y, Z.'
    )
    mkSkill('.claude/skills', 'deploy', '---\ndescription: how to deploy\n---\nRun npm run deploy.')
    mkSkill('.codex/skills', 'investigator', '---\ndescription: controlled discovery\n---\nMap the system.')

    const skills = await listSkills(dir, dir)
    const byName = Object.fromEntries(skills.map((s) => [s.name, s]))
    expect(byName['review-pr']).toMatchObject({
      description: 'review checklist',
      body: 'Read the diff and verify X, Y, Z.',
      source: '.agents/skills/review/SKILL.md',
      dir: path.join(dir, '.agents/skills/review'),
      scope: 'project',
      modelInvocable: true,
      userInvocable: true,
    })
    // Missing frontmatter name uses the directory name.
    expect(byName.deploy).toMatchObject({ description: 'how to deploy', body: 'Run npm run deploy.' })
    expect(byName.investigator).toMatchObject({
      description: 'controlled discovery',
      body: 'Map the system.',
      source: '.codex/skills/investigator/SKILL.md',
    })
  })

  it('deduplicates skills by root precedence and skips missing or empty bodies', async () => {
    mkSkill('.agents/skills', 'x', 'from agents')
    mkSkill('.claude/skills', 'x', 'from claude')
    mkSkill('.codex/skills', 'x', 'from codex')
    mkSkill('.claude/skills', 'y', 'from claude')
    mkSkill('.codex/skills', 'y', 'from codex')
    mkSkill('.agents/skills', 'empty', '---\ndescription: nothing\n---\n   ')
    mkdirSync(path.join(dir, '.agents', 'skills', 'without-md'), { recursive: true })

    const skills = await listSkills(dir, dir)
    expect(skills.filter((s) => s.name === 'x')).toHaveLength(1)
    expect(skills.find((s) => s.name === 'x')?.body).toBe('from agents')
    expect(skills.find((s) => s.name === 'y')?.body).toBe('from claude')
    expect(skills.find((s) => s.name === 'empty')).toBeUndefined()
    expect(skills.find((s) => s.name === 'without-md')).toBeUndefined()
  })

  it('reads skill bodies by normalized names', async () => {
    mkSkill('.agents/skills', 'tests', '---\nname: Run Tests\n---\nnpm test')
    expect(await readSkillBody(dir, 'Run Tests', dir)).toBe('npm test')
    expect(await readSkillBody(dir, 'run-tests', dir)).toBe('npm test')
    expect(await readSkillBody(dir, 'missing', dir)).toBeNull()
  })

  it('returns no skills without skill directories', async () => {
    expect(await listSkills(dir, dir)).toEqual([])
  })

  it('parses extended frontmatter while ignoring nested blocks', async () => {
    mkSkill(
      '.agents/skills',
      'deploy',
      '---\nname: deploy\ndescription: deploys to production\nargument-hint: "[env]"\ndisable-model-invocation: true\nuser-invocable: true\nlicense: MIT\nmetadata:\n  author: someone\n---\nDeploy the environment $ARGUMENTS.'
    )
    const skill = (await listSkills(dir, dir))[0]
    expect(skill).toMatchObject({
      argumentHint: '[env]',
      license: 'MIT',
      modelInvocable: false,
      userInvocable: true,
    })
  })

  it('inventories packaged resources relative to skill roots', async () => {
    mkSkill('.agents/skills', 'pack', '---\nname: pack\n---\nbody')
    mkResource('.agents/skills', 'pack', 'scripts/run.sh')
    mkResource('.agents/skills', 'pack', 'references/api.md')
    mkResource('.agents/skills', 'pack', 'references/nested/deep.md')
    mkResource('.agents/skills', 'pack', 'assets/template.txt')
    mkResource('.agents/skills', 'pack', 'other/ignored.txt')

    const skill = (await listSkills(dir, dir))[0]
    expect(skill.resources).toEqual([
      'scripts/run.sh',
      'references/api.md',
      'references/nested/deep.md',
      'assets/template.txt',
    ])
    expect(countSkillResources(skill.resources)).toEqual({ scripts: 1, references: 2, assets: 1 })
  })

  it('folds or preserves block-scalar newlines correctly', async () => {
    mkSkill('.agents/skills', 'folded', '---\nname: folded\ndescription: >\n  first line\n  second line\n---\nbody')
    mkSkill('.agents/skills', 'literal', '---\nname: literal\ndescription: |\n  line one\n  line two\n---\nbody')
    const byName = Object.fromEntries((await listSkills(dir, dir)).map((s) => [s.name, s]))
    expect(byName.folded.description).toBe('first line second line')
    expect(byName.literal.description).toBe('line one\nline two')
  })

  it('reads only bounded prefixes of oversized skill files', async () => {
    const huge = '---\nname: huge\ndescription: heavy\n---\n' + 'x'.repeat(300 * 1024) // > 256 KB
    mkSkill('.agents/skills', 'huge', huge)
    const skill = (await listSkills(dir, dir))[0]
    expect(skill.truncated).toBe(true)
    expect(skill.body.length).toBeLessThan(70_000) // The character cap still applies.
    expect(skill.body.endsWith('… (truncated)')).toBe(true)
  })

  it('lists global roots without a project cwd', async () => {
    mkSkill('.agents/skills', 'global-only', '---\nname: global-only\n---\nbody')
    const skills = await listSkills('', dir)
    expect(skills.map((s) => s.name)).toEqual(['global-only'])
    expect(skills[0].scope).toBe('global')
  })
})

describe('user skill invocation', () => {
  it('parseSkillInvocation recognizes a slash name and arguments, including multiline arguments', () => {
    expect(parseSkillInvocation('/deploy')).toEqual({ name: 'deploy', args: '' })
    expect(parseSkillInvocation('/deploy prod now')).toEqual({ name: 'deploy', args: 'prod now' })
    expect(parseSkillInvocation('/deploy\nmapeie o fluxo')).toEqual({ name: 'deploy', args: 'mapeie o fluxo' })
    expect(parseSkillInvocation('ordinary message')).toBeNull()
    expect(parseSkillInvocation('text with /deploy in the middle')).toBeNull()
  })

  it('applySkillArguments replaces $ARGUMENTS and positional $1 through $9', () => {
    expect(applySkillArguments('deploy to $ARGUMENTS', 'prod')).toEqual({ text: 'deploy to prod', consumed: true })
    expect(applySkillArguments('from $1 to $2', 'dev prod')).toEqual({ text: 'from dev to prod', consumed: true })
    // A positional argument without a value stays literal and does NOT count as consumed.
    expect(applySkillArguments('without placeholder', 'prod')).toEqual({ text: 'without placeholder', consumed: false })
    expect(applySkillArguments('only $2', 'dev')).toEqual({ text: 'only $2', consumed: false })
  })

  it('renders absolute roots, resource inventories and unused arguments', async () => {
    mkSkill('.agents/skills', 'pack', '---\nname: pack\ndescription: does things\n---\nRun the checklist.')
    mkResource('.agents/skills', 'pack', 'scripts/run.sh')
    const skill = (await listSkills(dir, dir))[0]

    const block = renderSkillContext(skill, { args: 'prod', invokedBy: 'user' })
    expect(block).toContain('The user invoked the skill "pack"')
    expect(block).toContain(path.join(dir, '.agents/skills/pack'))
    expect(block).toContain('scripts/run.sh')
    expect(block).toContain('User arguments: prod')
    expect(block).toContain('Run the checklist.')

    // Arguments consumed by placeholders are not repeated in footers.
    const consumed = renderSkillContext({ ...skill, body: 'Suba $ARGUMENTS' }, { args: 'prod', invokedBy: 'user' })
    expect(consumed).toContain('Suba prod')
    expect(consumed).not.toContain('User arguments:')
  })
})

describe('skill creation, removal and conversion', () => {
  it('creates skill skeletons and rejects duplicates', async () => {
    const created = await createSkill({
      name: 'Minha Skill',
      description: 'does X',
      scope: 'global',
      cwd: '',
      home: dir,
    })
    expect(created).toMatchObject({ ok: true, name: 'minha-skill' })
    const file = path.join(dir, '.agents/skills/minha-skill/SKILL.md')
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('description: does X')
    const again = await createSkill({ name: 'minha-skill', scope: 'global', cwd: '', home: dir })
    expect(again).toMatchObject({ ok: false, error: 'already-exists' })
  })

  it('flattens multiline descriptions without injecting frontmatter', async () => {
    const created = await createSkill({
      name: 'segura',
      description: 'line one\nuser-invocable: false\nline three',
      scope: 'global',
      cwd: '',
      home: dir,
    })
    expect(created.ok).toBe(true)
    const skill = (await listSkills(dir, dir))[0]
    expect(skill.description).toBe('line one user-invocable: false line three')
    expect(skill.userInvocable).toBe(true) // The injection became inert description text.
  })

  it('converts saved prompts into skill directories', async () => {
    const res = await writeSkillFromPrompt({
      name: 'review',
      description: 'checklist',
      content: 'Review the diff.',
      scope: 'global',
      cwd: '',
      home: dir,
    })
    expect(res.ok).toBe(true)
    const skills = await listSkills(dir, dir)
    expect(skills[0]).toMatchObject({ name: 'review', description: 'checklist', body: 'Review the diff.' })
  })

  it('removes skills only inside supported roots', async () => {
    mkSkill('.agents/skills', 'temp', '---\nname: temp\n---\nbody')
    const outside = path.join(dir, 'outside')
    mkdirSync(outside, { recursive: true })

    expect(await removeSkillDir(outside, dir, dir)).toMatchObject({ ok: false, error: 'outside-skill-roots' })
    expect(existsSync(outside)).toBe(true)

    const skillDir = path.join(dir, '.agents/skills/temp')
    expect(await removeSkillDir(skillDir, dir, dir)).toMatchObject({ ok: true })
    expect(existsSync(skillDir)).toBe(false)
  })
})
