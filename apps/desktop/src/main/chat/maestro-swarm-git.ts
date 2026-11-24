import { GitCommandError, runGitOrNull, runGitRaw } from '../git-command'

export interface MaestroSwarmGit {
  branchTip(branch: string): Promise<string | null>
  isAncestor(commit: string): Promise<boolean | null>
}

export function createMaestroSwarmGit(cwd: string): MaestroSwarmGit {
  return {
    async branchTip(branch: string): Promise<string | null> {
      const tip = await runGitOrNull(cwd, ['rev-parse', '--verify', `${branch}^{commit}`])
      return tip || null
    },
    async isAncestor(commit: string): Promise<boolean | null> {
      try {
        await runGitRaw(cwd, ['merge-base', '--is-ancestor', commit, 'HEAD'])
        return true
      } catch (error) {
        if (error instanceof GitCommandError && error.code === 1) return false
        return null
      }
    },
  }
}
