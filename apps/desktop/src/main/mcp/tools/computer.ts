import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { desktopCapturer, screen } from 'electron'
import { z } from 'zod'
import { conversationScreen, type ConversationScreen } from '../../conversation-screen'
import type { McpToolContext } from './context'
import { err, ok } from './context'

const keyPattern = /^[A-Za-z0-9_+ -]{1,64}$/
const coordinate = z.number().int().nonnegative()
const description =
  'Use for desktop apps outside the Maestrly browser. Prefer browser_* for websites. Coordinates are screen pixels from the last computer_screenshot.'
const screenshotTimeoutMs = 10_000
const screenshotMaxBytes = 32 * 1024 * 1024
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
let computerCommandsAvailable: boolean | null = null
const interrupted = 'interrupted: the owner took over / paused.'

/**
 * Screen actions are cancelled per screen. A conversation with a registered screen owns its actions. Conversations
 * without one share the primary display, so cancelling any of them cancels every action on that display. Cancelling
 * without a conversation cancels everything.
 */
export interface ScreenActionScope {
  conversationId: string | undefined
  /** The conversation's registered screen, or null for the primary display. */
  screen: ConversationScreen | null
  all: number
  conversation: number
  shared: number
}
interface RunningAction {
  conversationId: string | undefined
  shared: boolean
}
let allGeneration = 0
let sharedGeneration = 0
const conversationGenerations = new Map<string, number>()
const runningActions = new Map<ChildProcess, RunningAction>()

function screenScope(
  conversationId: string | undefined,
  registered: ConversationScreen | null = conversationScreen(conversationId)
): ScreenActionScope {
  return {
    conversationId,
    screen: registered,
    all: allGeneration,
    conversation: conversationId === undefined ? 0 : (conversationGenerations.get(conversationId) ?? 0),
    shared: sharedGeneration,
  }
}

function isInterrupted(scope: ScreenActionScope): boolean {
  return (
    scope.all !== allGeneration ||
    (scope.conversationId !== undefined &&
      scope.conversation !== (conversationGenerations.get(scope.conversationId) ?? 0)) ||
    (scope.screen === null && scope.shared !== sharedGeneration)
  )
}

function checkScreenAction(scope: ScreenActionScope): void {
  if (isInterrupted(scope)) throw new Error(interrupted)
}

function trackAction(child: ChildProcess, scope: ScreenActionScope): void {
  runningActions.set(child, { conversationId: scope.conversationId, shared: scope.screen === null })
}

/** Cancel the screen actions of one conversation's screen, or of every screen without a conversation. */
export function abortScreenActions(conversationId?: string): void {
  let affected: (action: RunningAction) => boolean
  if (conversationId === undefined) {
    allGeneration++
    affected = () => true
  } else {
    const shared = conversationScreen(conversationId) === null
    conversationGenerations.set(conversationId, (conversationGenerations.get(conversationId) ?? 0) + 1)
    if (shared) sharedGeneration++
    affected = (action) => action.conversationId === conversationId || (shared && action.shared)
  }
  for (const [child, action] of runningActions) {
    if (!affected(action)) continue
    child.kill('SIGTERM')
    const timer = setTimeout(() => {
      if (runningActions.has(child)) child.kill('SIGKILL')
    }, 250)
    timer.unref()
  }
}

function commandRuns(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, { timeout: 2_000, stdio: 'ignore' })
  return !result.error && result.status === 0
}

/** Desktop tools need xdotool for input and ImageMagick's import to capture a conversation's own display. */
export function canUseComputer(platform = process.platform, display = process.env.DISPLAY): boolean {
  if (platform !== 'linux' || !display) return false
  computerCommandsAvailable ??= commandRuns('xdotool', ['--version']) && commandRuns('import', ['-version'])
  return computerCommandsAvailable
}

function dimensions(registered: ConversationScreen | null): { width: number; height: number } {
  if (registered) return { width: registered.width, height: registered.height }
  const { width, height } = screen.getPrimaryDisplay().size
  if (width < 1 || height < 1) throw new Error('The primary screen has invalid dimensions.')
  return { width, height }
}

