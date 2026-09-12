import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ToolExecutionOptions } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatHarnessCapabilities } from '../../src/main/chat/harness'
import {
  OPENAI_APPLY_PATCH_TOOL_NAME,
  OPENAI_NATIVE_PERMISSION_DENIED_PREFIX,
  buildOpenAINativeTools,
  isOpenAINativeFailedOutput,
  isOpenAINativePermissionDeniedOutput,
  openAINativeFailureOutput,
  quoteOpenAILocalShellCommand,
} from '../../src/main/chat/openai/native-tools'
import type { ToolContext } from '../../src/main/chat/tools/util'

const capabilities = (overrides: Partial<ChatHarnessCapabilities> = {}): ChatHarnessCapabilities => ({
  responseItems: true,
  encryptedReasoning: true,
  messagePhase: true,
  strictTools: true,
  parallelTools: true,
  promptCacheKey: true,
  reasoningContext: false,
  nativeCompaction: false,
  toolSearch: false,
  nativeShell: true,
  nativeApplyPatch: true,
  websocket: false,
  ...overrides,
})

const execution = (toolCallId: string, abortSignal?: AbortSignal): ToolExecutionOptions<unknown> =>
  ({ toolCallId, messages: [], context: undefined, abortSignal }) as ToolExecutionOptions<unknown>

