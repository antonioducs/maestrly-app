import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SKILL_MAX_BYTES, SKILL_MAX_FILES } from '@maestrly/host-protocol'

/**
 * Reads a skill folder as the Host will store it: plain files only, relative paths, bounded by
 * the same limits the Host enforces so the refusal happens here, before anything is sent.
 * Links are refused rather than followed — a skill folder must not reach outside itself.
 */
export async function readSkillFolder(root: string): Promise<{ path: string; dataBase64: string }[]> {
  const files: { path: string; dataBase64: string }[] = []
  let bytes = 0
  const walk = async (relative: string) => {
    for (const entry of (await readdir(join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue
      const rel = relative ? `${relative}/${entry.name}` : entry.name
      const info = await lstat(join(root, rel))
      if (info.isSymbolicLink()) throw new Error(`A pasta contém um link (${rel}), o que não é permitido numa skill`)
      if (info.isDirectory()) await walk(rel)
      else if (info.isFile()) {
        if (files.length >= SKILL_MAX_FILES) throw new Error(`Uma skill tem no máximo ${SKILL_MAX_FILES} arquivos`)
        bytes += info.size
        if (bytes > SKILL_MAX_BYTES) throw new Error('Esta pasta passa do tamanho máximo de uma skill (512 KiB)')
        files.push({ path: rel, dataBase64: (await readFile(join(root, rel))).toString('base64') })
      }
    }
  }
  await walk('')
  if (!files.some((file) => file.path === 'SKILL.md')) throw new Error('A pasta precisa de um SKILL.md na raiz')
  return files
}
