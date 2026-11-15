import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const sources = ['src/main', 'src/preload'].flatMap((root) =>
  (readdirSync(root, { recursive: true }) as string[])
    .filter((file) => /\.tsx?$/.test(file) && !file.endsWith('.d.ts'))
    .map((file) => path.join(root, file))
)

describe('main process module paths', () => {
  // electron-vite adds `const __dirname` to an ESM chunk that mentions it, and Rolldown does not rename a module's own
  // around it: the app then fails to load with "Identifier '__dirname' has already been declared".
  it('reads its folder from import.meta.dirname instead of declaring __dirname', () => {
    const declaring = sources.filter((file) =>
      /^\s*(?:const|let|var)\s+__(?:dirname|filename)\b/m.test(readFileSync(file, 'utf8'))
    )
    expect(declaring).toEqual([])
  })

  // Those folders are the main bundle's: a shared chunk in a folder of its own would look for the workers there.
  it('writes shared chunks beside the entries', () => {
    const config = readFileSync('electron.vite.config.ts', 'utf8')
    expect(config).toMatch(/main: \{[\s\S]*?output: \{ chunkFileNames: '\[name\]-\[hash\]\.js' \}[\s\S]*?\n {2}preload:/)
  })
})
