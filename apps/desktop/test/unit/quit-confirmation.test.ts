import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { transformSync } from 'esbuild'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')

/** One top-level declaration of the main entry, from its first line to the closing brace at column 0. */
function declaration(head: string): string {
  const start = source.indexOf(`\n${head}`)
  expect(start, head).toBeGreaterThan(0)
  const end = source.indexOf('\n}\n', start)
  return source.slice(start, end + 3)
}

interface Work {
  chatRuns: number
  delegations: number
  terminalCommand: boolean
  backgroundCommands: boolean
}

/** Runs the real quit confirmation of the main entry against a stub app, dialog and work probes. */
function quitConfirmation(work: Partial<Work> = {}, answer: 'cancel' | 'close' = 'close') {
  const state: Work = { chatRuns: 0, delegations: 0, terminalCommand: false, backgroundCommands: false, ...work }
  const code = transformSync(
    [
      'let backgroundQuit = false',
      'let quitConfirmed = false',
      'let quitDialogOpen = false',
      'let systemQuit = false',
      declaration('function quitInterruptsWork('),
      declaration('async function confirmQuit('),
      declaration('function quitForSystem('),
      declaration('function confirmQuitOnce('),
      // The guard both window close and before-quit run first.
      'function requestQuit() { let prevented = false; const allowed = confirmQuitOnce(() => { prevented = true }); return { allowed, prevented } }',
    ].join('\n'),
    { loader: 'ts', target: 'es2022', format: 'cjs' }
  ).code
  const attempts: { allowed: boolean; prevented: boolean }[] = []
  const context: Record<string, unknown> = {}
  const showMessageBox = vi.fn(async () => ({ response: answer === 'close' ? 1 : 0 }))
  Object.assign(context, {
    app: { quit: () => attempts.push((context.requestQuit as () => (typeof attempts)[number])()) },
    mainWindow: { isDestroyed: () => false },
    dialog: { showMessageBox },
    tMain: () => (key: string) => key,
    activeChatRunCount: () => state.chatRuns,
    activeMaestroDelegationCount: () => state.delegations,
    hasRunningTerminalCommand: () => state.terminalCommand,
    hasAnyOwnedGroups: () => state.backgroundCommands,
    isE2E: () => false,
    isInstalling: () => false,
  })
  runInNewContext(code, context)
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  return {
    attempts,
    showMessageBox,
    quit: () => (context.app as { quit: () => void }).quit(),
    quitForSystem: () => (context.quitForSystem as () => void)(),
    settle,
  }
}

describe('quit confirmation', () => {
  it('quits without asking when nothing is running', async () => {
    const quit = quitConfirmation()
    quit.quit()
    await quit.settle()
    expect(quit.showMessageBox).not.toHaveBeenCalled()
    expect(quit.attempts.at(-1)).toEqual({ allowed: true, prevented: false })
  })

  it.each<[string, Partial<Work>]>([
    ['an agent turn', { chatRuns: 1 }],
    ['a delegated agent', { delegations: 1 }],
    ['a terminal command', { terminalCommand: true }],
    ['a background command', { backgroundCommands: true }],
  ])('asks before ending %s, and cancelling keeps the app open', async (_label, work) => {
    const quit = quitConfirmation(work, 'cancel')
    quit.quit()
    await quit.settle()
    expect(quit.showMessageBox).toHaveBeenCalledOnce()
    expect(quit.attempts).toEqual([{ allowed: false, prevented: true }])
  })

  it('quits once the person confirms', async () => {
    const quit = quitConfirmation({ chatRuns: 2 }, 'close')
    quit.quit()
    await quit.settle()
    expect(quit.showMessageBox).toHaveBeenCalledOnce()
    expect(quit.attempts.at(-1)).toEqual({ allowed: true, prevented: false })
  })

  it('never asks when the system ends the app, even with work running', async () => {
    const quit = quitConfirmation({ chatRuns: 1, terminalCommand: true })
    quit.quitForSystem()
    await quit.settle()
    expect(quit.showMessageBox).not.toHaveBeenCalled()
    expect(quit.attempts).toEqual([{ allowed: true, prevented: false }])
  })

  it('lets a system quit through while the prompt is still open', async () => {
    const quit = quitConfirmation({ chatRuns: 1 })
    let answer: (value: { response: number }) => void = () => {}
    quit.showMessageBox.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    quit.quit()
    expect(quit.attempts).toEqual([{ allowed: false, prevented: true }])
    quit.quitForSystem()
    expect(quit.attempts.at(-1)).toEqual({ allowed: true, prevented: false })
    answer({ response: 0 })
    await quit.settle()
  })
})
