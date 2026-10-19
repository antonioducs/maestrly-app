import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function validateCommit(message) {
  const [subject = ''] = message.replace(/\r\n?/g, '\n').split('\n')
  if (!subject) return 'Provide a non-empty commit subject.'
  if (subject !== subject.trim()) return 'Do not surround the commit subject with whitespace.'
  if (subject.replace(/ \(#\d+\)$/, '').length > 100) return 'Keep the commit subject within 100 characters.'
  if (!/^(feat|fix|docs|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9-]+\))?!?: [a-z][^\r\n]+$/.test(subject)) {
    return 'Use a Conventional Commit subject: type(scope): lowercase description.'
  }
  return null
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  let messages
  if (args[0] === '--subject-env') {
    const name = args[1]
    if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || args.length !== 2) {
      console.error('Usage: check-commits.mjs --subject-env ENVIRONMENT_VARIABLE')
      process.exit(1)
    }
    if (process.env[name] == null) {
      console.error(`Environment variable ${name} is not set.`)
      process.exit(1)
    }
    messages = [process.env[name]]
  } else if (args.length > 0) {
    if (args.length !== 1) {
      console.error('Usage: check-commits.mjs [commit-message-file]')
      process.exit(1)
    }
    messages = [readFileSync(args[0], 'utf8')]
  } else {
    messages = execFileSync('git', ['log', '--no-merges', '--format=%s%x00', 'HEAD'], { encoding: 'utf8' })
      .split('\0')
      .map((message) => message.replace(/^\r?\n/, ''))
      .filter((message) => message.trim())
  }
  const errors = messages.map(validateCommit).filter(Boolean)
  if (errors.length) {
    for (const error of errors) console.error(error)
    process.exitCode = 1
  } else console.log(`Validated ${messages.length} commit subject(s).`)
}
