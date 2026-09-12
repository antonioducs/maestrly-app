import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { gzipSync } from 'node:zlib'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { freshDb, closeDb } from '../helpers/db'
import {
  installSkillFromSlug,
  listInstalledSkillSources,
  locateSkill,
  parseSearchResponse,
  parseSkillSlug,
  readTarGzEntries,
  recordInstalledSkill,
  forgetInstalledSkill,
  writeSkillFiles,
} from '../../src/main/chat/skills-registry'

/** Minimal ustar fixtures include names, sizes, flags and magic without checksum validation. */
function tarBlock(name: string, data: Buffer, type = '0'): Buffer {
  const header = Buffer.alloc(512)
  header.write(name.slice(0, 100), 0, 'utf8')
  header.write('0000777\0', 100)
  header.write(data.byteLength.toString(8).padStart(11, '0') + '\0', 124)
  header.write(type, 156)
  header.write('ustar\0' + '00', 257)
  const padding = Buffer.alloc((512 - (data.byteLength % 512)) % 512)
  return Buffer.concat([header, data, padding])
}

function makeTarGz(files: { path: string; content: string; type?: string }[]): Buffer {
  const blocks = files.map((file) => tarBlock(file.path, Buffer.from(file.content, 'utf8'), file.type))
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}

let dir = ''
beforeEach(() => {
  freshDb()
  dir = mkdtempSync(path.join(os.tmpdir(), 'skills-registry-'))
})
afterEach(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

describe('parseSkillSlug', () => {
  it('accepts supported skill slugs, paths and URLs', () => {
    expect(parseSkillSlug('vercel-labs/agent-skills@vercel-react-best-practices')).toEqual({
      owner: 'vercel-labs',
      repo: 'agent-skills',
      skill: 'vercel-react-best-practices',
    })
    expect(parseSkillSlug('vercel-labs/agent-skills/vercel-react-best-practices')).toEqual({
      owner: 'vercel-labs',
      repo: 'agent-skills',
      skill: 'vercel-react-best-practices',
    })
    expect(parseSkillSlug('https://skills.sh/anthropics/skills/pdf')).toMatchObject({
      owner: 'anthropics',
      repo: 'skills',
      skill: 'pdf',
    })
    expect(parseSkillSlug('https://github.com/owner/repo/tree/main/skills/deploy')).toMatchObject({
      owner: 'owner',
      repo: 'repo',
      skill: 'deploy',
      ref: 'main',
    })
    expect(parseSkillSlug('owner')).toBeNull()
    expect(parseSkillSlug('')).toBeNull()
  })
})

describe('parseSearchResponse', () => {
  it('maps registry JSON to slugs and URLs with installed flags', () => {
    const payload = {
      skills: [
        {
          id: 'vercel-labs/agent-skills/vercel-react-best-practices',
          skillId: 'vercel-react-best-practices',
          name: 'vercel-react-best-practices',
          installs: 599511,
          source: 'vercel-labs/agent-skills',
        },
        { name: 'no-id' },
      ],
    }
    const hits = parseSearchResponse(payload, new Set(['vercel-react-best-practices']))
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      slug: 'vercel-labs/agent-skills@vercel-react-best-practices',
      url: 'https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices',
      installs: 599511,
      installed: true,
    })
  })

  it('rejects registry sources outside GitHub repositories', () => {
    const payload = {
      skills: [
        { id: 'react-aria.adobe.com/react-aria', name: 'react-aria', source: 'react-aria.adobe.com', installs: 1 },
        { id: 'owner/repo/ok', name: 'ok', source: 'owner/repo', installs: 2 },
      ],
    }
    const hits = parseSearchResponse(payload, new Set())
    expect(hits.map((hit) => hit.name)).toEqual(['ok'])
  })
})

