// biome-ignore-all lint/suspicious/noTemplateCurlyInString: shell commands quoted as test data, not templates
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { commandPermission, commandSegments } from '../../src/main/chat/tools/bash'
import { isUnparsedCommandResource } from '../../src/shared/permission-preview'

const sh = (command: string) => commandSegments(command, 'sh')
const ps = (command: string) => commandSegments(command, 'powershell')

/** Commands people run every day: they must keep splitting into segments that saved rules can match. */
const SH_LEGITIMATE: [string, string[]][] = [
  ['git status', ['git status']],
  ['npm test -- --run', ['npm test -- --run']],
  ['echo "a)b"', ['echo "a)b"']],
  ["echo 'a)b'", ["echo 'a)b'"]],
  ['git log --oneline | head -5', ['git log --oneline', 'head -5']],
  ['npm run build && npm test', ['npm run build', 'npm test']],
  ['npm test 2>&1 | tail -20', ['npm test 2>&1', 'tail -20']],
  ['grep -E "(a|b)" file.txt', ['grep -E "(a|b)" file.txt']],
  ["find . -name '*.ts' -exec grep -l x {} \\;", ["find . -name '*.ts' -exec grep -l x {} \\;"]],
  ['git commit -m "fix: handle the (edge) case"', ['git commit -m "fix: handle the (edge) case"']],
  ['echo $((1 + 2))', ['echo $((1 + 2))']],
  ['echo ${HOME}/x', ['echo ${HOME}/x']],
  ['cd app && npm test', ['cd app', 'npm test']],
  ['(cd app && npm test)', ['cd app', 'npm test']],
  ['echo "$(git rev-parse HEAD)"', ['git rev-parse HEAD', 'echo "$(git rev-parse HEAD)"']],
  ['echo `date`', ['date', 'echo `date`']],
  ['diff <(sort a) <(sort b)', ['sort a', 'sort b', 'diff <(sort a) <(sort b)']],
  ["echo hi # it's a comment", ["echo hi # it's a comment"]],
  ['for f in *.ts; do echo $f; done', ['for f in *.ts', 'do echo $f', 'done']],
  ['if [ -f x ]; then echo y; fi', ['if [ -f x ]', 'then echo y', 'fi']],
  ["cat <<'EOF' > notes.md\n# Title\nit's fine; $(not run)\nEOF", ["cat <<'EOF' > notes.md"]],
  ['cat > f.txt <<EOF\nhello $(whoami)\nEOF\nls', ['cat > f.txt <<EOF', 'whoami', 'ls']],
  ['cat <<-EOF\n\tbody )\n\tEOF', ['cat <<-EOF']],
  ['echo a\\\nb; ls', ['echo a\\\nb', 'ls']],
  ['ls >| out.txt', ['ls >| out.txt']],
  ['cat <<< "a ) b"', ['cat <<< "a ) b"']],
  [
    "git commit -m \"$(cat <<'EOF'\nfix: the (edge) case's fix\nEOF\n)\"",
    ["cat <<'EOF'", "git commit -m \"$(cat <<'EOF'\nfix: the (edge) case's fix\nEOF\n)\""],
  ],
  [
    "python3 -c \"print('a)')\" && node -e 'console.log(1)'",
    ['python3 -c "print(\'a)\')"', "node -e 'console.log(1)'"],
  ],
  ['curl -s https://example.com/a#b | jq ".a | .b"', ['curl -s https://example.com/a#b', 'jq ".a | .b"']],
  ['export A=$(pwd); echo $((RANDOM % 10 << 1))', ['pwd', 'export A=$(pwd)', 'echo $((RANDOM % 10 << 1))']],
  ['ls src/*.{ts,tsx} | (wc -l)', ['ls src/*.{ts,tsx}', 'wc -l']],
]

/**
 * Crafted commands that hide a `touch hit`. The gate must either show it as a segment of its own or refuse to read the
 * command; the differential test below runs each one in the real shells and checks whatever actually ran.
 */
const SH_MALICIOUS = [
  "echo $(echo ')'); touch hit",
  'echo $(echo ")"); touch hit',
  'echo $(echo \\)); touch hit',
  'echo $(echo "$(echo \')\')"); touch hit',
  'echo "$(echo "\')")"; touch hit',
  'echo `echo \\`touch hit\\``',
  'echo `echo \\`; touch hit',
  "echo hi # '\ntouch hit #'",
  "echo hi;# '\ntouch hit #'",
  "echo x$(echo ')')#; touch hit",
  'cat <<EOF; touch hit\nbody\nEOF',
  'cat <<EOF\n$(touch hit)\nEOF',
  'cat <<EOF\n`touch hit`\nEOF',
  'cat <<EOF\nEOF\ntouch hit',
  'cat <<EOF\nbody\\\nEOF\ntouch hit\nEOF',
  "echo $'\\'' ; touch hit ; echo $'\\'' # '",
  'echo $(( $(touch hit) + 1 ))',
  'echo ${x:-$(touch hit)}',
  'echo "${x:-"}"; touch hit; echo "${y:-"}"',
  '(echo a; touch hit)',
  '{ echo a; touch hit; }',
  'diff <(touch hit) /dev/null',
  'echo a\\\n; touch hit',
  'echo \\>&touch hit',
  'echo a &>/dev/null; touch hit',
  'case x in x) touch hit;; esac',
  'echo $(case x in (x) touch hit;; esac)',
  'echo $(case x in x) touch hit;; esac)',
  'f() { touch hit; }; f',
  'echo "`echo \\"x\\"`"; touch hit',
  'echo $[1]; touch hit',
  "echo ')' ; touch hit",
  'ec\\\nho hi; touch hit',
  'x=$(echo a)$(touch hit)',
  'true && touch hit || echo',
  "echo 'unterminated; touch hit",
  'echo $(touch hit',
]

