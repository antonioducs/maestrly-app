import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Synthetic repositories for conversation move tests: a bare origin, a working clone, and more clones of it. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim()
}

/** Porcelain status of a checkout, the way a test compares two of them. */
export function status(cwd: string): string {
  return execFileSync('git', ['status', '--porcelain=v2', '-z', '--untracked-files=all'], {
    cwd,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .sort()
    .join('\n')
}

export interface MoveRepo {
  root: string
  remote: string
  work: string
  clone(name: string): string
  cleanup(): void
}

/**
 * `remote.git` with `main` (a.txt … f.sh, .gitignore ignoring .env.local) and a clone `work` on `feat`, one commit
 * ahead of origin. `dirty()` then stages, edits, deletes and adds files the way a conversation leaves them.
 */
export function makeRemoteRepo(prefix = 'maestrly-move-'): MoveRepo {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)))
  const remote = path.join(root, 'remote.git')
  const seed = path.join(root, 'seed')
  git(root, 'init', '-q', '--bare', '-b', 'main', remote)
  mkdirSync(seed)
  git(seed, 'init', '-q', '-b', 'main')
  for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) writeFileSync(path.join(seed, name), `${name} base\n`)
  writeFileSync(path.join(seed, 'f.sh'), 'echo hi\n')
  writeFileSync(path.join(seed, '.gitignore'), '.env.local\n')
  git(seed, 'add', '-A')
  git(seed, 'commit', '-q', '-m', 'base')
  git(seed, 'remote', 'add', 'origin', remote)
  git(seed, 'push', '-q', 'origin', 'main')
  rmSync(seed, { recursive: true, force: true })
  const clone = (name: string): string => {
    const target = path.join(root, name)
    git(root, 'clone', '-q', remote, target)
    return target
  }
  const work = clone('work')
  git(work, 'checkout', '-q', '-b', 'feat')
  writeFileSync(path.join(work, 'a.txt'), 'a.txt committed on feat\n')
  git(work, 'commit', '-q', '-am', 'feat work')
  return { root, remote, work, clone, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** Leaves every kind of change in `cwd`: staged, unstaged, staged and unstaged deletions, untracked, mode, ignored. */
export function dirty(cwd: string): void {
  writeFileSync(path.join(cwd, 'a.txt'), 'a.txt staged\n')
  git(cwd, 'add', 'a.txt')
  writeFileSync(path.join(cwd, 'b.txt'), 'b.txt unstaged\n')
  git(cwd, 'rm', '-q', 'c.txt')
  unlinkSync(path.join(cwd, 'd.txt'))
  writeFileSync(path.join(cwd, 'e.txt'), 'e.txt untracked\n')
  chmodSync(path.join(cwd, 'f.sh'), 0o755)
  writeFileSync(path.join(cwd, '.env.local'), 'SECRET=1\n')
}