export function computerArguments(
  action: 'click' | 'move' | 'drag' | 'scroll' | 'type' | 'key',
  input: Record<string, unknown>,
  size: { width: number; height: number }
): string[][] {
  const point = (x: unknown, y: unknown): [string, string] => {
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      (x as number) < 0 ||
      (y as number) < 0 ||
      (x as number) >= size.width ||
      (y as number) >= size.height
    )
      throw new Error(`Coordinates must be integer screen pixels within 0..${size.width - 1}, 0..${size.height - 1}.`)
    return [String(x), String(y)]
  }
  if (action === 'move') return [['mousemove', '--sync', ...point(input.x, input.y)]]
  if (action === 'click') {
    const button = { left: '1', middle: '2', right: '3' }[String(input.button ?? 'left')]
    if (!button) throw new Error('Button must be left, middle, or right.')
    return [
      ['mousemove', '--sync', ...point(input.x, input.y)],
      ['click', ...(input.double ? ['--repeat', '2'] : []), button],
    ]
  }
  if (action === 'drag')
    return [
      ['mousemove', '--sync', ...point(input.fromX, input.fromY)],
      ['mousedown', '1'],
      ['mousemove', '--sync', ...point(input.toX, input.toY)],
      ['mouseup', '1'],
    ]
  if (action === 'scroll') {
    const direction = { up: '4', down: '5', left: '6', right: '7' }[String(input.direction)]
    const amount = input.amount ?? 1
    if (!direction || !Number.isInteger(amount) || (amount as number) < 1 || (amount as number) > 20)
      throw new Error('Scroll requires a direction and an amount from 1 to 20.')
    return [
      ['mousemove', '--sync', ...point(input.x, input.y)],
      ['click', '--repeat', String(amount), direction],
    ]
  }
  if (action === 'type') {
    if (typeof input.text !== 'string' || input.text.length < 1 || input.text.length > 4_000)
      throw new Error('Text must contain 1–4000 characters.')
    return Array.from({ length: Math.ceil(input.text.length / 200) }, (_, index) => [
      'type',
      '--delay',
      '12',
      '--',
      (input.text as string).slice(index * 200, (index + 1) * 200),
    ])
  }
  if (typeof input.keys !== 'string' || !keyPattern.test(input.keys) || !input.keys.trim())
    throw new Error(
      'Keys must use xdotool keysyms (letters, digits, underscore, plus, hyphen, or spaces; at most 64 characters).'
    )
  return [['key', '--clearmodifiers', '--', ...input.keys.trim().split(/ +/)]]
}

export async function runXdotool(
  args: string[],
  signal?: AbortSignal,
  scope: ScreenActionScope = screenScope(undefined)
): Promise<void> {
  checkScreenAction(scope)
  await new Promise<void>((resolve, reject) => {
    const child = spawn('xdotool', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      signal,
      // A conversation screen is its own X display; without one, xdotool uses the inherited DISPLAY.
      ...(scope.screen ? { env: { ...process.env, DISPLAY: scope.screen.display } } : {}),
    })
    trackAction(child, scope)
    let stderr = ''
    let processError: Error | null = null
    const timer = setTimeout(() => child.kill(), 5_000)
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString().slice(0, 300)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      processError = error
      if (child.pid === undefined) {
        runningActions.delete(child)
        reject(error)
      }
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      runningActions.delete(child)
      if (processError) reject(processError)
      else if (code === 0) resolve()
      else
        reject(
          new Error(
            code === null
              ? 'xdotool timed out or was interrupted.'
              : `xdotool exited with code ${code}: ${stderr.trim() || 'no details'}`
          )
        )
    })
  })
  checkScreenAction(scope)
}

/** Capture an X display as PNG with ImageMagick's import, bounded in time and size. */
async function captureDisplay(scope: ScreenActionScope, display: string, signal: AbortSignal): Promise<Buffer> {
  checkScreenAction(scope)
  const png = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn('import', ['-display', display, '-window', 'root', 'png:-'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    })
    trackAction(child, scope)
    const chunks: Buffer[] = []
    let bytes = 0
    let stderr = ''
    let failure: Error | null = null
    const stop = (error: Error): void => {
      failure ??= error
      // Capturing has no durable state to flush; the limit must also stop an unresponsive helper.
      child.kill('SIGKILL')
    }
    const timer = setTimeout(
      () => stop(new Error('The screen capture timed out after 10 seconds.')),
      screenshotTimeoutMs
    )
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure) return
      bytes += chunk.length
      if (bytes > screenshotMaxBytes) {
        chunks.length = 0
        stop(new Error('The screen capture exceeded 32 MiB.'))
      } else chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 300) stderr += chunk.toString().slice(0, 300 - stderr.length)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      failure ??= error
      if (child.pid === undefined) {
        runningActions.delete(child)
        reject(error)
      }
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      runningActions.delete(child)
      if (failure) reject(failure)
      else if (code === 0) resolve(Buffer.concat(chunks))
      else
        reject(
          new Error(
            code === null
              ? 'import was interrupted.'
              : `import exited with code ${code}: ${stderr.trim() || 'no details'}`
          )
        )
    })
  })
  checkScreenAction(scope)
  return png
}