describe('tarball', () => {
  const tarball = () =>
    makeTarGz([
      { path: 'pax_global_header', content: 'ignore-me', type: 'g' },
      {
        path: 'agent-skills-HEAD/skills/react-best-practices/SKILL.md',
        content: '---\nname: vercel-react-best-practices\ndescription: react\n---\nbody',
      },
      { path: 'agent-skills-HEAD/skills/react-best-practices/scripts/run.sh', content: 'echo ok' },
      { path: 'agent-skills-HEAD/skills/other/SKILL.md', content: '---\nname: other\n---\nanother body' },
      { path: 'agent-skills-HEAD/README.md', content: 'readme' },
    ])

  it('reads regular tar files and ignores extended headers', () => {
    const entries = readTarGzEntries(tarball())
    expect(entries.map((e) => e.path)).toEqual([
      'agent-skills-HEAD/skills/react-best-practices/SKILL.md',
      'agent-skills-HEAD/skills/react-best-practices/scripts/run.sh',
      'agent-skills-HEAD/skills/other/SKILL.md',
      'agent-skills-HEAD/README.md',
    ])
  })

  it('locates skills by frontmatter or directory names', () => {
    const entries = readTarGzEntries(tarball())
    expect(locateSkill(entries, 'vercel-react-best-practices')).toMatchObject({
      root: 'agent-skills-HEAD/skills/react-best-practices',
      name: 'vercel-react-best-practices',
    })
    expect(locateSkill(entries, 'react-best-practices')?.name).toBe('vercel-react-best-practices')
    // Multiple skills without a target remain ambiguous and list available choices.
    const ambiguous = locateSkill(entries, '')
    expect(ambiguous?.root).toBe('')
    expect(ambiguous?.available).toEqual(['vercel-react-best-practices', 'other'])
    expect(locateSkill([], 'x')).toBeNull()
  })

  it('rebuilds skill trees while rejecting path escapes', async () => {
    const entries = [
      ...readTarGzEntries(tarball()),
      { path: 'agent-skills-HEAD/skills/react-best-practices/../../evil.txt', data: Buffer.from('nope') },
    ]
    const target = path.join(dir, 'react')
    const written = await writeSkillFiles(entries, 'agent-skills-HEAD/skills/react-best-practices', target)

    expect(written).toBe(2)
    expect(readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toContain('vercel-react-best-practices')
    expect(readFileSync(path.join(target, 'scripts/run.sh'), 'utf8')).toBe('echo ok')
    expect(existsSync(path.join(dir, 'evil.txt'))).toBe(false)
  })

  it('writeSkillFiles rejects BACKSLASH traversal with Windows separators and drive letters', async () => {
    const root = 'repo-HEAD/skills/safe'
    const entries = [
      { path: `${root}/SKILL.md`, data: Buffer.from('---\nname: safe\n---\nbody') },
      // On Windows, path.join treats backslash as a separator and would write OUTSIDE the skill directory.
      { path: `${root}/..\\..\\evil.txt`, data: Buffer.from('nope') },
      { path: `${root}/sub\\..\\..\\evil2.txt`, data: Buffer.from('nope') },
      { path: `${root}/C:/evil3.txt`, data: Buffer.from('nope') },
    ]
    const target = path.join(dir, 'safe')
    const written = await writeSkillFiles(entries, root, target)

    expect(written).toBe(1)
    expect(readdirSync(target)).toEqual(['SKILL.md'])
    expect(existsSync(path.join(dir, 'evil.txt'))).toBe(false)
    expect(existsSync(path.join(dir, 'evil2.txt'))).toBe(false)
  })

  it('bounds decompression bomb output', () => {
    const bomb = gzipSync(Buffer.alloc(64 * 1024)) // 64 KB expanded, approximately 80 gzip bytes
    expect(() => readTarGzEntries(bomb, 16 * 1024)).toThrow('tarball-too-large')
    expect(() => readTarGzEntries(bomb, 128 * 1024)).not.toThrow()
  })

  it('falls back to directory names after empty normalization', () => {
    const entries = readTarGzEntries(
      makeTarGz([{ path: 'repo-HEAD/foo/SKILL.md', content: '---\nname: "!!!"\n---\nbody' }])
    )
    expect(locateSkill(entries, 'foo')).toMatchObject({ root: 'repo-HEAD/foo', name: 'foo' })
  })
})

describe('installSkillFromSlug (mocked fetch)', () => {
  const stubTarball = (gz: Buffer) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(gz)))
    )
  }
  afterEach(() => vi.unstubAllGlobals())

  it('preserves prior skill versions when update validation fails', async () => {
    const v1 = makeTarGz([
      { path: 'repo-HEAD/deploy/SKILL.md', content: '---\nname: deploy\n---\nversion 1' },
      { path: 'repo-HEAD/deploy/scripts/run.sh', content: 'echo v1' },
    ])
    stubTarball(v1)
    const first = await installSkillFromSlug({ slug: 'owner/repo@deploy', scope: 'global', cwd: '', home: dir })
    expect(first).toMatchObject({ ok: true, name: 'deploy' })
    const skillDir = path.join(dir, '.agents/skills/deploy')
    expect(readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')).toContain('version 1')
    expect(listInstalledSkillSources()).toEqual({ deploy: 'owner/repo@deploy' })

    // Without overwrite: refuses without touching anything.
    const dup = await installSkillFromSlug({ slug: 'owner/repo@deploy', scope: 'global', cwd: '', home: dir })
    expect(dup).toMatchObject({ ok: false, error: 'already-exists' })

    // Oversized malicious updates cannot destroy prior versions during atomic staging.
    const tooMany = makeTarGz([
      { path: 'repo-HEAD/deploy/SKILL.md', content: '---\nname: deploy\n---\nversion 2' },
      ...Array.from({ length: 401 }, (_, i) => ({ path: `repo-HEAD/deploy/references/f${i}.md`, content: 'x' })),
    ])
    stubTarball(tooMany)
    const failed = await installSkillFromSlug({
      slug: 'owner/repo@deploy',
      scope: 'global',
      cwd: '',
      home: dir,
      overwrite: true,
    })
    expect(failed).toMatchObject({ ok: false, error: 'too-many-files' })
    expect(readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')).toContain('version 1')

    // Clean abandoned staging from interrupted installations before retry.
    const abandonedTmp = path.join(dir, '.agents/skills/.tmp-deploy-abandoned')
    const abandonedBackup = path.join(dir, '.agents/skills/.bak-deploy-abandoned')
    mkdirSync(abandonedTmp)
    mkdirSync(abandonedBackup)
    const old = new Date(Date.now() - 60 * 60 * 1000)
    utimesSync(abandonedTmp, old, old)
    utimesSync(abandonedBackup, old, old)

    // Valid overwrite replaces versions without staging or backup leftovers.
    const v2 = makeTarGz([{ path: 'repo-HEAD/deploy/SKILL.md', content: '---\nname: deploy\n---\nversion 2' }])
    stubTarball(v2)
    const updated = await installSkillFromSlug({
      slug: 'owner/repo@deploy',
      scope: 'global',
      cwd: '',
      home: dir,
      overwrite: true,
    })
    expect(updated).toMatchObject({ ok: true, name: 'deploy' })
    expect(readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')).toContain('version 2')
    expect(existsSync(path.join(skillDir, 'scripts/run.sh'))).toBe(false) // v1 does not leak into v2.
    expect(readdirSync(path.join(dir, '.agents/skills'))).toEqual(['deploy'])
  })

  it('restores abandoned backups when final directories are missing', async () => {
    const v1 = makeTarGz([{ path: 'repo-HEAD/deploy/SKILL.md', content: '---\nname: deploy\n---\nversion 1' }])
    stubTarball(v1)
    expect(
      await installSkillFromSlug({ slug: 'owner/repo@deploy', scope: 'global', cwd: '', home: dir })
    ).toMatchObject({ ok: true })

    const root = path.join(dir, '.agents/skills')
    const skillDir = path.join(root, 'deploy')
    const abandonedBackup = path.join(root, '.bak-deploy-abandoned')
    renameSync(skillDir, abandonedBackup)
    const old = new Date(Date.now() - 60 * 60 * 1000)
    utimesSync(abandonedBackup, old, old)

    const v2 = makeTarGz([{ path: 'repo-HEAD/deploy/SKILL.md', content: '---\nname: deploy\n---\nversion 2' }])
    stubTarball(v2)
    const result = await installSkillFromSlug({ slug: 'owner/repo@deploy', scope: 'global', cwd: '', home: dir })

    expect(result).toMatchObject({ ok: false, error: 'already-exists' })
    expect(readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')).toContain('version 1')
    expect(readdirSync(root)).toEqual(['deploy'])
  })

  it('rejects empty names and root installation destinations', async () => {
    stubTarball(makeTarGz([{ path: 'repo-HEAD/!!!/SKILL.md', content: '---\nname: "!!!"\n---\nbody' }]))
    const res = await installSkillFromSlug({ slug: 'owner/repo', scope: 'global', cwd: '', home: dir })
    expect(res.ok).toBe(false)
    expect(existsSync(path.join(dir, '.agents/skills/SKILL.md'))).toBe(false)
  })
})

describe('installed manifest', () => {
  it('persists and removes named skill provenance', () => {
    expect(listInstalledSkillSources()).toEqual({})
    recordInstalledSkill('react', {
      slug: 'vercel-labs/agent-skills@vercel-react-best-practices',
      source: 'vercel-labs/agent-skills',
      scope: 'global',
      dir: '/tmp/react',
      installedAt: 1,
    })
    expect(listInstalledSkillSources()).toEqual({ react: 'vercel-labs/agent-skills@vercel-react-best-practices' })
    forgetInstalledSkill('react')
    expect(listInstalledSkillSources()).toEqual({})
  })
})
