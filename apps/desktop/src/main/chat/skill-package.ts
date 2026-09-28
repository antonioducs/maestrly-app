import fsp from 'node:fs/promises'
import path from 'node:path'
import { FLEET_PROVISIONING_LIMITS as limits } from '@maestrly/bot-fleet-protocol'
import type { SkillFile } from './skills-registry'

export type SkillPackageProblem = 'too-large' | 'file-too-large' | 'path-too-long' | 'too-many-files' | 'no-skill-md'

type Entry = { path: string; absolute: string; bytes: number; executable: boolean }

async function walkSkillDirectory(dir: string): Promise<Entry[]> {
  const root = await fsp.realpath(dir)
  const files: Entry[] = []
  async function walk(current: string, prefix: string): Promise<void> {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') continue
      const absolute = path.join(current, entry.name)
      const relative = prefix + entry.name
      const stat = await fsp.lstat(absolute)
      if (stat.isDirectory()) await walk(absolute, relative + '/')
      else if (stat.isFile())
        files.push({ path: relative, absolute, bytes: stat.size, executable: (stat.mode & 0o111) !== 0 })
    }
  }
  await walk(root, '')
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

function measure(files: Entry[]): {
  files: number
  bytes: number
  scripts: boolean
  problem: SkillPackageProblem | null
} {
  const bytes = files.reduce((total, file) => total + file.bytes, 0)
  const problem =
    files.length > limits.skillFilesMax
      ? 'too-many-files'
      : bytes > limits.skillBytesMax
        ? 'too-large'
        : files.some((file) => file.bytes > limits.skillFileBytesMax)
          ? 'file-too-large'
          : files.some((file) => file.path.length > limits.skillPathMax)
            ? 'path-too-long'
            : !files.some((file) => file.path === 'SKILL.md')
              ? 'no-skill-md'
              : null
  return {
    files: files.length,
    bytes,
    scripts: files.some((file) => file.executable || file.path.startsWith('scripts/')),
    problem,
  }
}

export async function measureSkillDirectory(
  dir: string
): Promise<{ files: number; bytes: number; scripts: boolean; problem: SkillPackageProblem | null }> {
  return measure(await walkSkillDirectory(dir))
}

export async function packageSkillDirectory(dir: string): Promise<SkillFile[]> {
  const entries = await walkSkillDirectory(dir)
  const { problem } = measure(entries)
  if (problem) throw new Error(problem)
  const files: SkillFile[] = []
  let bytes = 0
  for (const entry of entries) {
    const data = await fsp.readFile(entry.absolute)
    bytes += data.byteLength
    // Files can change between measuring and reading.
    if (bytes > limits.skillBytesMax) throw new Error('too-large')
    if (data.byteLength > limits.skillFileBytesMax) throw new Error('file-too-large')
    files.push({ path: entry.path, data, executable: entry.executable })
  }
  return files
}