function screenshotResult(png: Buffer, width: number, height: number) {
  return {
    content: [
      { type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' },
      {
        type: 'text' as const,
        text: `Screen: ${width} × ${height} pixels. Coordinates for computer_* are screen pixels from this screenshot.`,
      },
    ],
  }
}

export function registerComputerTools(ctx: McpToolContext): void {
  const { server } = ctx
  server.registerTool(
    'computer_screenshot',
    {
      description: `Capture the whole desktop screen as PNG. ${description}`,
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async (_args, extra) => {
      const scope = screenScope(ctx.convId)
      try {
        const { width, height } = dimensions(scope.screen)
        if (scope.screen) {
          const png = await captureDisplay(scope, scope.screen.display, extra.signal)
          if (png.length <= pngSignature.length || !png.subarray(0, pngSignature.length).equals(pngSignature))
            return err('Could not capture the screen: import returned no PNG image.')
          return screenshotResult(png, width, height)
        }
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } })
        const source =
          sources.find((candidate) => candidate.display_id === String(screen.getPrimaryDisplay().id)) ?? sources[0]
        if (!source || source.thumbnail.isEmpty())
          return err('Could not capture the primary screen. Check DISPLAY and screen permissions.')
        return screenshotResult(source.thumbnail.toPNG(), width, height)
      } catch (error) {
        return err(
          `Screen capture failed: ${isInterrupted(scope) ? interrupted : error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  )

  const action = <T extends Record<string, unknown>>(
    name: 'click' | 'move' | 'drag' | 'scroll' | 'type' | 'key',
    schema: Record<string, z.ZodType>,
    summary: string
  ): void => {
    server.registerTool(
      `computer_${name}`,
      {
        description: `${summary} ${description}`,
        inputSchema: schema,
        annotations: { readOnlyHint: false },
      },
      async (args, extra) => {
        let buttonDown = false
        const scope = screenScope(ctx.convId)
        try {
          const commands = computerArguments(name, args as T, dimensions(scope.screen))
          const signal = AbortSignal.any([extra.signal, AbortSignal.timeout(5_000)])
          for (const command of commands) {
            checkScreenAction(scope)
            if (command[0] === 'mousedown') buttonDown = true
            await runXdotool(command, signal, scope)
            if (command[0] === 'mouseup') buttonDown = false
          }
          await new Promise((resolve) => setTimeout(resolve, 150))
          checkScreenAction(scope)
          return ok(`Desktop ${name} completed.`)
        } catch (error) {
          if (buttonDown)
            await runXdotool(['mouseup', '1'], undefined, screenScope(scope.conversationId, scope.screen)).catch(
              () => undefined
            )
          return err(
            `Desktop ${name} failed: ${isInterrupted(scope) ? interrupted : error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    )
  }
  action(
    'click',
    {
      x: coordinate,
      y: coordinate,
      button: z.enum(['left', 'right', 'middle']).optional(),
      double: z.boolean().optional(),
    },
    'Click the desktop at a screen coordinate.'
  )
  action('move', { x: coordinate, y: coordinate }, 'Move the desktop pointer.')
  action(
    'drag',
    { fromX: coordinate, fromY: coordinate, toX: coordinate, toY: coordinate },
    'Drag with the left mouse button.'
  )
  action(
    'scroll',
    {
      x: coordinate,
      y: coordinate,
      direction: z.enum(['up', 'down', 'left', 'right']),
      amount: z.number().int().min(1).max(20).optional(),
    },
    'Scroll the desktop.'
  )
  action('type', { text: z.string().min(1).max(4_000) }, 'Type text into the focused desktop app.')
  action('key', { keys: z.string().regex(keyPattern) }, 'Press xdotool keysyms such as ctrl+s or Return.')
}
