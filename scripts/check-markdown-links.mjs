#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

function withoutFencedCode(source) {
  let fence = null
  return source
    .split('\n')
    .map((line) => {
      if (fence) {
        const closing = new RegExp(`^\\s*${fence.character}{${fence.length},}\\s*$`)
        if (closing.test(line)) fence = null
        return ''
      }
      const opening = /^\s*(`{3,}|~{3,})/.exec(line)
      if (opening) {
        fence = { character: opening[1][0], length: opening[1].length }
        return ''
      }
      return line
    })
    .join('\n')
}

function localTargets(source) {
  const targets = []
  const link = /!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^)]*)?\)/g
  for (const match of withoutFencedCode(source).matchAll(link)) {
    const target = (match[1] ?? match[2] ?? '').trim()
    if (!target || target.startsWith('#') || target.startsWith('//')) continue
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue
    targets.push(target)
  }
  return targets
}

export function checkMarkdownLinks(root, files) {
  const failures = []
  for (const relativeFile of [...new Set(files)].sort()) {
    const sourceFile = path.resolve(root, relativeFile)
    let source
    try {
      source = readFileSync(sourceFile, 'utf8')
    } catch (error) {
      failures.push(`${relativeFile}: could not read source (${error.message})`)
      continue
    }
    for (const originalTarget of localTargets(source)) {
      const withoutFragment = originalTarget.split('#', 1)[0]
      let decoded
      try {
        decoded = decodeURIComponent(withoutFragment)
      } catch {
        failures.push(`${relativeFile}: invalid percent encoding in ${originalTarget}`)
        continue
      }
      if (!decoded) continue
      const target = decoded.startsWith('/')
        ? path.resolve(root, decoded.slice(1))
        : path.resolve(path.dirname(sourceFile), decoded)
      if (!existsSync(target)) failures.push(`${relativeFile}: missing local target ${originalTarget}`)
    }
  }
  return failures.sort()
}

function trackedMarkdownFiles(root) {
  const result = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '*.md'], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  })
  if (result.error) throw new Error(`git ls-files could not start: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`git ls-files failed with status ${result.status}: ${result.stderr.trim()}`)
  return result.stdout.split('\0').filter((file) => file && existsSync(path.join(root, file)))
}

function main() {
  const files = trackedMarkdownFiles(repositoryRoot)
  const failures = checkMarkdownLinks(repositoryRoot, files)
  if (failures.length > 0) {
    for (const failure of failures) console.error(`[markdown-links] ${failure}`)
    process.exit(1)
  }
  console.log(`[markdown-links] ok (${files.length} file(s))`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