describe('OpenAI native tool adapters', () => {
  let root: string
  let asks: Array<{ action: string; resources: string[] }>

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'maestrly-openai-native-'))
    asks = []
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  const makeCtx =
    (
      ask: ToolContext['ask'] = async (action, resources) => {
        asks.push({ action, resources })
      }
    ) =>
    (toolCallId: string, signal: AbortSignal): ToolContext => ({
      conversationId: 'conversation',
      projectId: 'project',
      messageId: 'message',
      toolCallId,
      cwd: root,
      signal,
      ask,
      askQuestion: async () => [],
    })

  it('exposes only provider-native tools enabled by model capabilities', () => {
    const tools = buildOpenAINativeTools({
      cwd: root,
      capabilities: capabilities({ nativeShell: false }),
      makeCtx: makeCtx(),
    })

    expect(Object.keys(tools)).toEqual([OPENAI_APPLY_PATCH_TOOL_NAME])
    expect(tools.apply_patch).toMatchObject({ type: 'provider', id: 'openai.apply_patch' })
  })

  it('quotes argv and delegates local_shell to the existing bash permission/execution boundary', async () => {
    const tools = buildOpenAINativeTools({ cwd: root, capabilities: capabilities(), makeCtx: makeCtx() })
    const injectedFile = path.join(root, 'command-injection-ran')
    const literal = `one; touch ${injectedFile}`

    const result = await tools.local_shell.execute!(
      {
        action: {
          type: 'exec',
          command: [process.execPath, '-e', 'process.stdout.write(process.argv[1])', literal],
        },
      },
      execution('shell-1')
    )

    expect(result.output).toContain(literal)
    await expect(fs.stat(injectedFile)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ action: 'bash' })
  })

  it('returns schema-valid local_shell failures for unsupported overrides and invalid timeouts', async () => {
    const tools = buildOpenAINativeTools({ cwd: root, capabilities: capabilities(), makeCtx: makeCtx() })

    await expect(
      tools.local_shell.execute!(
        { action: { type: 'exec', command: ['echo', 'x'], user: 'root' } },
        execution('shell-user')
      )
    ).resolves.toEqual({ output: expect.stringMatching(/Maestrly tool failed: .*user switching/) })
    await expect(
      tools.local_shell.execute!(
        { action: { type: 'exec', command: ['echo', 'x'], env: { TOKEN: 'secret' } } },
        execution('shell-env')
      )
    ).resolves.toEqual({ output: expect.stringMatching(/Maestrly tool failed: .*environment overrides/) })
    await expect(
      tools.local_shell.execute!(
        { action: { type: 'exec', command: ['echo', 'x'], timeoutMs: 600_001 } },
        execution('shell-timeout')
      )
    ).resolves.toEqual({ output: expect.stringMatching(/Maestrly tool failed: .*timeoutMs/) })
    expect(asks).toEqual([])
  })

  it('creates, updates and deletes through edit gates and per-file locking', async () => {
    const tools = buildOpenAINativeTools({ cwd: root, capabilities: capabilities(), makeCtx: makeCtx() })
    const applyPatch = tools.apply_patch

    await expect(
      applyPatch.execute!(
        {
          callId: 'create-1',
          operation: { type: 'create_file', path: 'src/example.txt', diff: '+alpha\n+beta\n+' },
        },
        execution('create-1')
      )
    ).resolves.toEqual({ status: 'completed', output: 'Created src/example.txt' })
    expect(await fs.readFile(path.join(root, 'src/example.txt'), 'utf8')).toBe('alpha\nbeta\n')

    await expect(
      applyPatch.execute!(
        {
          callId: 'update-1',
          operation: {
            type: 'update_file',
            path: 'src/example.txt',
            diff: '@@\n-alpha\n+ALPHA\n beta',
          },
        },
        execution('update-1')
      )
    ).resolves.toEqual({ status: 'completed', output: 'Updated src/example.txt' })
    expect(await fs.readFile(path.join(root, 'src/example.txt'), 'utf8')).toBe('ALPHA\nbeta\n')

    await expect(
      applyPatch.execute!(
        { callId: 'delete-1', operation: { type: 'delete_file', path: 'src/example.txt' } },
        execution('delete-1')
      )
    ).resolves.toEqual({ status: 'completed', output: 'Deleted src/example.txt' })
    await expect(fs.stat(path.join(root, 'src/example.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(asks.map((item) => item.action)).toEqual(['edit', 'edit', 'edit'])
  })

  it('refuses workspace-root targets, existing creates and oversized diffs without corrupting files', async () => {
    const tools = buildOpenAINativeTools({ cwd: root, capabilities: capabilities(), makeCtx: makeCtx() })
    await fs.writeFile(path.join(root, 'existing.txt'), 'keep\n')

    await expect(
      tools.apply_patch.execute!(
        { callId: 'root-target', operation: { type: 'delete_file', path: '.' } },
        execution('root-target')
      )
    ).resolves.toMatchObject({ status: 'failed', output: expect.stringContaining('workspace root') })
    await expect(
      tools.apply_patch.execute!(
        { callId: 'existing-create', operation: { type: 'create_file', path: 'existing.txt', diff: '+replace' } },
        execution('existing-create')
      )
    ).resolves.toMatchObject({ status: 'failed', output: expect.stringContaining('existing file') })
    await expect(
      tools.apply_patch.execute!(
        {
          callId: 'oversized',
          operation: { type: 'create_file', path: 'huge.txt', diff: `+${'x'.repeat(10 * 1024 * 1024)}` },
        },
        execution('oversized')
      )
    ).resolves.toMatchObject({ status: 'failed', output: expect.stringContaining('byte safety limit') })

    expect(await fs.readFile(path.join(root, 'existing.txt'), 'utf8')).toBe('keep\n')
    await expect(fs.stat(path.join(root, 'huge.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('detects a concurrent file change between read and write and preserves the newer bytes', async () => {
    const file = path.join(root, 'race.txt')
    await fs.writeFile(file, 'old\n')
    const tools = buildOpenAINativeTools({ cwd: root, capabilities: capabilities(), makeCtx: makeCtx() })
    const readFile = fs.readFile.bind(fs)
    let targetReads = 0
    const readSpy = vi.spyOn(fs, 'readFile').mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
      const result = await readFile(...args)
      if (String(args[0]) === file && ++targetReads === 1) await fs.writeFile(file, 'concurrent\n')
      return result
    }) as typeof fs.readFile)

    try {
      await expect(
        tools.apply_patch.execute!(
          {
            callId: 'race',
            operation: { type: 'update_file', path: 'race.txt', diff: '@@\n-old\n+patched' },
          },
          execution('race')
        )
      ).resolves.toMatchObject({ status: 'failed', output: expect.stringContaining('changed while applying') })
      expect(await readFile(file, 'utf8')).toBe('concurrent\n')
    } finally {
      readSpy.mockRestore()
    }
  })

  it('preserves UTF-8 BOM, CRLF, and the original file on an invalid diff', async () => {
    const file = path.join(root, 'windows.txt')
    await fs.writeFile(file, '\ufefffirst\r\nsecond\r\n', 'utf8')
    const tools = buildOpenAINativeTools({ cwd: root, capabilities: capabilities(), makeCtx: makeCtx() })

    await expect(
      tools.apply_patch.execute!(
        {
          callId: 'update-crlf',
          operation: {
            type: 'update_file',
            path: 'windows.txt',
            diff: '@@\n-first\n+FIRST\n second',
          },
        },
        execution('update-crlf')
      )
    ).resolves.toEqual({ status: 'completed', output: 'Updated windows.txt' })
    expect(await fs.readFile(file, 'utf8')).toBe('\ufeffFIRST\r\nsecond\r\n')

    const beforeFailure = await fs.readFile(file)
    await expect(
      tools.apply_patch.execute!(
        {
          callId: 'bad-diff',
          operation: {
            type: 'update_file',
            path: 'windows.txt',
            diff: '@@\n-missing\n+replacement',
          },
        },
        execution('bad-diff')
      )
    ).resolves.toMatchObject({ status: 'failed', output: expect.stringContaining('Invalid Context') })
    expect(await fs.readFile(file)).toEqual(beforeFailure)
  })

  it('requests external-directory approval before edit and never deletes directories', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'maestrly-openai-outside-'))
    try {
      const relativeOutside = path.relative(root, path.join(outside, 'created.txt'))
      const tools = buildOpenAINativeTools({ cwd: root, capabilities: capabilities(), makeCtx: makeCtx() })
      await tools.apply_patch.execute!(
        {
          callId: 'external',
          operation: { type: 'create_file', path: relativeOutside, diff: '+outside' },
        },
        execution('external')
      )
      expect(asks.map((item) => item.action)).toEqual(['external_directory', 'edit'])

      await fs.mkdir(path.join(root, 'keep-dir'))
      await expect(
        tools.apply_patch.execute!(
          { callId: 'dir', operation: { type: 'delete_file', path: 'keep-dir' } },
          execution('dir')
        )
      ).resolves.toMatchObject({ status: 'failed', output: expect.stringContaining('refuses') })
      expect((await fs.stat(path.join(root, 'keep-dir'))).isDirectory()).toBe(true)
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'detects an in-workspace symlink that resolves outside the workspace',
    async () => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'maestrly-openai-symlink-'))
      try {
        await fs.writeFile(path.join(outside, 'target.txt'), 'old\n', 'utf8')
        await fs.symlink(outside, path.join(root, 'linked'), 'dir')
        const tools = buildOpenAINativeTools({ cwd: root, capabilities: capabilities(), makeCtx: makeCtx() })

        await expect(
          tools.apply_patch.execute!(
            {
              callId: 'symlink',
              operation: {
                type: 'update_file',
                path: 'linked/target.txt',
                diff: '@@\n-old\n+new',
              },
            },
            execution('symlink')
          )
        ).resolves.toMatchObject({ status: 'completed' })
        expect(asks.map((item) => item.action)).toEqual(['external_directory', 'edit'])
        expect(await fs.readFile(path.join(outside, 'target.txt'), 'utf8')).toBe('new\n')
      } finally {
        await fs.rm(outside, { recursive: true, force: true })
      }
    }
  )

  it('returns a detectable, schema-valid failed result for permission denials', async () => {
    const rejection = Object.assign(new Error('no'), { name: 'PermissionRejectedError' })
    const ask = vi.fn(async () => {
      throw rejection
    })
    const tools = buildOpenAINativeTools({ cwd: root, capabilities: capabilities(), makeCtx: makeCtx(ask) })

    await expect(
      tools.apply_patch.execute!(
        { callId: 'denied', operation: { type: 'create_file', path: 'denied.txt', diff: '+no' } },
        execution('denied')
      )
    ).resolves.toEqual({
      status: 'failed',
      output: expect.stringMatching(/^Maestrly permission denied: no$/),
    })
    await expect(fs.stat(path.join(root, 'denied.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('classifies native outcomes out of band without letting normal stdout spoof a denial', async () => {
    const denied = openAINativeFailureOutput(OPENAI_APPLY_PATCH_TOOL_NAME, new Error('no'), true)
    const failed = openAINativeFailureOutput('local_shell', new Error('boom'))

    expect(isOpenAINativePermissionDeniedOutput(OPENAI_APPLY_PATCH_TOOL_NAME, denied)).toBe(true)
    expect(isOpenAINativeFailedOutput('local_shell', failed)).toBe(true)
    expect(JSON.parse(JSON.stringify(denied))).toEqual({ status: 'failed', output: 'Maestrly permission denied: no' })
    expect(JSON.parse(JSON.stringify(failed))).toEqual({ output: 'Maestrly tool failed: boom' })

    const tools = buildOpenAINativeTools({ cwd: root, capabilities: capabilities(), makeCtx: makeCtx() })
    const normalOutput = await tools.local_shell.execute!(
      {
        action: {
          type: 'exec',
          command: [
            process.execPath,
            '-e',
            'process.stdout.write(process.argv[1])',
            `${OPENAI_NATIVE_PERMISSION_DENIED_PREFIX}fake`,
          ],
        },
      },
      execution('spoofed-denial')
    )
    expect(normalOutput.output).toContain(`${OPENAI_NATIVE_PERMISSION_DENIED_PREFIX}fake`)
    expect(isOpenAINativePermissionDeniedOutput('local_shell', normalOutput)).toBe(false)
    expect(isOpenAINativeFailedOutput('local_shell', normalOutput)).toBe(false)
  })

  it('returns a schema-valid failure for mismatched apply_patch call ids before approval or mutation', async () => {
    const tools = buildOpenAINativeTools({ cwd: root, capabilities: capabilities(), makeCtx: makeCtx() })

    await expect(
      tools.apply_patch.execute!(
        { callId: 'provider-call', operation: { type: 'create_file', path: 'mismatch.txt', diff: '+no' } },
        execution('sdk-call')
      )
    ).resolves.toEqual({ status: 'failed', output: expect.stringContaining('callId mismatch') })
    expect(asks).toEqual([])
    await expect(fs.stat(path.join(root, 'mismatch.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves AbortError as control flow instead of turning it into a tool output', async () => {
    const controller = new AbortController()
    controller.abort()
    const tools = buildOpenAINativeTools({ cwd: root, capabilities: capabilities(), makeCtx: makeCtx() })

    await expect(
      tools.apply_patch.execute!(
        { callId: 'aborted', operation: { type: 'create_file', path: 'aborted.txt', diff: '+no' } },
        execution('aborted', controller.signal)
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
    await expect(
      tools.local_shell.execute!(
        { action: { type: 'exec', command: ['echo', 'must-not-run'] } },
        execution('aborted-shell', controller.signal)
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
    await expect(fs.stat(path.join(root, 'aborted.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('provides deterministic POSIX and conservative Windows argv quoting', () => {
    expect(quoteOpenAILocalShellCommand(['printf', '%s', "a'b c"], 'linux')).toBe(`printf %s 'a'"'"'b c'`)
    expect(quoteOpenAILocalShellCommand(['C:\\Program Files\\tool.exe', 'hello world'], 'win32')).toBe(
      '"C:\\Program Files\\tool.exe" "hello world"'
    )
    expect(() => quoteOpenAILocalShellCommand(['echo', '%PATH%'], 'win32')).toThrow(/Windows/)
    expect(() => quoteOpenAILocalShellCommand(['echo', 'unsafe" & whoami'], 'win32')).toThrow(/Windows/)
  })
})
