import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { editTool, findReplacementMatches, type ReplacementMatch } from '../../src/main/chat/tools/edit'
import { bashPermissionSavePattern, commandSegments } from '../../src/main/chat/tools/bash'
import { shouldSkipSearchDir } from '../../src/main/chat/tools/grep'
import { webfetchPermissionSavePattern } from '../../src/main/chat/tools/webfetch'
import { reviewPlanTool } from '../../src/main/chat/tools/review-plan'
import { boundText, withFileLock, type ToolContext } from '../../src/main/chat/tools/util'

function ctx(cwd: string, ask = vi.fn(async () => {})): ToolContext {
  return {
    conversationId: 'c1',
    projectId: 'p1',
    messageId: 'm1',
    toolCallId: 't1',
    cwd,
    signal: new AbortController().signal,
    ask,
    askQuestion: async () => [],
  }
}

describe('chat tools', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'chat-tools-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('preserves BOM and CRLF during fuzzy edits', async () => {
    const file = path.join(dir, 'a.ts')
    writeFileSync(file, Buffer.from('\ufefffunction x() {\r\n    return 1\r\n}\r\n', 'utf8'))

    await editTool.execute(
      { path: 'a.ts', oldString: 'function x() {\nreturn 1\n}', newString: 'function x() {\nreturn 2\n}' },
      ctx(dir)
    )

    const out = readFileSync(file)
    expect(out.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    expect(out.toString('utf8')).toBe('\ufefffunction x() {\r\n    return 2\r\n}\r\n')
  })

  it('rejects ambiguous fuzzy edits without replaceAll', async () => {
    writeFileSync(path.join(dir, 'a.ts'), '  foo()\n\nfoo()\n')

    await expect(editTool.execute({ path: 'a.ts', oldString: 'foo()', newString: 'bar()' }, ctx(dir))).rejects.toThrow(
      /Found 2/
    )
  })

  it('detects files changed during edits', async () => {
    const file = path.join(dir, 'a.ts')
    writeFileSync(file, 'old\n')
    const realReadFile = fs.readFile.bind(fs)
    let mutated = false
    const spy = vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      const result = await realReadFile(...args)
      if (!mutated && String(args[0]) === file) {
        mutated = true
        writeFileSync(file, 'changed\n')
      }
      return result
    })

    try {
      await expect(editTool.execute({ path: 'a.ts', oldString: 'old', newString: 'new' }, ctx(dir))).rejects.toThrow(
        /changed after approval/
      )
    } finally {
      spy.mockRestore()
    }
  })

  it('exposes block-anchor edit fallback', () => {
    const matches: ReplacementMatch[] = findReplacementMatches('start\nchanged middle\nend\n', 'start\nold middle\nend')
    expect(matches).toEqual([
      {
        start: 0,
        end: 'start\nchanged middle\nend'.length,
        matched: 'start\nchanged middle\nend',
        kind: 'block-anchor',
      },
    ])
  })

  it('block-anchor requires at least three lines because two would match any pair in the file', () => {
    expect(findReplacementMatches('alpha\nbeta\ngamma\n', 'alpha\nDIFFERENT')).toEqual([])
  })

  it('rejects replaceAll across different block-anchor contents', async () => {
    writeFileSync(path.join(dir, 'a.ts'), 'fn()\nAAA\nend\nfn()\nBBB\nend\n')
    await expect(
      editTool.execute(
        { path: 'a.ts', oldString: 'fn()\nCCC\nend', newString: 'x()\nCCC\nend', replaceAll: true },
        ctx(dir)
      )
    ).rejects.toThrow(/block-anchor/)
  })

  it('previews actual fuzzy-match replacements', async () => {
    writeFileSync(path.join(dir, 'a.ts'), '    if (x) {\n        y()\n    }\n')
    const r = await editTool.execute(
      { path: 'a.ts', oldString: 'if (x) {\ny()\n}', newString: 'if (x) {\nz()\n}' },
      ctx(dir)
    )
    expect(r.matchKind).toBe('line-trimmed')
    expect(r.oldString).toContain('    if (x) {') // The file's actual content, not raw oldString.
    expect(readFileSync(path.join(dir, 'a.ts'), 'utf8')).toBe('    if (x) {\n        z()\n    }\n')
  })

  it('splits command chains and substitutions outside single quotes', () => {
    expect(commandSegments('npm test && rm -rf /')).toEqual(['npm test', 'rm -rf /'])
    expect(commandSegments('cat f | sh')).toEqual(['cat f', 'sh'])
    expect(commandSegments('a; b')).toEqual(['a', 'b'])
    expect(commandSegments("echo 'a && b'")).toEqual(["echo 'a && b'"])
    expect(commandSegments('echo $(whoami)')).toEqual(['whoami', 'echo $(whoami)'])
    expect(commandSegments('ls 2>&1')).toEqual(['ls 2>&1'])
    expect(commandSegments('cat <<EOF\nrm -rf /\nEOF')).toEqual(['cat <<EOF\nrm -rf /\nEOF'])
  })

  it('serializes file operations by lock key', async () => {
    const seen: number[] = []
    const p1 = withFileLock('same', async () => {
      seen.push(1)
      await new Promise((r) => setTimeout(r, 20))
      seen.push(2)
    })
    const p2 = withFileLock('same', async () => {
      seen.push(3)
    })

    await Promise.all([p1, p2])
    expect(seen).toEqual([1, 2, 3])
  })

  it('spills oversized text while preserving head and tail', async () => {
    const text = Array.from({ length: 2105 }, (_, i) => `line-${i}`).join('\n')
    const bounded = boundText(text, 'spill-test')
    expect(bounded).toContain('output truncated')
    expect(bounded).toContain('line-0')
    expect(bounded).toContain('line-2104')
    expect(
      await fs.readFile(
        path.join(os.tmpdir(), 'agents-test-electron', 'chat-tool-output', 'tool_spill-test.txt'),
        'utf8'
      )
    ).toBe(text)
  })

  it('scopes always permissions', () => {
    expect(bashPermissionSavePattern('npm test -- x')).toBe('npm test *')
    expect(bashPermissionSavePattern('git status')).toBe('git status *')
    expect(webfetchPermissionSavePattern(new URL('https://example.com/docs/a?x=1'))).toBe('https://example.com/*')
    expect(webfetchPermissionSavePattern(new URL('https://example.com:8443/docs'))).toBe('https://example.com:8443/*')
  })

  it('allows useful dot directories in grep', () => {
    expect(shouldSkipSearchDir('.git')).toBe(true)
    expect(shouldSkipSearchDir('.github')).toBe(false)
    expect(shouldSkipSearchDir('.vscode')).toBe(false)
  })

  it('submits and releases plans through context', async () => {
    const submitPlan = vi.fn(() => true)
    const res = await reviewPlanTool.execute({ plan: '## Plan', title: 'T' }, { ...ctx(dir), submitPlan })
    expect(submitPlan).toHaveBeenCalledWith('## Plan', 'T')
    expect(res).toEqual({ staged: true })
    expect(reviewPlanTool.toModelText({ plan: '## Plan' }, res)).toContain('This turn is over')
  })

  it('does not fake plan submission or end turns on origin conflict', async () => {
    const submitPlan = vi.fn(() => false)
    const res = await reviewPlanTool.execute({ plan: '## Plan' }, { ...ctx(dir), submitPlan })

    expect(res).toEqual({ staged: false, error: 'plan-origin-conflict' })
    expect(reviewPlanTool.toModelText({ plan: '## Plan' }, res)).toContain('another plan origin')
    expect(reviewPlanTool.toModelText({ plan: '## Plan' }, res)).not.toContain('This turn is over')
  })

  it('omits review_plan without a submission context', async () => {
    const res = await reviewPlanTool.execute({ plan: '## Plan' }, ctx(dir))
    expect(res).toEqual({ staged: false })
    expect(reviewPlanTool.toModelText({ plan: '## Plan' }, res)).toContain('not available')
  })
})
