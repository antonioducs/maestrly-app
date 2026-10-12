import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** One synthetic file: text, bytes with an optional mode, or a symbolic link to `symlink`. */
export type FixtureFile = string | { content: string | Buffer; mode?: number } | { symlink: string }
export type FixtureFiles = Record<string, FixtureFile>

/** Writes a synthetic tree into `root` (a new temporary directory by default) and returns its path. */
export async function writeTree(files: FixtureFiles, root?: string): Promise<string> {
  const dir = root ?? mkdtempSync(path.join(os.tmpdir(), 'plg-tree-'))
  for (const [rel, file] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    rmSync(abs, { force: true, recursive: true })
    if (typeof file === 'string') writeFileSync(abs, file)
    else if ('symlink' in file) symlinkSync(file.symlink, abs)
    else writeFileSync(abs, file.content, { mode: file.mode ?? 0o644 })
  }
  return dir
}

const emptyConfigDir = mkdtempSync(path.join(os.tmpdir(), 'plg-gitcfg-'))
const emptyConfig = path.join(emptyConfigDir, 'gitconfig')
writeFileSync(emptyConfig, '')

/** Git with no user or system configuration, so fixtures never depend on the developer's settings. */
export function fixtureGit(cwd: string, args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: emptyConfig,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    }
  ).trim()
}

/** Commits `files` (and removes `remove`) in an existing fixture repository; returns the new commit. */
export async function commitFiles(dir: string, files: FixtureFiles, remove: string[] = []): Promise<string> {
  await writeTree(files, dir)
  for (const rel of remove) rmSync(path.join(dir, rel), { force: true, recursive: true })
  fixtureGit(dir, ['add', '-A'])
  fixtureGit(dir, ['commit', '-q', '--allow-empty', '-m', 'update'])
  return fixtureGit(dir, ['rev-parse', 'HEAD'])
}

/** A synthetic Git repository under a fresh parent directory. `submodule` adds a gitlink entry at that path. */
export async function makeGitRepo(
  files: FixtureFiles,
  opts: { submodule?: string; parent?: string; name?: string } = {}
): Promise<{ dir: string; commit: string }> {
  const parent = opts.parent ?? mkdtempSync(path.join(os.tmpdir(), 'plg-repos-'))
  const dir = path.join(parent, opts.name ?? 'repo')
  mkdirSync(dir, { recursive: true })
  fixtureGit(dir, ['init', '-q', '-b', 'main'])
  await writeTree(files, dir)
  fixtureGit(dir, ['add', '-A'])
  if (opts.submodule) {
    fixtureGit(dir, ['update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},${opts.submodule}`])
  }
  fixtureGit(dir, ['commit', '-q', '-m', 'initial'])
  return { dir, commit: fixtureGit(dir, ['rev-parse', 'HEAD']) }
}