describe('sh permission segments', () => {
  it.each(SH_LEGITIMATE)('keeps %j matchable', (command, segments) => {
    expect(sh(command)).toEqual(segments)
  })

  it('does not let a quoted parenthesis close $( ) early', () => {
    expect(sh("echo $(echo ')'); rm x")).toEqual(["echo ')'", "echo $(echo ')')", 'rm x'])
  })

  it.each(SH_MALICIOUS)('shows or refuses the hidden command in %j', (command) => {
    const segments = sh(command)
    if (segments) expect(segments.some((segment) => segment.startsWith('touch hit'))).toBe(true)
  })

  it.each([
    "echo 'open",
    'echo "open',
    'echo $(open',
    'echo `open',
    'echo ${open',
    'echo $((1 + 2)',
    'echo end\\',
    'cat <<EOF\nno end',
    'cat <<EOF $(echo\n)\nbody\nEOF',
    'echo ) ; ls',
    'echo a(b)',
    'case $x in a) ls;; esac',
    "echo $'a\\'b'",
    'echo ${x:-"y"}',
    'echo $((1 + "2"))',
    'cat <<$(x)\nbody\n$(x)',
  ])('refuses to read %j', (command) => {
    expect(sh(command)).toBeNull()
  })
})

describe('PowerShell permission segments', () => {
  it.each([
    ['git status', ['git status']],
    ['npm test -- --run', ['npm test -- --run']],
    ['echo "a)b"', ['echo "a)b"']],
    ['Get-ChildItem | Select-Object -First 5', ['Get-ChildItem', 'Select-Object -First 5']],
    ['git log --oneline # recent ones', ['git log --oneline # recent ones']],
    ['Write-Output "$env:USERPROFILE ${env:PATH}"', ['Write-Output "$env:USERPROFILE ${env:PATH}"']],
    ['Get-ChildItem | ForEach-Object { $_.Name }', ['Get-ChildItem', '$_.Name', 'ForEach-Object { $_.Name }']],
  ] as [string, string[]][])('keeps %j matchable', (command, segments) => {
    expect(ps(command)).toEqual(segments)
  })

  it('gates commands inside parentheses, blocks and comments-free code', () => {
    expect(ps('Write-Output (Remove-Item x)')).toEqual(['Remove-Item x', 'Write-Output (Remove-Item x)'])
    expect(ps('Write-Output @(Remove-Item x)')).toEqual(['Remove-Item x', 'Write-Output @(Remove-Item x)'])
    expect(ps('& { Remove-Item x }')).toEqual(['Remove-Item x', '{ Remove-Item x }'])
    expect(ps("Write-Output a # '\nRemove-Item x #'")).toEqual(["Write-Output a # '", "Remove-Item x #'"])
    expect(ps("Write-Output a <# ' #> ; Remove-Item x ; <# ' #>")).toEqual([
      "Write-Output a <# ' #>",
      'Remove-Item x',
      "<# ' #>",
    ])
  })

  it.each([
    "Write-Output 'open",
    'Write-Output "open',
    'Write-Output $(open',
    'Write-Output (open',
    'Write-Output { open',
    'Write-Output ) ; ls',
    "Write-Output a#'\nRemove-Item x #'",
    'Write-Output a <# open',
    "cmd --% '\nRemove-Item x # '",
    "Write-Output ${a'}; Remove-Item x; '}",
    'Write-Output end`',
    "Set-Content f @'\nno end",
  ])('refuses to read %j', (command) => {
    expect(ps(command)).toBeNull()
  })
})

describe('command permission resources', () => {
  it('offers one prefix per segment to save', () => {
    expect(commandPermission('npm test && git status', 'sh')).toEqual({
      resources: ['npm test', 'git status'],
      save: ['npm test *', 'git status *'],
    })
    expect(commandPermission('cat <<EOF\nhi\nEOF', 'sh')).toEqual({
      resources: ['cat <<EOF\nhi\nEOF'],
      save: ['cat <<EOF *'],
    })
  })

  it('turns an unreadable command into one resource with nothing to save', () => {
    const gate = commandPermission("echo 'a\necho b", 'sh')
    expect(gate.save).toEqual([])
    expect(gate.resources).toHaveLength(1)
    expect(isUnparsedCommandResource(gate.resources[0])).toBe(true)
  })
})

/** Whether `/bin/sh` and bash are there to run the crafted commands (not on Windows). */
const shells =
  process.platform === 'win32' ? [] : ['/bin/sh', 'bash'].filter((file) => spawnSync(file, ['-c', 'true']).status === 0)

describe.runIf(shells.length > 0)('sh permission segments against the real shells', () => {
  it.each(SH_MALICIOUS)('shows every command that actually runs in %j', (command) => {
    const segments = sh(command)
    for (const shell of shells) {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'command-segments-'))
      try {
        spawnSync(shell, ['-c', command], { cwd: dir, stdio: 'ignore', timeout: 10_000 })
        if (existsSync(path.join(dir, 'hit')) && segments)
          expect(
            segments.some((segment) => segment.startsWith('touch hit')),
            `${shell}: ${command}`
          ).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  it('reads a crafted command the way the shell runs it', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'command-segments-'))
    try {
      // The original report: the shell runs the second command, so the gate must see it.
      spawnSync('/bin/sh', ['-c', "echo $(echo ')'); touch hit"], { cwd: dir, stdio: 'ignore' })
      expect(existsSync(path.join(dir, 'hit'))).toBe(true)
      expect(sh("echo $(echo ')'); touch hit")).toContain('touch hit')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
